import { afterEach, expect, test, spyOn } from "bun:test";
import { Panic } from "better-result";
import { WebSocket as NodeWebSocket } from "ws";
import type { AgentAdapterFailure } from "../../agent-adapter";
import { createOpenAIResponsesConnect } from "./socket";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (ws: Bun.ServerWebSocket<undefined>, message: string | Buffer) => void) {
  const headers = Promise.withResolvers<Headers>();
  const closed = Promise.withResolvers<void>();
  const server = Bun.serve<undefined>({
    port: 0,
    fetch(request, server) {
      headers.resolve(request.headers);
      if (server.upgrade(request, { data: undefined })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message: handler,
      close() {
        closed.resolve();
      },
    },
  });
  servers.push(server);
  const baseUrl = `http://localhost:${server.port}/v1`;
  return {
    headers,
    closed,
    connect: createOpenAIResponsesConnect({
      baseUrl,
      requestUrl: new URL(`${baseUrl}/responses`),
      websocketUrl: `ws://localhost:${server.port}/v1/responses`,
      headers: { Authorization: "Bearer test", "x-codex-beta-features": "existing" },
      mode: "websocket",
    }),
  };
}

test("official SDK sends typed requests and delivers parsed events with authentication and feature headers", async () => {
  const received = Promise.withResolvers<object>();
  const harness = serve((ws, message) => {
    received.resolve(JSON.parse(String(message)));
    ws.send(
      JSON.stringify({
        type: "response.output_text.delta",
        delta: "hi",
        item_id: "m1",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
        logprobs: [],
      }),
    );
  });
  const socket = (await harness.connect(new AbortController().signal)).unwrap();
  expect(socket.send({ type: "response.create", model: "gpt-6-astra", input: [] }).isOk()).toBe(
    true,
  );
  expect(await received.promise).toEqual({
    type: "response.create",
    model: "gpt-6-astra",
    input: [],
  });
  const headers = await harness.headers.promise;
  expect(headers.get("authorization")).toBe("Bearer test");
  expect(headers.get("x-codex-beta-features")).toBe("existing,remote_compaction_v2");
  expect(headers.get("openai-beta")).toBe("responses_websockets=2026-02-06");
  const events = socket.events[Symbol.asyncIterator]();
  expect((await events.next()).value?.unwrap()).toMatchObject({
    type: "response.output_text.delta",
    delta: "hi",
  });
  socket.close();
  socket.close();
  await harness.closed.promise;
  expect((await events.next()).done).toBe(true);
});

for (const frame of ["", "null", "[]", "[{}]", '"keepalive"', "42", "true", "false"]) {
  test(`empty or valid non-object JSON frame is ignored before the next SDK event: ${JSON.stringify(frame)}`, async () => {
    const event = {
      type: "response.output_text.delta",
      delta: "after ignored frame",
      item_id: "m1",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
      logprobs: [],
    };
    const harness = serve((ws) => {
      ws.send(frame);
      ws.send(JSON.stringify(event));
    });
    const socket = (await harness.connect(new AbortController().signal)).unwrap();
    socket.send({ type: "response.create", input: [] }).unwrap();
    expect((await socket.events[Symbol.asyncIterator]().next()).value?.unwrap()).toEqual(event);
    expect(socket.isOpen?.()).toBe(true);
    socket.close();
    await harness.closed.promise;
  });
}

test("binary UTF8 JSON frames decode into SDK events after ignored empty and scalar binary frames", async () => {
  const event = {
    type: "response.output_text.delta",
    delta: "你好",
    item_id: "m1",
    output_index: 0,
    content_index: 0,
    sequence_number: 1,
    logprobs: [],
  };
  const harness = serve((ws) => {
    const encode = (text: string) => new TextEncoder().encode(text);
    ws.send(new Uint8Array());
    ws.send(encode("null"));
    ws.send(encode("[]"));
    ws.send(encode(JSON.stringify(event)));
  });
  const socket = (await harness.connect(new AbortController().signal)).unwrap();
  socket.send({ type: "response.create", input: [] }).unwrap();
  expect((await socket.events[Symbol.asyncIterator]().next()).value?.unwrap()).toEqual(event);
  expect(socket.isOpen?.()).toBe(true);
  socket.close();
  await harness.closed.promise;
});

for (const frame of ["invalid JSON", new Uint8Array([1])]) {
  test(`invalid protocol frame terminates typed events and disposal closes SDK socket: ${typeof frame}`, async () => {
    const harness = serve((ws) => {
      ws.send(frame);
    });
    const socket = (await harness.connect(new AbortController().signal)).unwrap();
    socket.send({ type: "response.create", input: [] });
    const events = socket.events[Symbol.asyncIterator]();
    expect(
      (await events.next()).value?.match({
        ok: () => undefined,
        err: (error: AgentAdapterFailure) => error.replaySafety,
      }),
    ).toBe("reconcile");
    socket.close();
    await harness.closed.promise;
    expect((await events.next()).done).toBe(true);
  });
}

test("server error payload remains available to adapter projection", async () => {
  const harness = serve((ws) => {
    ws.send(
      JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "bad_request",
          message: "invalid",
          param: null,
        },
      }),
    );
  });
  const socket = (await harness.connect(new AbortController().signal)).unwrap();
  socket.send({ type: "response.create", input: [] });
  const events = socket.events[Symbol.asyncIterator]();
  expect((await events.next()).value?.unwrap()).toMatchObject({
    type: "error",
    error: { message: "invalid" },
  });
  socket.close();
});

test("aborted connection is safe before any SDK submission", async () => {
  const harness = serve(() => {});
  const controller = new AbortController();
  controller.abort();
  expect(
    (await harness.connect(controller.signal)).match({
      ok: () => undefined,
      err: (error: AgentAdapterFailure) => error.replaySafety,
    }),
  ).toBe("safe");
});

test("a rejected handshake is safe for fallback", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(null, { status: 403 });
    },
  });
  servers.push(server);
  const baseUrl = `http://localhost:${server.port}/v1`;
  const connect = createOpenAIResponsesConnect({
    baseUrl,
    requestUrl: new URL(`${baseUrl}/responses`),
    websocketUrl: `ws://localhost:${server.port}/v1/responses`,
    headers: {},
    mode: "auto",
  });
  expect(
    (await connect(new AbortController().signal)).match({
      ok: () => undefined,
      err: (error: AgentAdapterFailure) => error.replaySafety,
    }),
  ).toBe("safe");
});

test("cancellation during handshake settles without submitting a response", async () => {
  const reached = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<Response>();
  const server = Bun.serve({
    port: 0,
    fetch() {
      reached.resolve();
      return respond.promise;
    },
  });
  servers.push(server);
  const baseUrl = `http://localhost:${server.port}/v1`;
  const connect = createOpenAIResponsesConnect({
    baseUrl,
    requestUrl: new URL(`${baseUrl}/responses`),
    websocketUrl: `ws://localhost:${server.port}/v1/responses`,
    headers: { Authorization: "Bearer test" },
    mode: "auto",
  });
  const controller = new AbortController();
  const opening = connect(controller.signal);
  await reached.promise;
  controller.abort();
  expect((await opening).match({ ok: () => undefined, err: (error) => error.replaySafety })).toBe(
    "safe",
  );
  respond.resolve(new Response(null, { status: 403 }));
});

for (const defect of [new Error("transport failure"), new Panic({ message: "transport defect" })]) {
  test(`SDK send error preserves ${defect.name} identity`, async () => {
    const harness = serve(() => {});
    const socket = (await harness.connect(new AbortController().signal)).unwrap();
    const send = spyOn(NodeWebSocket.prototype, "send").mockImplementation(() => {
      throw defect;
    });
    if (Panic.is(defect)) {
      expect(() => socket.send({ type: "response.create", input: [] })).toThrow(defect);
    } else {
      const sent = socket.send({ type: "response.create", input: [] });
      expect(sent.match({ ok: () => undefined, err: (error) => error.cause })).toBe(defect);
    }
    send.mockRestore();
    socket.close();
    await harness.closed.promise;
  });

  test(`SDK close error preserves ${defect.name} identity`, async () => {
    const harness = serve(() => {});
    const socket = (await harness.connect(new AbortController().signal)).unwrap();
    const originalClose = NodeWebSocket.prototype.close;
    const close = spyOn(NodeWebSocket.prototype, "close").mockImplementation(
      function (this: NodeWebSocket, code, reason) {
        originalClose.call(this, code, reason);
        throw defect;
      },
    );
    expect(() => socket.close()).toThrow(defect);
    close.mockRestore();
    socket.close();
    await harness.closed.promise;
  });
}
