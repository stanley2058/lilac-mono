import { expect, mock, spyOn, test } from "bun:test";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeRpcInputs } from "@stanley2058/lilac-client-protocol";
import { createThreadPresence } from "../src/thread-presence";

function fixture() {
  const reports: NativeRpcInputs["notifications"]["presence"][] = [];
  let listener: Parameters<NativeClient["subscribe"]>[0] | undefined;
  let tick: (() => void) | undefined;
  let reject = false;
  const originalInterval = globalThis.setInterval;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    Object.assign((...args: Parameters<typeof setInterval>) => {
      tick = () => args[0]();
      return originalInterval(...args);
    }, originalInterval),
  );
  const unsubscribe = mock(() => {});
  const rpc = {
    notifications: {
      presence: async (input: NativeRpcInputs["notifications"]["presence"]) => {
        reports.push(input);
        if (reject) throw new Error("Disconnected");
        return { ok: true };
      },
    },
  } as unknown as NonNullable<NativeClient["rpc"]>;
  let currentRpc: NativeClient["rpc"] = rpc;
  const client: Pick<NativeClient, "rpc" | "subscribe"> = {
    get rpc() {
      return currentRpc;
    },
    subscribe: (callback) => {
      listener = callback;
      return unsubscribe;
    },
  };
  const presence = createThreadPresence(client);
  const stop = presence.start();
  return {
    presence,
    reports,
    client,
    setOnline: (online: boolean) => {
      currentRpc = online ? rpc : undefined;
    },
    unsubscribe,
    tick: () => tick!(),
    online: () => listener!({ kind: "connection", state: "online" }),
    reject: () => {
      reject = true;
    },
    [Symbol.dispose]() {
      stop();
      interval.mockRestore();
    },
  };
}

test("presence reports and clears focus without browser push APIs or preferences", () => {
  using f = fixture();
  f.presence.view("thread-one");
  const focused = f.reports.at(-1)!;
  expect(focused).toEqual({ clientId: expect.any(String), threadId: "thread-one" });
  f.tick();
  expect(f.reports.at(-1)).toEqual(focused);
  f.presence.view("thread-two");
  expect(f.reports.at(-1)).toEqual({ ...focused, threadId: "thread-two" });
  f.presence.view();
  expect(f.reports.at(-1)).toEqual({ clientId: focused.clientId, threadId: undefined });
  const count = f.reports.length;
  f.tick();
  expect(f.reports).toHaveLength(count);
});

test("reconnect reports current focus and disposal clears it", () => {
  const f = fixture();
  f.setOnline(false);
  f.presence.view("thread-one");
  expect(f.reports).toHaveLength(1);
  f.setOnline(true);
  f.online();
  expect(f.reports.at(-1)?.threadId).toBe("thread-one");
  f[Symbol.dispose]();
  expect(f.reports.at(-1)?.threadId).toBeUndefined();
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});

test("each tab has its own presence identity and unavailable reports are best effort", async () => {
  using f = fixture();
  f.presence.view("thread-one");
  const first = f.reports.at(-1)!.clientId;
  createThreadPresence(f.client).view("thread-one");
  expect(f.reports.at(-1)!.clientId).not.toBe(first);
  f.reject();
  f.presence.view();
  await Promise.resolve();
  expect(f.reports.at(-1)?.threadId).toBeUndefined();
});

test("repeating the current view sends nothing until a report fails", async () => {
  using f = fixture();
  f.presence.view("thread-one");
  const count = f.reports.length;
  // Window focus, blur and visibility changes all repeat the view while the same thread is open.
  f.presence.view("thread-one");
  f.presence.view("thread-one");
  expect(f.reports).toHaveLength(count);
  f.reject();
  await f.presence.view("thread-two");
  await f.presence.view("thread-two");
  expect(f.reports.map((report) => report.threadId).slice(count)).toEqual([
    "thread-two",
    "thread-two",
  ]);
});
