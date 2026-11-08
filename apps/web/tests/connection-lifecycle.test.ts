import { afterEach, expect, spyOn, test } from "bun:test";
import {
  CONNECTION_CHECK_INTERVAL_MS,
  isConnectionFailure,
  reconnectAttempt,
  watchConnectionLifecycle,
} from "../src/connection-lifecycle";

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

test("resuming a suspended app reconnects once and removes lifecycle listeners on cleanup", () => {
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  const events = new EventTarget();
  let reconnects = 0;
  const client = {
    connectionState: "online" as const,
    reconnect: () => {
      reconnects++;
    },
    checkConnection: async () => {},
  };
  const stop = watchConnectionLifecycle(client, page, events);
  events.dispatchEvent(new Event("focus"));
  expect(reconnects).toBe(0);
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  events.dispatchEvent(new Event("online"));
  expect(reconnects).toBe(0);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  page.dispatchEvent(new Event("visibilitychange"));
  events.dispatchEvent(new Event("focus"));
  expect(reconnects).toBe(1);
  events.dispatchEvent(new Event("online"));
  expect(reconnects).toBe(2);
  stop();
  events.dispatchEvent(new Event("online"));
  expect(reconnects).toBe(2);
});

test("focusing an offline desktop window bypasses reconnect backoff", () => {
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
  const events = new EventTarget();
  let reconnects = 0;
  const stop = watchConnectionLifecycle(
    {
      connectionState: "offline",
      reconnect: () => {
        reconnects++;
      },
      checkConnection: async () => {},
    },
    page,
    events,
  );
  events.dispatchEvent(new Event("focus"));
  expect(reconnects).toBe(1);
  stop();
});

test("a visible page probes its socket so a silently dropped connection is replaced", () => {
  const originalInterval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    Object.assign((...args: Parameters<typeof setInterval>) => {
      const [callback, delay] = args;
      if (delay === CONNECTION_CHECK_INTERVAL_MS) tick = () => callback();
      return originalInterval(...args);
    }, originalInterval),
  );
  restore.push(() => interval.mockRestore());
  const cleared = spyOn(globalThis, "clearInterval");
  restore.push(() => cleared.mockRestore());
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
  });
  let checks = 0;
  const stop = watchConnectionLifecycle(
    {
      connectionState: "online",
      reconnect: () => {},
      checkConnection: async () => {
        checks++;
      },
    },
    page,
    new EventTarget(),
  );
  expect(tick).toBeDefined();
  tick!();
  expect(checks).toBe(1);
  page.visibilityState = "hidden";
  tick!();
  expect(checks).toBe(1);
  stop();
  expect(cleared).toHaveBeenCalled();
});

test("connection failures are told apart from other request errors", () => {
  for (const message of [
    "Cannot send message, WebSocket is not open.",
    "[AsyncIdQueue] Queue[12] was closed or aborted while waiting for pulling.",
    "Connection unavailable. Please retry when connected.",
    "Could not connect to Lilac. Your drafts are saved on this device.",
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "Load failed",
    "Service Unavailable",
  ])
    expect(isConnectionFailure(message)).toBe(true);
  for (const message of [
    "Conversation not found",
    "Internal Server Error",
    "Messages can contain up to 65,536 characters.",
    "Sign in to continue",
  ])
    expect(isConnectionFailure(message)).toBe(false);
});

test("a reconnect attempt settles when it connects or fails, not while connecting", async () => {
  type Listener = Parameters<Parameters<typeof reconnectAttempt>[0]["subscribe"]>[0];
  const listeners = new Set<Listener>();
  let settled = false;
  const attempt = reconnectAttempt({
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect: () => {
      for (const listener of listeners) listener({ kind: "connection", state: "connecting" });
    },
  }).then(() => {
    settled = true;
  });
  for (const listener of listeners) listener({ kind: "catalog" });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(listeners.size).toBe(1);
  for (const listener of listeners) listener({ kind: "connection", state: "offline" });
  await attempt;
  expect(settled).toBe(true);
  expect(listeners.size).toBe(0);
});

test("a reconnect attempt stops waiting when the client only ever reports connecting", async () => {
  type Listener = Parameters<Parameters<typeof reconnectAttempt>[0]["subscribe"]>[0];
  const listeners = new Set<Listener>();
  let expire = () => {};
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void) => {
    expire = run;
    return 0;
  }) as never);
  restore.push(() => timer.mockRestore());
  const attempt = reconnectAttempt({
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconnect: () => {
      for (const listener of listeners) listener({ kind: "connection", state: "connecting" });
    },
  });
  expect(listeners.size).toBe(1);
  expire();
  await attempt;
  expect(listeners.size).toBe(0);
});
