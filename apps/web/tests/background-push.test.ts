import { expect, test } from "bun:test";
import type { NativeClient } from "@stanley2058/lilac-client";
import { createBackgroundPush, backgroundPushSupport } from "../src/background-push";
import { createNotificationPreferences } from "../src/notifications";

function fixture() {
  const order: string[] = [];
  let subscribed = false;
  let rejectServer = false;
  const subscription = {
    endpoint: "https://fcm.googleapis.com/device",
    getKey: (name: string) => new Uint8Array(name === "auth" ? 16 : 65).buffer,
    unsubscribe: async () => {
      order.push("unsubscribe-browser");
      subscribed = false;
      return true;
    },
  };
  const registration = {
    active: true,
    pushManager: {
      getSubscription: async () => (subscribed ? subscription : null),
      subscribe: async () => {
        order.push("subscribe-browser");
        subscribed = true;
        return subscription;
      },
    },
  };
  const originals = ["window", "navigator", "Notification"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const notification = {
    permission: "granted",
    requestPermission: async () => {
      order.push("permission");
      return "granted";
    },
  };
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: { isSecureContext: true, PushManager: {}, Notification: notification },
    },
    Notification: { configurable: true, value: notification },
    navigator: {
      configurable: true,
      value: {
        locks: {},
        serviceWorker: {
          getRegistration: async () => {
            order.push("registration");
            return registration;
          },
        },
      },
    },
  });
  const updates: object[] = [];
  const rpc = {
    notifications: {
      key: async () => ({ publicKey: btoa("test-key") }),
      subscribe: async (input: object) => {
        order.push("subscribe-server");
        if (rejectServer) throw new Error("Server unavailable");
        updates.push(input);
        return { ok: true };
      },
      unsubscribe: async () => {
        order.push("unsubscribe-server");
        return { ok: true };
      },
      presence: async () => ({ ok: true }),
    },
  };
  const preferences = createNotificationPreferences({
    installationId: "test",
    principalId: "owner",
  });
  preferences.store.setState({ enabled: true, background: false });
  const push = createBackgroundPush(
    { rpc } as unknown as Pick<NativeClient, "rpc" | "subscribe">,
    preferences,
  );
  return {
    order,
    updates,
    preferences,
    push,
    registration,
    reject: () => {
      rejectServer = true;
    },
    [Symbol.dispose]() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("enabling asks permission first, persists the subscription, and disables both sides", async () => {
  using f = fixture();
  expect(await f.push.apply({ background: true }, true)).toBe(true);
  expect(f.order[0]).toBe("permission");
  expect(f.updates[0]).toMatchObject({ completion: true, failure: true });
  expect(f.preferences.store.getState().background).toBe(true);
  expect(await f.push.apply({ failure: false })).toBe(true);
  expect(f.updates[1]).toMatchObject({ completion: true, failure: false });
  expect(await f.push.apply({ enabled: false })).toBe(true);
  expect(f.preferences.store.getState()).toMatchObject({ background: false, enabled: false });
  expect(f.order.indexOf("unsubscribe-server")).toBeLessThan(
    f.order.indexOf("unsubscribe-browser"),
  );
});

test("a rejected subscription leaves background push off and exposes the failure", async () => {
  using f = fixture();
  f.reject();
  expect(await f.push.apply({ background: true }, true)).toBe(false);
  expect(f.preferences.store.getState().background).toBe(false);
  expect(f.push.store.getState()).toEqual({ busy: false, error: "Server unavailable" });
});

test("iOS without PushManager explains Home Screen installation", () => {
  using _f = fixture();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { isSecureContext: true },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 1, serviceWorker: {} },
  });
  expect(backgroundPushSupport()).toContain("Home Screen");
});
