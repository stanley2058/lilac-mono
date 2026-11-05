import { afterEach, describe, expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { Result } from "better-result";
import { createNativeHttpRPC, type CacheScope } from "@stanley2058/lilac-client";
import type { BootstrapReply } from "@stanley2058/lilac-client-protocol";
import { WebSessionController, type WebSessionOptions } from "../src/bootstrap";
import { WebNativeCache } from "../src/cache";

const scope: CacheScope = {
  installationId: "install",
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
  installationId: "install",
  viewer: { id: "owner", displayName: "Owner", role: "owner", toolMode: "full" },
  threads: { items: [] },
  catalogCursor: "catalog",
  catalog: {
    kind: "catalog",
    catalog: { revision: "catalog", models: [], commands: [], skills: [] },
  },
};
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function setup(options: WebSessionOptions = {}) {
  const opened: WebSocket[] = [];
  const cache = options.cache ?? new WebNativeCache({ indexedDB: null });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: { message() {} },
  });
  cleanup.push(() => {
    server.stop(true);
    cache.close();
  });
  const fetchBootstrap = options.bootstrap ?? (async () => bootstrap);
  const controller = new WebSessionController({
    cache,
    openSocket: () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
      opened.push(socket);
      return socket;
    },
    openHttp: () => createNativeHttpRPC({ url: server.url }),
    socketBootstrap: (_rpc, input, signal) => fetchBootstrap(input, signal),
    logout: async () => Result.ok(),
    currentUrl: () => new URL("http://localhost/threads/selected"),
    channel: null,
    ...options,
    bootstrap: fetchBootstrap,
  });
  cleanup.push(() => controller.dispose());
  return { controller, cache, opened };
}

describe("WebSessionController", () => {
  test("cold deep link reads deployment policy before opening a socket", async () => {
    const response = Promise.withResolvers<BootstrapReply>();
    const requested = Promise.withResolvers<void>();
    const inputs: unknown[] = [];
    const test = setup({
      bootstrap: async (input) => {
        inputs.push(input);
        requested.resolve();
        return response.promise;
      },
    });
    const starting = test.controller.start();
    await requested.promise;
    expect(test.opened).toHaveLength(0);
    expect(inputs).toEqual([{ threadId: "selected" }]);
    expect(test.controller.getSnapshot().kind).toBe("starting");
    response.resolve({ ...bootstrap, selectedThread: { kind: "window", checkpoint, slots: [] } });
    await starting;
    expect(test.controller.getSnapshot().kind).toBe("ready");
    expect(inputs).toHaveLength(1);
    expect(test.opened).toHaveLength(1);
  });

  test("cached shell never associates another thread's saved transcript with the URL", async () => {
    const cache = new WebNativeCache({ indexedDB: null });
    await cache.saveBootstrap(scope, {
      ...bootstrap,
      selectedThread: {
        kind: "window",
        checkpoint,
        slots: [{ kind: "ready", slotId: "wrong", turnId: "wrong", position: 0, messages: [] }],
      },
    });
    await cache.commit(scope, "selected", {
      checkpoint,
      replace: true,
      remove: [],
      put: [
        {
          revision: 1,
          slot: { kind: "ready", slotId: "correct", turnId: "correct", position: 0, messages: [] },
        },
      ],
    });
    const response = Promise.withResolvers<BootstrapReply>();
    const requested = Promise.withResolvers<void>();
    const test = setup({
      cache,
      bootstrap: async (input) => {
        expect(input.checkpoint).toEqual(checkpoint);
        requested.resolve();
        return response.promise;
      },
    });
    const starting = test.controller.start();
    await requested.promise;
    const state = test.controller.getSnapshot();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(state.session.initial.selectedThread).toBeUndefined();
      expect(state.session.client.thread("selected").get("correct")).toBeDefined();
      expect(state.session.client.thread("selected").get("wrong")).toBeUndefined();
    }
    response.resolve({ ...bootstrap, selectedThread: { kind: "unchanged", checkpoint } });
    await starting;
  });

  test("logout aborts a cold request and fences a provider that resolves after cancellation", async () => {
    const response = Promise.withResolvers<BootstrapReply>();
    const requested = Promise.withResolvers<AbortSignal | undefined>();
    const test = setup({
      bootstrap: async (_input, signal) => {
        requested.resolve(signal);
        return response.promise;
      },
    });
    const starting = test.controller.start();
    const signal = await requested.promise;
    await test.controller.logout();
    expect(signal?.aborted).toBe(true);
    expect(test.opened).toHaveLength(0);
    response.resolve(bootstrap);
    await starting;
    expect(test.controller.getSnapshot().kind).toBe("login");
    expect(await test.cache.readLatestBootstrap()).toBeUndefined();
  });

  test("a cached session bootstraps over its new socket instead of pooled HTTP", async () => {
    const cache = new WebNativeCache({ indexedDB: null });
    await cache.saveBootstrap(scope, bootstrap);
    const transports: string[] = [];
    const test = setup({
      cache,
      bootstrap: async () => {
        transports.push("http");
        return bootstrap;
      },
      socketBootstrap: async () => {
        transports.push("socket");
        return bootstrap;
      },
    });
    await test.controller.start();
    const state = test.controller.getSnapshot();
    if (state.kind !== "ready") throw new Error("Session did not start");
    state.session.client.reconnect();
    const recovered = Promise.withResolvers<void>();
    state.session.client.subscribe((event) => {
      if (event.kind === "connection" && event.state === "online") recovered.resolve();
    });
    await recovered.promise;
    expect(transports).toEqual(["socket", "socket"]);
  });

  test("a socket that cannot open falls back to HTTP so an ended session is reported", async () => {
    const cache = new WebNativeCache({ indexedDB: null });
    await cache.saveBootstrap(scope, bootstrap);
    const transports: string[] = [];
    const test = setup({
      cache,
      openSocket: () => new WebSocket("ws://127.0.0.1:1"),
      bootstrap: async () => {
        transports.push("http");
        throw new ORPCError("UNAUTHENTICATED");
      },
      socketBootstrap: async () => {
        transports.push("socket");
        return bootstrap;
      },
    });
    const ended = Promise.withResolvers<void>();
    test.controller.subscribe(() => {
      if (test.controller.getSnapshot().kind === "login") ended.resolve();
    });
    await test.controller.start();
    await ended.promise;
    expect(transports).toEqual(["http", "http"]);
    expect(await cache.readLatestBootstrap()).toBeUndefined();
  });

  test("a late bootstrap cache write is drained then purged by logout", async () => {
    const saving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class DelayedCache extends WebNativeCache {
      override async saveBootstrap(identity: CacheScope, value: BootstrapReply): Promise<void> {
        saving.resolve();
        await release.promise;
        await super.saveBootstrap(identity, value);
      }
    }
    const cache = new DelayedCache({ indexedDB: null });
    const test = setup({ cache });
    await test.controller.start();
    await saving.promise;
    const logout = test.controller.logout();
    expect(test.controller.getSnapshot().kind).toBe("login");
    release.resolve();
    await logout;
    expect(await cache.readLatestBootstrap()).toBeUndefined();
  });

  test("changing authenticated account purges the prior account's caches", async () => {
    const cache = new WebNativeCache({ indexedDB: null });
    await cache.saveBootstrap(scope, bootstrap);
    await cache.saveDraft(scope, "selected", { text: "private draft", skillIds: [] });
    const test = setup({
      cache,
      bootstrap: async () => ({ ...bootstrap, viewer: { ...bootstrap.viewer, id: "different" } }),
    });
    await test.controller.start();
    await test.controller.dispose();
    expect(test.controller.getSnapshot().kind).toBe("login");
    expect(await cache.readLatestBootstrap()).toBeUndefined();
    expect(await cache.readDraft(scope, "selected")).toMatchObject({ text: "", skillIds: [] });
  });

  test("cross-tab logout clears private display and cache without rebroadcasting", async () => {
    const name = `lilac-test-${crypto.randomUUID()}`;
    const a = setup({ channel: new BroadcastChannel(name) });
    const b = setup({ channel: new BroadcastChannel(name) });
    await a.controller.start();
    await b.controller.start();
    const cleared = Promise.withResolvers<void>();
    b.controller.subscribe(() => {
      if (b.controller.getSnapshot().kind === "login") cleared.resolve();
    });
    await a.controller.logout();
    await cleared.promise;
    await b.controller.dispose();
    expect(b.controller.getSnapshot().kind).toBe("login");
    expect(await b.cache.readLatestBootstrap()).toBeUndefined();
  });

  test("synchronous socket failure starts the HTTP fallback", async () => {
    const test = setup({
      openSocket: () => {
        throw new Error("Socket blocked");
      },
    });
    await test.controller.start();
    const state = test.controller.getSnapshot();
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") expect(state.session.client.currentTransport).toBe("http-sse");
  });

  test("cold authentication failure shows login without opening a socket", async () => {
    const test = setup({
      bootstrap: async () => {
        throw new ORPCError("FORBIDDEN");
      },
    });
    await test.controller.start();
    expect(test.controller.getSnapshot().kind).toBe("login");
    expect(test.opened).toHaveLength(0);
  });

  test("a failed remote logout still clears local private state", async () => {
    const test = setup({
      logout: async () => {
        throw new Error("Offline");
      },
    });
    await test.controller.start();
    await test.controller.logout();
    expect(test.controller.getSnapshot().kind).toBe("login");
    expect(await test.cache.readLatestBootstrap()).toBeUndefined();
  });
});

test("sign-in remains disabled until the remote logout response has settled", async () => {
  const remote = Promise.withResolvers<Result<void, Error>>();
  let bootstrapCalls = 0;
  let logoutCalls = 0;
  const test = setup({
    bootstrap: async () => {
      bootstrapCalls++;
      return bootstrap;
    },
    logout: async () => {
      logoutCalls++;
      return remote.promise;
    },
  });
  await test.controller.start();
  const logout = test.controller.logout();
  expect(test.controller.getSnapshot()).toMatchObject({ kind: "login", signingOut: true });
  await test.controller.start();
  const duplicate = test.controller.logout();
  expect(logoutCalls).toBe(1);
  expect(bootstrapCalls).toBe(1);
  remote.resolve(Result.ok());
  await Promise.all([logout, duplicate]);
  expect(test.controller.getSnapshot()).toMatchObject({ kind: "login", signingOut: false });
  await test.controller.start();
  expect(bootstrapCalls).toBe(2);
});

test("provider logout starts before unmount and keeps credentials gated after native logout", async () => {
  const provider = Promise.withResolvers<Result<void, Error>>();
  let providerCalls = 0;
  const test = setup();
  await test.controller.start();
  const logout = test.controller.logout(() => {
    providerCalls++;
    expect(test.controller.getSnapshot().kind).toBe("ready");
    return provider.promise;
  });
  expect(providerCalls).toBe(1);
  expect(test.controller.getSnapshot()).toMatchObject({ kind: "login", signingOut: true });
  await test.controller.start();
  expect(test.controller.getSnapshot()).toMatchObject({ kind: "login", signingOut: true });
  provider.resolve(Result.ok());
  await logout;
  expect(test.controller.getSnapshot()).toMatchObject({ kind: "login", signingOut: false });
});

test("provider logout failure remains visible after private state is purged", async () => {
  const test = setup();
  await test.controller.start();
  await test.controller.logout(async () =>
    Result.err(new Error("Could not sign out of Clerk. Try again.")),
  );
  expect(test.controller.getSnapshot()).toMatchObject({
    kind: "login",
    signingOut: false,
    message: "Could not sign out of Clerk. Try again.",
  });
  expect(await test.cache.readLatestBootstrap()).toBeUndefined();
});

test("a rejected provider loader still clears the session and private cache", async () => {
  const test = setup();
  await test.controller.start();
  await test.controller.logout(() => Promise.reject(new Error("Failed to fetch account module")));
  expect(test.controller.getSnapshot()).toMatchObject({
    kind: "login",
    signingOut: false,
    message: "Could not sign out of the authentication provider. Try again.",
  });
  expect(await test.cache.readLatestBootstrap()).toBeUndefined();
});

test.each(["rejection", "result"] as const)(
  "failed native logout (%s) blocks startup until a successful retry",
  async (failure) => {
    let calls = 0;
    let bootstraps = 0;
    const test = setup({
      bootstrap: async () => {
        bootstraps++;
        return bootstrap;
      },
      logout: async () => {
        if (calls++ > 0) return Result.ok();
        if (failure === "rejection") throw new Error("Offline");
        return Result.err(new Error("Server unavailable"));
      },
    });
    await test.controller.start();
    await test.controller.logout();
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "login",
      signingOut: false,
      logoutFailed: true,
      message: "Could not sign out of Lilac. Retry before leaving this device.",
    });
    expect(await test.cache.readLatestBootstrap()).toBeUndefined();
    await test.controller.start();
    expect(bootstraps).toBe(1);
    await test.controller.logout();
    expect(test.controller.getSnapshot()).toMatchObject({
      kind: "login",
      logoutFailed: false,
      message: undefined,
    });
    await test.controller.start();
    expect(bootstraps).toBe(2);
  },
);
