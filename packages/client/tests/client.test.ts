import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { implement } from "@orpc/server";
import { ORPCError } from "@orpc/client";
import { RPCHandler } from "@orpc/server/bun-ws";
import {
  nativeContract,
  type BootstrapReply,
  type Hydration,
  type NativeInput,
  type NativeRpcInputs,
  type ThreadEvent,
} from "@stanley2058/lilac-client-protocol";
import { NativeClient, type ClientEvent } from "../src/client.ts";
import { MemoryNativeCache, type CacheScope } from "../src/cache.ts";
import { reconnectDelay } from "../src/transport.ts";

const scope: CacheScope = {
  installationId: "installation",
  principalId: "owner",
  protocolVersion: 1,
  projectionVersion: 1,
};
const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 1,
  cursor: "cursor",
};
const bootstrap: BootstrapReply = {
  installationId: "installation",
  viewer: { id: "owner", displayName: "Owner", role: "owner", toolMode: "full" },
  threads: { items: [] },
  catalog: {
    kind: "catalog",
    catalog: { revision: "catalog", skills: [], commands: [], models: [] },
  },
  catalogCursor: "catalog_cursor",
  selectedThread: {
    kind: "window",
    checkpoint,
    slots: [
      {
        kind: "ready",
        slotId: "slot",
        turnId: "turn",
        position: 0,
        messages: [{ id: "message", role: "user", parts: [{ type: "text", text: "hello" }] }],
      },
    ],
  },
};
const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

function harness(
  options: {
    streamWatch?: (
      input: NativeRpcInputs["streams"]["watch"],
      signal?: AbortSignal,
    ) => AsyncGenerator<ThreadEvent>;
    delayedSubmit?: Promise<void>;
    rootReceipt?: import("@stanley2058/lilac-client-protocol").NativeInputReceipt;
    prepareConnection?: (request: { fresh: boolean }) => Promise<void>;
    getCatalog?: (signal?: AbortSignal) => Promise<void>;
    unresponsiveClose?: boolean;
    reauthenticate?: (signal?: AbortSignal) => Promise<BootstrapReply["viewer"]>;
    beforeOpen?: () => void;
    delayedCatalog?: Promise<void>;
    bootstrap?: () => Promise<BootstrapReply>;
    hydrate?: (input: NativeRpcInputs["streams"]["hydrate"]) => Promise<Hydration>;
  } = {},
) {
  const watches: unknown[] = [];
  const sentInputs: NativeInput[] = [];
  const opened = Promise.withResolvers<void>();
  const watching = Promise.withResolvers<void>();
  const submitting = Promise.withResolvers<void>();
  const fetchingCatalog = Promise.withResolvers<void>();
  const watch = implement(nativeContract.streams.watch).handler(async function* ({
    input,
    signal,
  }) {
    watches.push({
      threadId: input.target.threadId,
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    });
    watching.resolve();
    if (options.streamWatch && input.target.kind === "subagent") {
      yield* options.streamWatch(input, signal);
      return;
    }
    if (options.rootReceipt) yield { kind: "input" as const, receipt: options.rootReceipt };
    yield { kind: "replay" as const, reply: { kind: "unchanged" as const, checkpoint } };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const catalog = implement(nativeContract.bootstrap.watch).handler(async function* ({ signal }) {
    if (options.delayedCatalog)
      yield { kind: "catalog-invalidated" as const, cursor: "changed", revision: "changed" };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  const submit = implement(nativeContract.inputs.submit).handler(async ({ input }) => {
    sentInputs.push(input);
    submitting.resolve();
    await options.delayedSubmit;
    return { inputId: "input", messageId: "message", state: "admitted" as const, turnId: "turn" };
  });
  const getCatalog = implement(nativeContract.catalogs.get).handler(async ({ signal }) => {
    fetchingCatalog.resolve();
    await options.getCatalog?.(signal);
    await options.delayedCatalog;
    return {
      kind: "catalog" as const,
      catalog: { revision: "new", models: [], skills: [], commands: [] },
    };
  });
  const reauthenticate = implement(nativeContract.connection.reauthenticate).handler(
    ({ signal }) => options.reauthenticate?.(signal) ?? Promise.resolve(bootstrap.viewer),
  );
  const hydrate = implement(nativeContract.streams.hydrate).handler(({ input }) => {
    if (!options.hydrate) throw new ORPCError("NOT_FOUND");
    return options.hydrate(input);
  });
  const handler = new RPCHandler({
    connection: { reauthenticate },
    streams: { watch, hydrate },
    bootstrap: { watch: catalog },
    inputs: { submit },
    catalogs: { get: getCatalog },
  });
  let socketCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message: (socket, message) => handler.message(socket, message),
      close: (socket) => handler.close(socket),
    },
  });
  disposers.push(() => server.stop(true));
  const events: ClientEvent[] = [];
  const cache = new MemoryNativeCache();
  const client = new NativeClient({
    scope,
    cache,
    prepareConnection: options.prepareConnection,
    openSocket: () => {
      socketCount++;
      options.beforeOpen?.();
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
      socket.addEventListener("open", () => opened.resolve());
      // A dead network path never completes the close handshake, so no close event arrives.
      if (options.unresponsiveClose) socket.close = () => {};
      return socket;
    },
    bootstrap: async () => {
      await opened.promise;
      return options.bootstrap ? options.bootstrap() : bootstrap;
    },
    onEvent: (event) => events.push(event),
  });
  disposers.push(() => client.dispose());
  return {
    client,
    cache,
    events,
    watches,
    sentInputs,
    watching: watching.promise,
    fetchingCatalog: fetchingCatalog.promise,
    submitting: submitting.promise,
    socketCount: () => socketCount,
  };
}
const input: NativeInput = {
  commandId: "command",
  threadId: "thread",
  historyGeneration: 0,
  mode: "prompt",
  text: "hello",
  attachmentIds: [],
  skillIds: [],
};

describe("NativeClient", () => {
  test("bootstrap owns initial content and socket attaches at its watermark", async () => {
    const test = harness();
    await test.client.start("thread");
    await test.watching;
    expect(test.socketCount()).toBe(1);
    expect(test.watches).toEqual([{ threadId: "thread", checkpoint }]);
    expect(test.client.thread("thread").get("slot")).toMatchObject({ turnId: "turn" });
    expect(test.events.some((event) => event.kind === "bootstrap")).toBe(true);
  });

  test("retry retains one command identity and rejects changed payload", async () => {
    const test = harness();
    expect(await test.client.submit(input)).toEqual({ kind: "uncertain", commandId: "command" });
    await test.client.start("thread");
    expect(await test.client.retry("command")).toMatchObject({
      kind: "accepted",
      receipt: { inputId: "input" },
    });
    expect(await test.client.retry("command")).toMatchObject({ kind: "accepted" });
    expect(await test.client.submit({ ...input, text: "different" })).toMatchObject({
      kind: "rejected",
      error: { kind: "conflict" },
    });
    expect(test.sentInputs).toHaveLength(1);
    expect(test.sentInputs[0]?.commandId).toBe("command");
  });

  test("logout fences a pending response and purges private state", async () => {
    const pending = Promise.withResolvers<void>();
    const test = harness({ delayedSubmit: pending.promise });
    await test.client.start("thread");
    const submitted = test.client.submit(input);
    await test.submitting;
    await test.client.logout();
    pending.resolve();
    expect(await submitted).toMatchObject({ kind: "uncertain" });
    expect(await test.client.retry("command")).toMatchObject({ kind: "rejected" });
    expect(await test.cache.read(scope, "thread")).toBeUndefined();
    expect(test.client.thread("thread").size).toBe(0);
    expect(test.events.at(-1)).toEqual({ kind: "connection", state: "logged-out" });
  });

  test("revocation removes persisted thread after already queued writes finish", async () => {
    const test = harness();
    await test.client.start("thread");
    const store = test.client.thread("thread");
    await test.client.revoke("thread");
    expect(store.size).toBe(0);
    expect(await test.cache.read(scope, "thread")).toBeUndefined();
    expect(test.events.at(-1)).toEqual({ kind: "removed", threadId: "thread" });
  });

  test("late catalog response cannot repopulate state after logout", async () => {
    const pending = Promise.withResolvers<void>();
    const test = harness({ delayedCatalog: pending.promise });
    await test.client.start("thread");
    await test.fetchingCatalog;
    await test.client.logout();
    pending.resolve();
    await test.client.dispose();
    expect(test.client.catalogs.get(scope)).toBeUndefined();
    expect(test.events.at(-1)).toEqual({ kind: "connection", state: "logged-out" });
  });

  test("bootstrap forbidden purges cached private state and logs out", async () => {
    const test = harness({
      bootstrap: async () => {
        throw new ORPCError("FORBIDDEN");
      },
    });
    await test.cache.commit(scope, "thread", {
      checkpoint,
      replace: true,
      remove: [],
      put: [
        {
          revision: 1,
          slot: { kind: "ready", slotId: "secret", turnId: "secret", position: 0, messages: [] },
        },
      ],
    });
    await test.client.start("thread");
    expect(test.events.at(-1)).toEqual({ kind: "connection", state: "logged-out" });
    expect(test.client.thread("thread").size).toBe(0);
    expect(await test.cache.read(scope, "thread")).toBeUndefined();
  });

  test("failed HTTP bootstrap retries while its socket remains open", async () => {
    let attempts = 0;
    const test = harness({
      bootstrap: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Temporary HTTP failure");
        return bootstrap;
      },
    });
    await test.client.start("thread");
    await test.watching;
    expect(attempts).toBe(2);
    expect(test.socketCount()).toBe(1);
    expect(test.client.thread("thread").get("slot")).toBeDefined();
  });

  test("reconnect delay is jittered and bounded without fixed test waits", () => {
    expect(reconnectDelay(0, () => 0)).toBe(250);
    expect(reconnectDelay(0, () => 1)).toBe(500);
    expect(reconnectDelay(100, () => 1)).toBe(30_000);
  });
});

test("UI selection during bootstrap attaches one watch after the snapshot watermark", async () => {
  const release = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  const test = harness({
    bootstrap: async () => {
      requested.resolve();
      return release.promise;
    },
  });
  const starting = test.client.start("thread");
  await requested.promise;
  await test.client.selectThread("thread");
  expect(test.watches).toEqual([]);
  release.resolve(bootstrap);
  await starting;
  await test.watching;
  await test.client.selectThread("thread");
  await test.client.selectThread("thread");
  expect(test.watches).toEqual([{ threadId: "thread", checkpoint }]);
});

test("first-thread selection while an unselected bootstrap loads creates one content watch", async () => {
  const release = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  const test = harness({
    bootstrap: async () => {
      requested.resolve();
      return release.promise;
    },
  });
  const starting = test.client.start();
  await requested.promise;
  await test.client.selectThread("thread");
  release.resolve({ ...bootstrap, selectedThread: undefined });
  await starting;
  await test.watching;
  await test.client.selectThread("thread");
  expect(test.watches).toEqual([{ threadId: "thread" }]);
});

test("inactive stores evict while selected and observed stores stay stable", async () => {
  const test = harness();
  await test.client.selectThread("selected");
  const selected = test.client.thread("selected");
  const observed = test.client.thread("observed");
  const release = observed.subscribe(() => {});
  const oldest = test.client.thread("oldest");
  for (let index = 0; index < 24; index++) test.client.thread(`visited_${index}`);
  expect(test.client.thread("selected")).toBe(selected);
  expect(test.client.thread("observed")).toBe(observed);
  expect(test.client.thread("oldest")).not.toBe(oldest);
  release();
  for (let index = 0; index < 12; index++) test.client.thread(`later_${index}`);
  expect(test.client.thread("observed")).not.toBe(observed);
});

test("an evicted store restores only after its queued checkpoint commits", async () => {
  const saving = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class DelayedCache extends MemoryNativeCache {
    override async commit(...args: Parameters<MemoryNativeCache["commit"]>): Promise<void> {
      saving.resolve();
      await release.promise;
      await super.commit(...args);
    }
  }
  const cache = new DelayedCache();
  const client = new NativeClient({
    scope,
    cache,
    openSocket: () => new WebSocket("ws://unused.invalid"),
    bootstrap: async () => bootstrap,
  });
  disposers.push(() => client.dispose());
  const original = client.thread("original");
  const selected = bootstrap.selectedThread;
  if (selected) original.replay(selected);
  await saving.promise;
  for (let index = 0; index < 24; index++) client.thread(`visited_${index}`);
  const restored = client.thread("original");
  expect(restored).not.toBe(original);
  const loading = client.loadCached("original");
  expect(restored.checkpoint).toBeUndefined();
  release.resolve();
  await loading;
  expect(restored.checkpoint).toEqual(checkpoint);
  expect(restored.get("slot")).toBeDefined();
  expect((await cache.read(scope, "original"))?.checkpoint).toEqual(checkpoint);
});

test("no-cache clients retain the selected store but release visited inactive history", async () => {
  const client = new NativeClient({
    scope,
    openSocket: () => new WebSocket("ws://unused.invalid"),
    bootstrap: async () => bootstrap,
  });
  disposers.push(() => client.dispose());
  await client.selectThread("selected");
  const selected = client.thread("selected");
  const old = client.thread("old");
  client.thread("next");
  expect(client.thread("old")).not.toBe(old);
  expect(client.thread("selected")).toBe(selected);
});

test("HTTP retry does not cancel socket reconnection after both transports fail", async () => {
  const closed = Promise.withResolvers<void>();
  const reopened = Promise.withResolvers<void>();
  const bootstrapped = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/fail") return new Response(null, { status: 503 });
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: { message() {} },
  });
  disposers.push(() => server.stop(true));
  let socketCount = 0;
  let bootstrapCount = 0;
  const client = new NativeClient({
    scope,
    openSocket: () => {
      const path = socketCount++ === 0 ? "/fail" : "/socket";
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
      socket.addEventListener("close", () => closed.resolve());
      socket.addEventListener("open", () => reopened.resolve());
      return socket;
    },
    bootstrap: async () => {
      if (bootstrapCount++ === 0) {
        await closed.promise;
        throw new Error("HTTP unavailable");
      }
      return bootstrap;
    },
    onEvent: (event) => {
      if (event.kind === "bootstrap") bootstrapped.resolve();
    },
  });
  disposers.push(() => client.dispose());
  await client.start();
  await Promise.all([reopened.promise, bootstrapped.promise]);
  expect(socketCount).toBe(2);
  expect(bootstrapCount).toBeGreaterThanOrEqual(2);
  expect(client.rpc).toBeDefined();
});

test("foreground reconnect replaces the socket immediately and preserves selected history", async () => {
  const test = harness();
  await test.client.start("thread");
  await test.watching;
  const store = test.client.thread("thread");
  const online = Promise.withResolvers<void>();
  const stop = test.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") online.resolve();
  });
  test.client.reconnect();
  expect(test.socketCount()).toBe(2);
  expect(test.client.thread("thread")).toBe(store);
  await online.promise;
  stop();
  expect(test.client.connectionState).toBe("online");
  expect(test.events.filter((event) => event.kind === "error")).toEqual([]);
});

test("a superseded bootstrap cannot log out the resumed session", async () => {
  const old = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  let requests = 0;
  const test = harness({
    bootstrap: async () => {
      if (requests++ === 0) {
        requested.resolve();
        return old.promise;
      }
      return bootstrap;
    },
  });
  const starting = test.client.start("thread");
  await requested.promise;
  const recovered = Promise.withResolvers<void>();
  test.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  test.client.reconnect();
  await recovered.promise;
  old.reject(new ORPCError("UNAUTHENTICATED"));
  await starting;
  expect(test.client.connectionState).toBe("online");
  expect(
    test.events.some((event) => event.kind === "connection" && event.state === "logged-out"),
  ).toBe(false);
});

test("opening a local draft deselects the previous server thread across reconnects", async () => {
  const test = harness();
  await test.client.start("thread");
  await test.watching;
  await test.client.selectThread(undefined);
  const recovered = Promise.withResolvers<void>();
  test.client.subscribe((event) => {
    if (event.kind === "bootstrap") recovered.resolve();
  });
  test.client.reconnect();
  await recovered.promise;
  expect(test.watches).toHaveLength(1);
});

test("the socket alone does not report recovery before bootstrap succeeds", async () => {
  const response = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  const test = harness({
    bootstrap: async () => {
      requested.resolve();
      return response.promise;
    },
  });
  const starting = test.client.start("thread");
  await requested.promise;
  expect(test.client.connectionState).toBe("connecting");
  response.resolve(bootstrap);
  await starting;
  expect(test.client.connectionState).toBe("online");
});

test("retryable bootstrap failures use connection status without duplicate error events", async () => {
  const test = harness({
    bootstrap: async () => {
      throw new Error("Network unavailable");
    },
  });
  await test.client.start("thread");
  expect(test.client.connectionState).toBe("offline");
  expect(test.events.filter((event) => event.kind === "error")).toEqual([]);
});

test("a socket constructor failure during resume remains retryable", async () => {
  let fail = false;
  const test = harness({
    beforeOpen: () => {
      if (fail) throw new Error("Socket temporarily unavailable");
    },
  });
  await test.client.start("thread");
  await test.watching;
  fail = true;
  expect(() => test.client.reconnect()).not.toThrow();
  expect(test.client.connectionState).toBe("offline");
  expect(test.client.rpc).toBeUndefined();
  fail = false;
  const recovered = Promise.withResolvers<void>();
  test.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  test.client.reconnect();
  await recovered.promise;
  expect(test.socketCount()).toBe(3);
  expect(test.client.thread("thread").get("slot")).toBeDefined();
});

test("reconnect waits for fresh credentials before opening either transport", async () => {
  const credentials = Promise.withResolvers<void>();
  let prepare = () => Promise.resolve();
  const state = harness({ prepareConnection: () => prepare() });
  await state.client.start("thread");
  await state.watching;
  prepare = () => credentials.promise;
  const recovered = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  state.client.reconnect();
  expect(state.socketCount()).toBe(1);
  expect(state.client.connectionState).toBe("connecting");
  credentials.resolve();
  await recovered.promise;
  expect(state.socketCount()).toBe(2);
  expect(state.client.thread("thread").get("slot")).toBeDefined();
});

test("Retry supersedes a stalled credential refresh", async () => {
  const credentials = Promise.withResolvers<void>();
  let calls = 0;
  const state = harness({
    prepareConnection: () => (calls++ === 0 ? credentials.promise : Promise.resolve()),
  });
  const starting = state.client.start();
  expect(state.socketCount()).toBe(0);
  const recovered = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  state.client.reconnect();
  await recovered.promise;
  credentials.resolve();
  await starting;
  expect(state.socketCount()).toBe(1);
  expect(state.client.connectionState).toBe("online");
});

test("a stalled bootstrap is replaced at the connection deadline", async () => {
  const originalTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...values] = args;
      if (delay === 10_000) expire = () => callback(...values);
      return originalTimeout(...args);
    }, originalTimeout),
  );
  disposers.push(() => timer.mockRestore());
  const stalled = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  let calls = 0;
  const state = harness({
    bootstrap: () => {
      if (calls++ > 0) return Promise.resolve(bootstrap);
      requested.resolve();
      return stalled.promise;
    },
  });
  const starting = state.client.start();
  await requested.promise;
  const recovered = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  expect(expire).toBeDefined();
  expire!();
  await recovered.promise;
  stalled.reject(new ORPCError("UNAUTHENTICATED"));
  await starting;
  expect(state.client.connectionState).toBe("online");
  expect(state.socketCount()).toBe(2);
});

test("an old authentication error cannot log out a reconnect waiting for credentials", async () => {
  const old = Promise.withResolvers<BootstrapReply>();
  const requested = Promise.withResolvers<void>();
  const credentials = Promise.withResolvers<void>();
  let preparations = 0;
  let bootstraps = 0;
  const state = harness({
    prepareConnection: () => (preparations++ === 0 ? Promise.resolve() : credentials.promise),
    bootstrap: () => {
      if (bootstraps++ > 0) return Promise.resolve(bootstrap);
      requested.resolve();
      return old.promise;
    },
  });
  const starting = state.client.start("thread");
  await requested.promise;
  state.client.reconnect();
  old.reject(new ORPCError("UNAUTHENTICATED"));
  await starting;
  expect(state.client.connectionState).toBe("connecting");
  const recovered = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  credentials.resolve();
  await recovered.promise;
  expect(state.client.connectionState).toBe("online");
});

test("reauthentication timeout replaces an unresponsive socket even when HTTP remains healthy", async () => {
  const deadline = new AbortController();
  const timer = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  disposers.push(() => timer.mockRestore());
  const requested = Promise.withResolvers<void>();
  const state = harness({
    reauthenticate: (signal) =>
      new Promise((resolve) => {
        requested.resolve();
        if (signal?.aborted) return resolve(bootstrap.viewer);
        signal?.addEventListener("abort", () => resolve(bootstrap.viewer), { once: true });
      }),
  });
  await state.client.start("thread");
  await state.watching;
  const recovered = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  const refreshing = state.client.reauthenticate("test-token");
  await requested.promise;
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  expect(await refreshing).toBe(false);
  await recovered.promise;
  expect(state.socketCount()).toBe(2);
  expect(state.client.connectionState).toBe("online");
  expect(state.client.thread("thread").get("slot")).toBeDefined();
});

test("an expired cached credential retries with a fresh one instead of logging out", async () => {
  const requests: boolean[] = [];
  let bootstraps = 0;
  const state = harness({
    prepareConnection: async ({ fresh }) => {
      requests.push(fresh);
    },
    bootstrap: async () => {
      if (bootstraps++ === 0) throw new ORPCError("UNAUTHENTICATED");
      return bootstrap;
    },
  });
  const recovered = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  await state.client.start("thread");
  await recovered.promise;
  expect(requests).toEqual([false, true]);
  expect(
    state.events.some((event) => event.kind === "connection" && event.state === "logged-out"),
  ).toBe(false);
  expect(state.client.thread("thread").get("slot")).toBeDefined();
});

test("a rejected fresh credential still ends the session", async () => {
  const requests: boolean[] = [];
  const state = harness({
    prepareConnection: async ({ fresh }) => {
      requests.push(fresh);
    },
    bootstrap: async () => {
      throw new ORPCError("UNAUTHENTICATED");
    },
  });
  const loggedOut = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "logged-out") loggedOut.resolve();
  });
  await state.client.start("thread");
  await loggedOut.promise;
  expect(requests).toEqual([false, true]);
});

test("a connection check replaces a socket that stopped replying", async () => {
  const deadline = new AbortController();
  const timer = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  disposers.push(() => timer.mockRestore());
  const probing = Promise.withResolvers<void>();
  const state = harness({
    getCatalog: (signal) =>
      new Promise((resolve) => {
        probing.resolve();
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  await state.client.start("thread");
  await state.watching;
  const recovered = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "connection" && event.state === "online") recovered.resolve();
  });
  const checking = state.client.checkConnection();
  await probing.promise;
  deadline.abort(new DOMException("Timed out", "TimeoutError"));
  await checking;
  await recovered.promise;
  expect(state.socketCount()).toBe(2);
  expect(state.client.thread("thread").get("slot")).toBeDefined();
});

test("a responsive connection check keeps the socket", async () => {
  const state = harness();
  await state.client.start("thread");
  await state.watching;
  await state.client.checkConnection();
  expect(state.socketCount()).toBe(1);
  expect(state.client.connectionState).toBe("online");
});

test("a send waiting on a replaced socket settles as uncertain", async () => {
  const state = harness({ delayedSubmit: new Promise(() => {}), unresponsiveClose: true });
  await state.client.start("thread");
  await state.watching;
  const sending = state.client.submit(input);
  await state.submitting;
  state.client.reconnect();
  expect(await sending).toEqual({ kind: "uncertain", commandId: input.commandId });
});

test("a child shares the client store and reconnects from its checkpoint while the parent stays selected", async () => {
  const childCheckpoint = { ...checkpoint, cursor: "child_checkpoint" };
  const childInputs: NativeRpcInputs["streams"]["watch"][] = [];
  const reattached = Promise.withResolvers<void>();
  const h = harness({
    streamWatch: async function* (input, signal) {
      childInputs.push(input);
      if (childInputs.length === 2) reattached.resolve();
      yield {
        kind: "replay",
        reply: input.checkpoint
          ? { kind: "unchanged", checkpoint: childCheckpoint }
          : {
              kind: "window",
              checkpoint: childCheckpoint,
              slots: [
                {
                  kind: "ready",
                  slotId: "child_slot",
                  turnId: "child_turn",
                  position: 0,
                  state: "complete",
                  messages: [
                    {
                      id: "child_answer",
                      role: "assistant",
                      metadata: { phase: "final" },
                      parts: [{ type: "text", text: "Child answer" }],
                    },
                  ],
                },
              ],
            },
      };
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  await h.client.start("thread");
  await h.watching;
  const target = { kind: "subagent" as const, threadId: "thread", agentId: "wfrun:child" };
  const child = h.client.stream(target);
  const loaded = Promise.withResolvers<void>();
  const stop = child.subscribe(() => {
    if (child.checkpoint) loaded.resolve();
  });
  const unobserve = h.client.observeStream(target);
  await loaded.promise;
  stop();
  expect(child.at(0)).toMatchObject({ state: "complete" });
  expect(h.client.thread("thread").get("slot")).toBeDefined();
  h.client.reconnect();
  await reattached.promise;
  expect(childInputs[1]?.checkpoint).toEqual(childCheckpoint);
  expect(h.client.stream(target)).toBe(child);
  await h.client.revoke("thread");
  expect(child.size).toBe(0);
  expect(await h.cache.read(scope, "subagent:thread:wfrun:child")).toBeUndefined();
  unobserve();
});

test("a jump to another turn replaces a pending jump into the same range", async () => {
  const targets: (number | undefined)[] = [];
  const firstRequested = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const range = {
    kind: "deferred" as const,
    slotId: "range_0_0_200",
    position: 0,
    endPosition: 200,
  };
  const turn = (position: number) => ({
    kind: "ready" as const,
    slotId: `slot_${position}`,
    turnId: `turn_${position}`,
    position,
    messages: [],
  });
  const around = (position: number): Hydration => ({
    historyGeneration: 0,
    projectionRevision: 1,
    slotId: range.slotId,
    slots: [
      { kind: "deferred", slotId: `range_0_0_${position}`, position: 0, endPosition: position },
      turn(position),
      {
        kind: "deferred",
        slotId: `range_0_${position + 1}_200`,
        position: position + 1,
        endPosition: 200,
      },
    ],
  });
  const test = harness({
    bootstrap: async () => ({
      ...bootstrap,
      selectedThread: { kind: "window", checkpoint, slots: [range, turn(200)] },
    }),
    hydrate: async (input) => {
      targets.push(input.aroundPosition);
      if (input.aroundPosition !== 12) return around(input.aroundPosition ?? 199);
      firstRequested.resolve();
      await releaseFirst.promise;
      return around(12);
    },
  });
  await test.client.start("thread");
  const first = test.client.hydrate("thread", range.slotId, { aroundPosition: 12 });
  await firstRequested.promise;
  await test.client.hydrate("thread", range.slotId, { aroundPosition: 100 });
  await first;
  releaseFirst.resolve();
  expect(targets).toEqual([12, 100]);
  const store = test.client.thread("thread");
  expect(store.get("slot_100")?.kind).toBe("ready");
  expect(store.get("slot_12")).toBeUndefined();
});

test("an input event settles an uncertain command without submitting it again", async () => {
  const state = harness({
    rootReceipt: {
      commandId: input.commandId,
      inputId: "accepted",
      messageId: "message",
      state: "admitted",
    },
  });
  expect(await state.client.submit(input)).toEqual({
    kind: "uncertain",
    commandId: input.commandId,
  });
  const received = Promise.withResolvers<void>();
  state.client.subscribe((event) => {
    if (event.kind === "input") received.resolve();
  });
  await state.client.start("thread");
  await received.promise;
  expect(await state.client.retry(input.commandId)).toMatchObject({
    kind: "accepted",
    receipt: { inputId: "accepted" },
  });
  expect(state.sentInputs).toEqual([]);
});

test("cache writes coalesce synchronous replay updates at the latest checkpoint", async () => {
  const state = harness();
  const commit = spyOn(state.cache, "commit");
  const store = state.client.thread("thread");
  store.replay(bootstrap.selectedThread!);
  store.update({
    checkpoint: { ...checkpoint, projectionRevision: 2, cursor: "second" },
    changes: [
      {
        kind: "append-text",
        turnId: "turn",
        position: 0,
        messageId: "message",
        partIndex: 0,
        text: " two",
      },
    ],
  });
  store.update({
    checkpoint: { ...checkpoint, projectionRevision: 3, cursor: "third" },
    changes: [
      {
        kind: "append-text",
        turnId: "turn",
        position: 0,
        messageId: "message",
        partIndex: 0,
        text: " three",
      },
    ],
  });
  await state.client.loadCached("thread");
  expect(commit).toHaveBeenCalledTimes(1);
  expect((await state.cache.read(scope, "thread"))?.checkpoint.projectionRevision).toBe(3);
});
