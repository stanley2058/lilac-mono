import { afterEach, expect, spyOn, test } from "bun:test";
import { implement, EventPublisher } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as SocketHandler } from "@orpc/server/bun-ws";
import {
  nativeContract,
  type BootstrapReply,
  type NativeTransport,
  type CatalogEvent,
  type ThreadEvent,
} from "@stanley2058/lilac-client-protocol";
import { NativeClient, createNativeHttpRPC } from "../src/index";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 1,
  cursor: "cursor",
};
const initial: BootstrapReply = {
  installationId: "test",
  viewer: { id: "owner", displayName: "Owner", role: "owner", toolMode: "full" },
  threads: { items: [] },
  catalogCursor: "catalog",
  catalog: {
    kind: "catalog",
    catalog: { revision: "catalog", models: [], skills: [], commands: [] },
  },
  selectedThread: { kind: "window", checkpoint, slots: [] },
};
function fixture(transport: NativeTransport, rejectSocket = false, openSocket?: () => WebSocket) {
  let policy = transport;
  let sockets = 0;
  let httpCalls = 0;
  let accepted = 0;
  let bootstraps = 0;
  let reauthentications = 0;
  let token = "initial-test-token";
  const watchTokens: string[] = [];
  let subscriptions = new AbortController();
  let threadReady = Promise.withResolvers<void>();
  let catalogReady = Promise.withResolvers<void>();
  const publisher = new EventPublisher<{ catalog: CatalogEvent; thread: ThreadEvent }>();
  const watched = Promise.withResolvers<void>();
  const canceled = Promise.withResolvers<void>();
  const checkpoints: unknown[] = [];
  const api = implement(nativeContract);
  const router = {
    connection: {
      reauthenticate: api.connection.reauthenticate.handler(() => {
        reauthentications++;
        return initial.viewer;
      }),
    },
    streams: {
      watch: api.streams.watch.handler(async function* ({ input, signal }) {
        checkpoints.push(input.checkpoint);
        yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
        watched.resolve();
        threadReady.resolve();
        try {
          yield* publisher.subscribe("thread", {
            signal: AbortSignal.any([subscriptions.signal, ...(signal ? [signal] : [])]),
          });
        } finally {
          canceled.resolve();
        }
      }),
    },
    bootstrap: {
      watch: api.bootstrap.watch.handler(async function* ({ signal }) {
        catalogReady.resolve();
        yield* publisher.subscribe("catalog", {
          signal: AbortSignal.any([subscriptions.signal, ...(signal ? [signal] : [])]),
        });
      }),
    },
    inputs: {
      submit: api.inputs.submit.handler(() => {
        accepted++;
        return {
          inputId: "input",
          messageId: "message",
          state: "admitted" as const,
          turnId: "turn",
        };
      }),
    },
  };
  const http = new RPCHandler(router);
  const socket = new SocketHandler(router);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname === "/socket") {
        sockets++;
        if (!rejectSocket && server.upgrade(request)) return;
        return new Response(null, { status: 426 });
      }
      httpCalls++;
      if (new URL(request.url).pathname.endsWith("/watch"))
        watchTokens.push(request.headers.get("authorization") ?? "");
      return (await http.handle(request)).response ?? new Response(null, { status: 404 });
    },
    websocket: {
      message: (peer, message) => socket.message(peer, message),
      close: (peer) => socket.close(peer),
    },
  });
  cleanups.push(() => server.stop(true));
  const client = new NativeClient({
    scope: {
      installationId: "test",
      principalId: "owner",
      protocolVersion: 1,
      projectionVersion: 1,
    },
    transport,
    openSocket: openSocket ?? (() => new WebSocket(`ws://127.0.0.1:${server.port}/socket`)),
    openHttp: () =>
      createNativeHttpRPC({
        url: server.url,
        headers: () => ({ authorization: `Bearer ${token}` }),
      }),
    bootstrap: async () => {
      bootstraps++;
      return { ...initial, transport: policy };
    },
  });
  cleanups.push(() => client.dispose());
  return {
    client,
    watched: watched.promise,
    canceled: canceled.promise,
    checkpoints,
    counts: () => ({ sockets, httpCalls, accepted, bootstraps, reauthentications }),
    watchTokens,
    endStreams: () => {
      subscriptions.abort();
      subscriptions = new AbortController();
    },
    setToken: (next: string) => {
      token = next;
    },
    allowSocket: () => {
      rejectSocket = false;
    },
    nextWatches: () => {
      threadReady = Promise.withResolvers<void>();
      catalogReady = Promise.withResolvers<void>();
      return Promise.all([threadReady.promise, catalogReady.promise]);
    },
    ready: () => Promise.all([threadReady.promise, catalogReady.promise]),
    publishInput: () =>
      publisher.publish("thread", {
        kind: "input",
        receipt: { inputId: "live", messageId: "live", turnId: "live", state: "admitted" },
      }),
    changePolicy: (next: NativeTransport) => {
      policy = next;
      threadReady = Promise.withResolvers<void>();
      catalogReady = Promise.withResolvers<void>();
      publisher.publish("catalog", { kind: "resync", cursor: "changed" });
    },
    setPolicy: (next: NativeTransport) => {
      policy = next;
    },
  };
}
const input = {
  commandId: "command",
  threadId: "thread",
  historyGeneration: 0,
  mode: "prompt" as const,
  text: "hello",
  attachmentIds: [],
  skillIds: [],
};

test("HTTP+SSE streams replay, sends commands once, and cancels idle subscriptions without a socket", async () => {
  const f = fixture("http-sse");
  await f.client.start("thread");
  await f.watched;
  expect(f.client.connectionState).toBe("online");
  expect(f.checkpoints).toEqual([checkpoint]);
  expect((await f.client.submit(input)).kind).toBe("accepted");
  expect((await f.client.retry(input.commandId)).kind).toBe("accepted");
  expect(f.counts()).toMatchObject({ sockets: 0, accepted: 1 });
  await f.client.dispose();
  await f.canceled;
});

test("auto tries WebSocket again on reconnect and can fall back again", async () => {
  const f = fixture("auto", true);
  await f.client.start("thread");
  await f.watched;
  expect(f.client.currentTransport).toBe("http-sse");
  expect((await f.client.submit(input)).kind).toBe("accepted");
  const online = Promise.withResolvers<void>();
  f.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") online.resolve();
  });
  f.client.reconnect();
  await online.promise;
  expect(f.counts().sockets).toBe(2);
  expect(f.client.currentTransport).toBe("http-sse");
});

test("forced WebSocket never starts HTTP when an upgrade fails", async () => {
  const f = fixture("websocket", true);
  const offline = Promise.withResolvers<void>();
  f.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "offline") offline.resolve();
  });
  await f.client.start("thread");
  await offline.promise;
  expect(f.counts().httpCalls).toBe(0);
  expect(f.client.currentTransport).toBe("websocket");
});

test("a new deployment policy switches transport while preserving replay and receipts", async () => {
  const f = fixture("websocket");
  await f.client.start("thread");
  await f.watched;
  expect((await f.client.submit(input)).kind).toBe("accepted");
  f.setPolicy("http-sse");
  const switched = Promise.withResolvers<void>();
  f.client.subscribe((event) => {
    if (
      event.kind === "connection" &&
      event.state === "online" &&
      f.client.currentTransport === "http-sse"
    )
      switched.resolve();
  });
  f.client.reconnect();
  await switched.promise;
  expect(f.client.thread("thread").checkpoint).toEqual(checkpoint);
  expect((await f.client.retry(input.commandId)).kind).toBe("accepted");
  expect(f.counts().accepted).toBe(1);
});

test("auto replaces a stalled handshake at its deadline and closes the abandoned socket", async () => {
  const originalTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...values] = args;
      if (delay === 10_000) expire = () => callback(...values);
      return originalTimeout(...args);
    }, originalTimeout),
  );
  cleanups.push(() => timer.mockRestore());
  class StalledSocket extends EventTarget {
    readyState: number = WebSocket.CONNECTING;
    close() {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
    send() {
      throw new Error("Handshake never completed");
    }
  }
  const socket = new StalledSocket();
  const f = fixture("auto", false, () => socket as unknown as WebSocket);
  await f.client.start("thread");
  expect(expire).toBeDefined();
  expire!();
  await f.watched;
  expect(f.client.currentTransport).toBe("http-sse");
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

test("deployment resync repeatedly switches live subscriptions between WebSocket and SSE", async () => {
  const f = fixture("websocket");
  await f.client.start("thread");
  await f.ready();
  for (const policy of ["http-sse", "websocket", "http-sse", "auto"] as const) {
    f.changePolicy(policy);
    await f.ready();
    expect(f.client.currentTransport).toBe(policy === "auto" ? "websocket" : policy);
    const delivered = Promise.withResolvers<void>();
    const unsubscribe = f.client.subscribe((event) => {
      if (event.kind === "input" && event.receipt.inputId === "live") delivered.resolve();
    });
    f.publishInput();
    await delivered.promise;
    unsubscribe();
  }
});

test("auto upgrades back to WebSocket when it becomes available on reconnect", async () => {
  const f = fixture("auto", true);
  await f.client.start("thread");
  await f.ready();
  expect(f.client.currentTransport).toBe("http-sse");
  f.allowSocket();
  const ready = f.nextWatches();
  f.client.reconnect();
  await ready;
  expect(f.client.currentTransport).toBe("websocket");
  expect(f.counts().sockets).toBe(2);
  expect(f.checkpoints).toEqual([checkpoint, checkpoint]);
});

test("HTTP reauthentication renews subscriptions with fresh credentials without reconnecting", async () => {
  const f = fixture("http-sse");
  let online = 0;
  f.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") online++;
  });
  await f.client.start("thread");
  await f.ready();
  const rpc = f.client.rpc;
  const ready = f.nextWatches();
  f.setToken("renewed-test-token");
  expect(await f.client.reauthenticate("renewed-test-token")).toBe(true);
  await ready;
  await f.canceled;
  expect(f.client.rpc).toBe(rpc);
  expect(f.counts()).toMatchObject({ sockets: 0, bootstraps: 1, reauthentications: 1 });
  expect(online).toBe(1);
  expect(f.watchTokens).toEqual([
    "Bearer initial-test-token",
    "Bearer initial-test-token",
    "Bearer renewed-test-token",
    "Bearer renewed-test-token",
  ]);
  expect(f.checkpoints).toEqual([checkpoint, checkpoint]);
  const delivered = Promise.withResolvers<void>();
  f.client.subscribe((event) => {
    if (event.kind === "input" && event.receipt.inputId === "live") delivered.resolve();
  });
  f.publishInput();
  await delivered.promise;
});

for (const transport of ["http-sse", "auto"] as const)
  test(`an online reauthentication listener cannot cause a ${transport} reconnect loop`, async () => {
    const f = fixture(transport, true);
    let online = 0;
    const refreshed = Promise.withResolvers<boolean>();
    f.client.subscribe((event) => {
      if (event.kind !== "connection" || event.state !== "online") return;
      online++;
      if (online === 1) void f.client.reauthenticate("test-token").then(refreshed.resolve);
    });
    await f.client.start("thread");
    expect(await refreshed.promise).toBe(true);
    expect(online).toBe(1);
    expect(f.counts()).toMatchObject({
      bootstraps: transport === "auto" ? 2 : 1,
      reauthentications: 1,
    });
  });

test("auto retries WebSocket after an established SSE stream disconnects", async () => {
  const f = fixture("auto", true);
  await f.client.start("thread");
  await f.ready();
  expect(f.client.currentTransport).toBe("http-sse");
  const originalTimeout = globalThis.setTimeout;
  const retryScheduled = Promise.withResolvers<() => void>();
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...values] = args;
      const handle = originalTimeout(...args);
      if (delay !== undefined && delay >= 250 && delay <= 500) {
        retryScheduled.resolve(() => {
          clearTimeout(handle);
          callback(...values);
        });
      }
      return handle;
    }, originalTimeout),
  );
  cleanups.push(() => timer.mockRestore());
  f.allowSocket();
  const ready = f.nextWatches();
  f.endStreams();
  const retry = await retryScheduled.promise;
  retry();
  await ready;
  expect(f.client.currentTransport).toBe("websocket");
  expect(f.counts().sockets).toBe(2);
});
