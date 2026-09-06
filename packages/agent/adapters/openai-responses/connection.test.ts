import { expect, test } from "bun:test";
import { Panic, Result } from "better-result";
import type { ResponsesServerEvent } from "openai/resources/responses/responses";
import type { OpenAIResponsesConnectionOptions } from "@stanley2058/lilac-utils/openai-responses-connection";
import { AgentAdapterFailure } from "../../agent-adapter";
import { createOpenAIResponsesConnectionPool } from "./connection";
import type { OpenAIResponsesSocket } from "./socket";

const settings: OpenAIResponsesConnectionOptions = {
  baseUrl: "https://example.com/v1",
  requestUrl: new URL("https://example.com/v1/responses"),
  websocketUrl: "wss://example.com/v1/responses",
  headers: { Authorization: "Bearer test" },
  mode: "websocket",
};
const signal = () => new AbortController().signal;
const delta = (text: string): ResponsesServerEvent => ({
  type: "response.output_text.delta",
  delta: text,
  item_id: "message",
  output_index: 0,
  content_index: 0,
  sequence_number: 0,
  logprobs: [],
});

function fakeSocket() {
  type Event = Awaited<
    ReturnType<ReturnType<OpenAIResponsesSocket["events"][typeof Symbol.asyncIterator]>["next"]>
  >;
  const reads: Array<ReturnType<typeof Promise.withResolvers<Event>>> = [];
  let open = true;
  let closes = 0;
  let returns = 0;
  const socket: OpenAIResponsesSocket = {
    isOpen: () => open,
    events: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            const pending = Promise.withResolvers<Event>();
            reads.push(pending);
            return pending.promise;
          },
          return: async () => {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    },
    send: () => Result.ok(undefined),
    close() {
      closes++;
      open = false;
      for (const pending of reads.splice(0)) pending.resolve({ done: true, value: undefined });
    },
  };
  return {
    socket,
    emit(event: ResponsesServerEvent) {
      const next = reads.shift();
      expect(next).toBeDefined();
      next!.resolve({ done: false, value: Result.ok(event) });
    },
    fail(cause: Error) {
      const next = reads.shift();
      expect(next).toBeDefined();
      next!.reject(cause);
    },
    disconnect: () => {
      open = false;
    },
    get closes() {
      return closes;
    },
    get returns() {
      return returns;
    },
  };
}

function harness(idleTimeoutMs?: number) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const timers: Array<{ callback: () => void; milliseconds: number; canceled: boolean }> = [];
  const pool = createOpenAIResponsesConnectionPool({
    idleTimeoutMs,
    connect: () => async () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return Result.ok(socket.socket);
    },
    scheduleIdleClose(callback, milliseconds) {
      const timer = { callback, milliseconds, canceled: false };
      timers.push(timer);
      return () => {
        timer.canceled = true;
      };
    },
  });
  return { pool, sockets, timers };
}

test("clean leases reuse the SDK connection and preserve the stream after a consumer returns", async () => {
  const { pool, sockets, timers } = harness();
  const first = (await pool.connect(settings, signal())).unwrap();
  const reader = first.events[Symbol.asyncIterator]();
  const pending = reader.next();
  await reader.return?.();
  first.release({ reusable: true });
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(timers[0]?.milliseconds).toBe(30_000);
  const second = (await pool.connect(settings, signal())).unwrap();
  expect(second.connectionId).toBe(first.connectionId);
  expect(sockets).toHaveLength(1);
  expect(sockets[0]?.returns).toBe(0);
  expect(timers[0]?.canceled).toBe(true);
  const next = second.events[Symbol.asyncIterator]().next();
  sockets[0]!.emit(delta("second"));
  expect((await next).value?.unwrap()).toEqual(delta("second"));
  expect(first.send({ type: "response.create", input: [] }).isErr()).toBe(true);
  second.release({ reusable: true });
  pool.close();
  expect(sockets[0]?.closes).toBe(1);
});

test("concurrent executions get dedicated sockets that close even after a clean release", async () => {
  const { pool, sockets } = harness();
  const first = (await pool.connect(settings, signal())).unwrap();
  const dedicated = (await pool.connect(settings, signal())).unwrap();
  expect(first.reusable).toBe(true);
  expect(dedicated.reusable).toBe(false);
  dedicated.release({ reusable: true });
  expect(sockets[1]?.closes).toBe(1);
  first.release({ reusable: true });
  expect((await pool.connect(settings, signal())).unwrap().connectionId).toBe(first.connectionId);
  pool.close();
});

test("the reusable slot is reserved throughout the handshake", async () => {
  const first = Promise.withResolvers<ReturnType<typeof Result.ok<OpenAIResponsesSocket>>>();
  const sockets = [fakeSocket(), fakeSocket()];
  let calls = 0;
  const pool = createOpenAIResponsesConnectionPool({
    connect: () => async () => (++calls === 1 ? first.promise : Result.ok(sockets[1]!.socket)),
  });
  const pending = pool.connect(settings, signal());
  const second = (await pool.connect(settings, signal())).unwrap();
  expect(second.reusable).toBe(false);
  first.resolve(Result.ok(sockets[0]!.socket));
  expect((await pending).unwrap().reusable).toBe(true);
  second.release({ reusable: true });
  pool.close();
});

for (const changed of [
  { ...settings, headers: { Authorization: "Bearer changed" } },
  { ...settings, websocketUrl: "wss://example.com/other/responses" },
]) {
  test("endpoint or credential changes invalidate the idle connection", async () => {
    const { pool, sockets } = harness();
    const first = (await pool.connect(settings, signal())).unwrap();
    first.release({ reusable: true });
    const next = (await pool.connect(changed, signal())).unwrap();
    expect(next.connectionId).not.toBe(first.connectionId);
    expect(sockets[0]?.closes).toBe(1);
    pool.close();
  });
}

test("header casing and insertion order do not split reuse", async () => {
  const { pool } = harness();
  const first = (
    await pool.connect(
      { ...settings, headers: { Authorization: "Bearer test", "X-Test": "yes" } },
      signal(),
    )
  ).unwrap();
  first.release({ reusable: true });
  const next = (
    await pool.connect(
      { ...settings, headers: { "x-test": "yes", authorization: "Bearer test" } },
      signal(),
    )
  ).unwrap();
  expect(next.connectionId).toBe(first.connectionId);
  pool.close();
});

test("idle expiry and closed sockets require new connections", async () => {
  const { pool, sockets, timers } = harness();
  const first = (await pool.connect(settings, signal())).unwrap();
  first.release({ reusable: true });
  timers[0]!.callback();
  expect(sockets[0]?.closes).toBe(1);
  const second = (await pool.connect(settings, signal())).unwrap();
  second.release({ reusable: true });
  sockets[1]!.disconnect();
  const third = (await pool.connect(settings, signal())).unwrap();
  expect(third.connectionId).not.toBe(second.connectionId);
  expect(sockets).toHaveLength(3);
  pool.close();
});

test("zero idle timeout closes clean releases immediately", async () => {
  const { pool, sockets, timers } = harness(0);
  (await pool.connect(settings, signal())).unwrap().release({ reusable: true });
  expect(sockets[0]?.closes).toBe(1);
  expect(timers).toHaveLength(0);
  pool.close();
});

test("failed and canceled executions invalidate the connection with idempotent release", async () => {
  const { pool, sockets } = harness();
  const first = (await pool.connect(settings, signal())).unwrap();
  first.release({ reusable: false });
  first.close();
  expect(sockets[0]?.closes).toBe(1);
  const next = (await pool.connect(settings, signal())).unwrap();
  expect(next.connectionId).not.toBe(first.connectionId);
  pool.close();
});

test("transport failure cannot be returned as a reusable connection", async () => {
  const { pool, sockets } = harness();
  const first = (await pool.connect(settings, signal())).unwrap();
  const reader = first.events[Symbol.asyncIterator]();
  const pending = reader.next();
  sockets[0]!.fail(new Error("connection lost"));
  expect(
    (await pending).value?.match({
      ok: () => undefined,
      err: (failure: AgentAdapterFailure) => failure.replaySafety,
    }),
  ).toBe("reconcile");
  expect((await reader.next()).done).toBe(true);
  first.release({ reusable: true });
  expect(sockets[0]?.closes).toBe(1);
  expect((await pool.connect(settings, signal())).unwrap().connectionId).not.toBe(
    first.connectionId,
  );
  pool.close();
});

test("Panic from the upstream iterator keeps its identity", async () => {
  const { pool, sockets } = harness();
  const first = (await pool.connect(settings, signal())).unwrap();
  const pending = first.events[Symbol.asyncIterator]().next();
  const panic = new Panic({ message: "defect", cause: new Error("defect") });
  sockets[0]!.fail(panic);
  await expect(pending).rejects.toBe(panic);
  first.release({ reusable: true });
  pool.close();
});

test("aborting a handshake releases the reusable slot", async () => {
  const controller = new AbortController();
  const ready = Promise.withResolvers<void>();
  let calls = 0;
  const second = fakeSocket();
  const pool = createOpenAIResponsesConnectionPool({
    connect: () => async (signal) => {
      calls++;
      if (calls > 1) return Result.ok(second.socket);
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () =>
            resolve(
              Result.err(
                new AgentAdapterFailure({
                  reason: "unavailable",
                  message: "aborted",
                  replaySafety: "safe",
                }),
              ),
            ),
          { once: true },
        );
        ready.resolve();
      });
    },
  });
  const pending = pool.connect(settings, controller.signal);
  await ready.promise;
  controller.abort();
  expect(
    (await pending).match({
      ok: () => undefined,
      err: (failure: AgentAdapterFailure) => failure.replaySafety,
    }),
  ).toBe("safe");
  expect((await pool.connect(settings, signal())).unwrap().reusable).toBe(true);
  pool.close();
});

test("pool closure aborts in-flight handshakes and closes a late successful socket", async () => {
  const ready = Promise.withResolvers<AbortSignal>();
  const opened = Promise.withResolvers<ReturnType<typeof Result.ok<OpenAIResponsesSocket>>>();
  const socket = fakeSocket();
  const pool = createOpenAIResponsesConnectionPool({
    connect: () => async (signal) => {
      ready.resolve(signal);
      return opened.promise;
    },
  });
  const pending = pool.connect(settings, signal());
  const handshakeSignal = await ready.promise;
  pool.close();
  expect(handshakeSignal.aborted).toBe(true);
  opened.resolve(Result.ok(socket.socket));
  expect(
    (await pending).match({
      ok: () => undefined,
      err: (failure: AgentAdapterFailure) => failure.replaySafety,
    }),
  ).toBe("safe");
  expect(socket.closes).toBe(1);
  expect((await pool.connect(settings, signal())).isErr()).toBe(true);
});

test("official SDK socket remains usable across separate leases", async () => {
  let connections = 0;
  let requests = 0;
  const server = Bun.serve<undefined>({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: undefined })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open() {
        connections++;
      },
      message(socket) {
        socket.send(JSON.stringify(delta(String(++requests))));
      },
    },
  });
  const baseUrl = `http://localhost:${server.port}/v1`;
  const options: OpenAIResponsesConnectionOptions = {
    ...settings,
    baseUrl,
    requestUrl: new URL(`${baseUrl}/responses`),
    websocketUrl: `ws://localhost:${server.port}/v1/responses`,
  };
  const pool = createOpenAIResponsesConnectionPool();
  try {
    const first = (await pool.connect(options, signal())).unwrap();
    const firstEvents = first.events[Symbol.asyncIterator]();
    first.send({ type: "response.create", input: [] }).unwrap();
    expect((await firstEvents.next()).value?.unwrap()).toEqual(delta("1"));
    await firstEvents.return?.();
    first.release({ reusable: true });
    const second = (await pool.connect(options, signal())).unwrap();
    second.send({ type: "response.create", input: [] }).unwrap();
    expect((await second.events[Symbol.asyncIterator]().next()).value?.unwrap()).toEqual(
      delta("2"),
    );
    expect(connections).toBe(1);
    expect(second.connectionId).toBe(first.connectionId);
    second.release({ reusable: true });
  } finally {
    pool.close();
    server.stop(true);
  }
});
