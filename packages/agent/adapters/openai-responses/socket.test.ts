import { afterEach, expect, test, spyOn } from "bun:test";
import { Panic } from "better-result";
import { WebSocket as NodeWebSocket } from "ws";
import type { AgentAdapterFailure } from "../../agent-adapter";
import { createOpenAIResponsesConnect } from "./socket";
import type { ResponsesDiagnostics, ResponsesDiagnosticFields } from "./diagnostics";

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

function recordDiagnostics() {
  const logs: Array<{ event: string; fields?: ResponsesDiagnosticFields; level?: string }> = [];
  const wires: Array<{
    event: string;
    payload: object | string;
    fields?: ResponsesDiagnosticFields;
  }> = [];
  const closed = Promise.withResolvers<void>();
  const diagnostics: ResponsesDiagnostics = {
    withContext: () => diagnostics,
    log(event, fields, level) {
      logs.push({ event, fields, level });
      if (event === "socket.close") closed.resolve();
    },
    wire: (event, payload, fields) => {
      wires.push({ event, payload, fields });
    },
    flush: async () => {},
  };
  return { diagnostics, logs, wires, closed };
}

test("SDK diagnostics capture requests and raw provider events without token payloads in operational logs", async () => {
  const recording = recordDiagnostics();
  const incoming = {
    type: "response.output_text.delta",
    delta: "private generated text",
    item_id: "m",
    output_index: 0,
    content_index: 0,
    sequence_number: 1,
    logprobs: [],
  };
  const harness = serve((ws) => {
    ws.send(JSON.stringify(incoming));
  });
  const socket = (
    await harness.connect(new AbortController().signal, recording.diagnostics)
  ).unwrap();
  const request = {
    type: "response.create",
    model: "gpt-6-astra",
    input: "private prompt",
    previous_response_id: "prior",
  } as const;
  socket.send(request).unwrap();
  expect((await socket.events[Symbol.asyncIterator]().next()).value?.unwrap()).toEqual(incoming);
  expect(recording.wires).toEqual([
    { event: "websocket.send", payload: request, fields: { eventType: "response.create" } },
    { event: "websocket.receive", payload: incoming, fields: { eventType: incoming.type } },
  ]);
  expect(recording.logs.map((entry) => entry.event)).toEqual([
    "socket.connecting",
    "socket.open",
    "socket.send",
  ]);
  expect(JSON.stringify(recording.logs)).not.toContain("private");
  expect(
    recording.logs.find((entry) => entry.event === "socket.open")?.fields?.elapsedMs,
  ).toBeGreaterThanOrEqual(0);
  socket.close();
  await recording.closed.promise;
  expect(recording.logs.find((entry) => entry.event === "socket.close")?.fields).toEqual({
    closeCode: 1000,
    closeReason: "OK",
    unsentCount: 0,
    intentional: true,
  });
});

test("server closes preserve close code reason and unsent count in diagnostics", async () => {
  const recording = recordDiagnostics();
  const harness = serve((ws) => {
    ws.close(1011, "backend unavailable");
  });
  const socket = (
    await harness.connect(new AbortController().signal, recording.diagnostics)
  ).unwrap();
  socket.send({ type: "response.create", input: [] }).unwrap();
  expect((await socket.events[Symbol.asyncIterator]().next()).value?.isErr()).toBe(true);
  await recording.closed.promise;
  expect(recording.logs.find((entry) => entry.event === "socket.close")?.fields).toEqual({
    closeCode: 1011,
    closeReason: "backend unavailable",
    unsentCount: 0,
    intentional: false,
  });
  socket.close();
});

test("malformed frames are traced and retain reconciliation failure", async () => {
  const recording = recordDiagnostics();
  const harness = serve((ws) => {
    ws.send("invalid JSON");
  });
  const socket = (
    await harness.connect(new AbortController().signal, recording.diagnostics)
  ).unwrap();
  socket.send({ type: "response.create", input: [] }).unwrap();
  expect((await socket.events[Symbol.asyncIterator]().next()).value?.isErr()).toBe(true);
  expect(recording.wires.find((entry) => entry.event === "websocket.invalid_frame")?.payload).toBe(
    "invalid JSON",
  );
  expect(recording.logs).toContainEqual({
    event: "socket.invalid_frame",
    fields: {},
    level: "warn",
  });
  socket.close();
});

test("SDK server error diagnostics keep the unmodified provider event in the wire trace", async () => {
  const recording = recordDiagnostics();
  const error = {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "bad_request",
      message: "backend rejected api_key=secret",
      param: null,
    },
  };
  const harness = serve((ws) => {
    ws.send(JSON.stringify(error));
  });
  const socket = (
    await harness.connect(new AbortController().signal, recording.diagnostics)
  ).unwrap();
  socket.send({ type: "response.create", input: [] }).unwrap();
  expect((await socket.events[Symbol.asyncIterator]().next()).value?.unwrap()).toEqual(error);
  expect(recording.wires.find((entry) => entry.event === "websocket.receive")?.payload).toEqual(
    error,
  );
  expect(recording.logs).toContainEqual({
    event: "socket.error",
    fields: {
      serverError: true,
      errorTag: "Error",
      errorMessage: "backend rejected api_key=<redacted>",
    },
    level: "warn",
  });

  socket.close();
});

for (const point of [
  "websocket.receive",
  "websocket.invalid_frame",
  "socket.error",
  "socket.close",
]) {
  test(`diagnostic Panic from ${point} reaches the owned SDK reader`, async () => {
    const defect = new Panic({ message: `diagnostic defect: ${point}` });
    const recording = recordDiagnostics();
    const diagnostics: ResponsesDiagnostics = {
      ...recording.diagnostics,
      log(event, fields, level) {
        recording.diagnostics.log(event, fields, level);
        if (event === point) throw defect;
      },
      wire(event, payload, fields) {
        if (event === point) throw defect;
        recording.diagnostics.wire(event, payload, fields);
      },
    };
    const harness = serve((ws) => {
      if (point === "socket.close") {
        ws.close(1011, "backend failure");
        return;
      }
      if (point === "websocket.invalid_frame") {
        ws.send("invalid JSON");
        return;
      }
      if (point === "socket.error") {
        ws.send(
          JSON.stringify({
            type: "error",
            error: { message: "failed", type: "server_error", code: "failed", param: null },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "text",
          item_id: "m",
          output_index: 0,
          content_index: 0,
          sequence_number: 0,
          logprobs: [],
        }),
      );
    });
    const socket = (await harness.connect(new AbortController().signal, diagnostics)).unwrap();
    socket.send({ type: "response.create", input: [] }).unwrap();
    await expect(socket.events[Symbol.asyncIterator]().next()).rejects.toBe(defect);
    socket.close();
    await harness.closed.promise;
  });
}

test("closing diagnostic Panic cannot prevent SDK cleanup", async () => {
  const defect = new Panic({ message: "closing diagnostics failed" });
  const recording = recordDiagnostics();
  const diagnostics: ResponsesDiagnostics = {
    ...recording.diagnostics,
    log(event, fields, level) {
      if (event === "socket.closing") throw defect;
      recording.diagnostics.log(event, fields, level);
    },
  };
  const harness = serve(() => {});
  const socket = (await harness.connect(new AbortController().signal, diagnostics)).unwrap();
  expect(() => socket.close()).toThrow(defect);
  await harness.closed.promise;
  expect(socket.isOpen?.()).toBe(false);
  socket.close();
});

test("native close Panic wins over closing diagnostic Panic and still closes the socket", async () => {
  const native = new Panic({ message: "native close defect" });
  const diagnostic = new Panic({ message: "closing diagnostics failed" });
  const recording = recordDiagnostics();
  const diagnostics: ResponsesDiagnostics = {
    ...recording.diagnostics,
    log(event) {
      if (event === "socket.closing") throw diagnostic;
    },
  };
  const harness = serve(() => {});
  const socket = (await harness.connect(new AbortController().signal, diagnostics)).unwrap();
  const originalClose = NodeWebSocket.prototype.close;
  const close = spyOn(NodeWebSocket.prototype, "close").mockImplementation(
    function (this: NodeWebSocket, code, reason) {
      originalClose.call(this, code, reason);
      throw native;
    },
  );
  try {
    expect(() => socket.close()).toThrow(native);
  } finally {
    close.mockRestore();
  }
  await harness.closed.promise;
});

test("opening diagnostic Panic closes the newly connected SDK socket", async () => {
  const defect = new Panic({ message: "open diagnostic failed" });
  const recording = recordDiagnostics();
  const diagnostics: ResponsesDiagnostics = {
    ...recording.diagnostics,
    log(event) {
      if (event === "socket.open") throw defect;
    },
  };
  const harness = serve(() => {});
  await expect(harness.connect(new AbortController().signal, diagnostics)).rejects.toBe(defect);
  await harness.closed.promise;
});
