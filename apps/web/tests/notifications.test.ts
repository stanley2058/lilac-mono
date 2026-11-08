import { expect, test } from "bun:test";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import {
  createNotificationPreferences,
  notificationScope,
  notificationTransition,
  watchNotifications,
  sendTestNotification,
} from "../src/notifications";

const working: NativeThread = {
  id: "thread",
  title: "Example",
  starterId: "owner",
  archived: false,
  updatedAt: 1,
  revision: 1,
  displayStatus: "working",
  activeRunId: "run",
  capabilities: { read: true, edit: true, share: true },
};
const complete: NativeThread = {
  ...working,
  revision: 2,
  displayStatus: "completed",
  activeRunId: undefined,
};

function notificationFixture(initial: NativeThread[] = []) {
  type Listener = Parameters<Parameters<typeof watchNotifications>[0]["client"]["subscribe"]>[0];
  let listener: Listener = () => {};
  let viewed = false;
  const scope = { installationId: "test", principalId: "user" };
  const shown: NotificationOptions[] = [];
  const originals = ["window", "navigator", "Notification"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const notification = { permission: "granted" };
  const globals = {
    window: Object.assign(new EventTarget(), { isSecureContext: true, Notification: notification }),
    Notification: notification,
    navigator: {
      locks: {
        request: (_name: string, _options: object, callback: () => Promise<void>) => callback(),
        query: async () => ({
          held: viewed ? [{ name: `${notificationScope(scope)}:view:thread` }] : [],
        }),
      },
      serviceWorker: {
        getRegistration: async () => ({
          active: true,
          showNotification: async (_title: string, options: NotificationOptions) => {
            shown.push(options);
          },
        }),
      },
    },
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const preferences = createNotificationPreferences(scope);
  preferences.store.setState({ enabled: true, completion: true, failure: true });
  const stop = watchNotifications({
    client: {
      connectionState: "online",
      subscribe(callback) {
        listener = callback;
        return () => {};
      },
    },
    initial,
    scope,
    preferences,
    openThread: () => {},
  });
  return {
    shown,
    preferences,
    deliver: (event: Parameters<Listener>[0]) => listener(event),
    view: (value: boolean) => {
      viewed = value;
    },
    [Symbol.dispose]() {
      stop();
      for (const [key, original] of originals) {
        if (original) Object.defineProperty(globalThis, key, original);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test.each(["completed", "error"] as const)(
  "live %s after an intermediate idle status notifies once",
  async (displayStatus) => {
    using fixture = notificationFixture();
    const running = { ...working, revision: 7 };
    const idle: NativeThread = { ...complete, revision: 10, displayStatus: "idle" };
    const terminal = { ...complete, revision: 12, displayStatus };
    await fixture.deliver({ kind: "thread", thread: running });
    await fixture.deliver({ kind: "thread", thread: idle });
    await fixture.deliver({ kind: "thread", thread: running });
    await fixture.deliver({ kind: "thread", thread: { ...terminal, revision: 9 } });
    expect(fixture.shown).toHaveLength(0);
    await fixture.deliver({ kind: "thread", thread: terminal });
    expect(fixture.shown.map((item) => item.body)).toEqual([
      displayStatus === "completed" ? "Response finished" : "Run failed",
    ]);
    expect(fixture.shown[0]?.tag).toContain(":12");
    await fixture.deliver({ kind: "thread", thread: terminal });
    await fixture.deliver({ kind: "thread", thread: { ...idle, revision: 13 } });
    await fixture.deliver({ kind: "thread", thread: { ...terminal, revision: 14 } });
    expect(fixture.shown).toHaveLength(1);
    await fixture.deliver({
      kind: "thread",
      thread: { ...running, revision: 15, activeRunId: "next-run" },
    });
    await fixture.deliver({ kind: "thread", thread: { ...idle, revision: 16 } });
    await fixture.deliver({ kind: "thread", thread: { ...terminal, revision: 17 } });
    expect(fixture.shown).toHaveLength(2);
  },
);

test("a question during a live run notifies once, then the run's completion notifies", async () => {
  using fixture = notificationFixture([working]);
  const asking: NativeThread = { ...working, revision: 2, waitingOn: "input" };
  await fixture.deliver({ kind: "thread", thread: asking });
  expect(fixture.shown.map((item) => item.body)).toEqual(["Needs your input"]);
  await fixture.deliver({ kind: "thread", thread: { ...asking, revision: 3 } });
  expect(fixture.shown).toHaveLength(1);
  await fixture.deliver({ kind: "thread", thread: { ...complete, revision: 4 } });
  expect(fixture.shown.map((item) => item.body)).toEqual(["Needs your input", "Response finished"]);
});

test.each(["viewed", "disabled"] as const)(
  "an intermediate idle status preserves %s suppression without a later catch-up alert",
  async (reason) => {
    using fixture = notificationFixture([working]);
    fixture.view(reason === "viewed");
    fixture.preferences.store.setState({ enabled: reason !== "disabled" });
    await fixture.deliver({ kind: "thread", thread: { ...complete, displayStatus: "idle" } });
    await fixture.deliver({ kind: "thread", thread: { ...complete, revision: 3 } });
    expect(fixture.shown).toHaveLength(0);
    fixture.view(false);
    fixture.preferences.store.setState({ enabled: true });
    await fixture.deliver({ kind: "thread", thread: { ...complete, revision: 4 } });
    expect(fixture.shown).toHaveLength(0);
  },
);

test.each(["removed", "reconnect", "bootstrap", "archived", "revoked"] as const)(
  "%s clears a completion pending across idle",
  async (reset) => {
    using fixture = notificationFixture([working]);
    const idle: NativeThread = { ...complete, displayStatus: "idle" };
    await fixture.deliver({ kind: "thread", thread: idle });
    switch (reset) {
      case "removed":
        await fixture.deliver({ kind: "removed", threadId: working.id });
        break;
      case "reconnect":
        await fixture.deliver({ kind: "connection", state: "offline" });
        await fixture.deliver({ kind: "connection", state: "online" });
        break;
      case "bootstrap":
        await fixture.deliver({
          kind: "bootstrap",
          bootstrap: {
            installationId: "test",
            viewer: { id: "user", displayName: "User", role: "owner", toolMode: "full" },
            threads: { items: [idle] },
            catalog: { kind: "unchanged", revision: "catalog" },
            catalogCursor: "cursor",
          },
        });
        break;
      case "archived":
        await fixture.deliver({ kind: "thread", thread: { ...idle, revision: 3, archived: true } });
        break;
      case "revoked":
        await fixture.deliver({
          kind: "thread",
          thread: {
            ...idle,
            revision: 3,
            capabilities: { read: false, edit: false, share: false },
          },
        });
        break;
    }
    await fixture.deliver({ kind: "thread", thread: { ...complete, revision: 4 } });
    expect(fixture.shown).toHaveLength(0);
  },
);

test("alerts require a new terminal transition from an observed working state", () => {
  expect(notificationTransition(working, complete)).toBe("completion");
  expect(notificationTransition(working, { ...complete, displayStatus: "error" })).toBe("failure");
  const asking: NativeThread = { ...working, revision: 2, waitingOn: "input" };
  expect(notificationTransition(working, asking)).toBe("input");
  expect(notificationTransition(asking, { ...asking, revision: 3 })).toBeUndefined();
  expect(notificationTransition(asking, { ...complete, revision: 3 })).toBe("completion");
  expect(
    notificationTransition(asking, { ...complete, revision: 3, displayStatus: "input" }),
  ).toBeUndefined();
  expect(notificationTransition(working, { ...complete, displayStatus: "input" })).toBe("input");
  expect(notificationTransition(working, { ...asking, waitingOn: "other" })).toBeUndefined();
  expect(notificationTransition(undefined, complete)).toBeUndefined();
  expect(notificationTransition(complete, { ...complete, revision: 3 })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, revision: 1 })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, revision: 0 })).toBeUndefined();
  expect(notificationTransition(working, { ...working, revision: 2 })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, displayStatus: "idle" })).toBeUndefined();
  expect(notificationTransition(working, { ...complete, archived: true })).toBeUndefined();
  expect(
    notificationTransition(working, {
      ...complete,
      capabilities: { read: false, edit: false, share: false },
    }),
  ).toBeUndefined();
});

test("preferences are opt-in, scoped, synchronized and tolerate corrupt or unavailable storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  try {
    const scope = { installationId: "one", principalId: "owner" };
    const first = createNotificationPreferences(scope);
    const second = createNotificationPreferences(scope);
    expect(first.store.getState()).toEqual({
      enabled: false,
      background: false,
      completion: true,
      failure: true,
    });
    first.update({ enabled: true, completion: false });
    second.sync();
    expect(second.store.getState()).toEqual({
      enabled: true,
      background: false,
      completion: false,
      failure: true,
    });
    expect(
      createNotificationPreferences({ ...scope, principalId: "other" }).store.getState().enabled,
    ).toBe(false);
    expect(
      createNotificationPreferences({ ...scope, installationId: "two" }).store.getState().enabled,
    ).toBe(false);
    for (const key of values.keys()) values.set(key, "bad");
    second.sync();
    expect(second.store.getState().enabled).toBe(false);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Unavailable");
      },
    });
    expect(createNotificationPreferences(scope).store.getState().enabled).toBe(false);
    expect(() => first.update({ enabled: false })).not.toThrow();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("live delivery suppresses viewed, disabled, duplicate and reconnect events and cleans up", async () => {
  const { watchNotifications, notificationScope } = await import("../src/notifications");
  type ClientEvent = Parameters<
    Parameters<typeof watchNotifications>[0]["client"]["subscribe"]
  >[0] extends (event: infer E) => void
    ? E
    : never;
  let listener: (event: ClientEvent) => void = () => {};
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  const scope = { installationId: "test", principalId: "user" };
  const shown: {
    title: string;
    body?: string;
    tag?: string;
    closed: boolean;
    onclick?: () => void;
    close: () => void;
  }[] = [];
  let focused = false;
  let registrationLookup = async (): Promise<undefined> => undefined;
  let opened = "";
  let unsubscribed = false;
  class TestNotification {
    static permission = "granted";
    closed = false;
    onclick?: () => void;
    body?: string;
    tag?: string;
    constructor(
      public title: string,
      options: NotificationOptions,
    ) {
      this.body = options.body;
      this.tag = options.tag;
      shown.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  const fakeWindow = Object.assign(new EventTarget(), {
    isSecureContext: true,
    Notification: TestNotification,
    focus() {},
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: TestNotification,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      serviceWorker: { getRegistration: () => registrationLookup() },
      locks: {
        request: (_name: string, _options: object, callback: () => Promise<void>) => callback(),
        query: async () => ({
          held: focused ? [{ name: `${notificationScope(scope)}:view:thread` }] : [],
        }),
      },
    },
  });
  let stop = () => {};
  try {
    const preferences = createNotificationPreferences(scope);
    preferences.store.setState({ enabled: true });
    stop = watchNotifications({
      client: {
        connectionState: "online",
        subscribe(callback) {
          listener = callback;
          return () => {
            unsubscribed = true;
          };
        },
      },
      initial: [working],
      scope,
      preferences,
      openThread: (id) => {
        opened = id;
      },
    });
    await listener({ kind: "thread", thread: complete });
    expect(shown.map((notification) => notification.body)).toEqual(["Response finished"]);
    shown[0]!.onclick?.();
    expect(opened).toBe("thread");
    expect(shown[0]!.closed).toBe(true);
    await listener({ kind: "thread", thread: complete });
    await listener({ kind: "thread", thread: working });
    await listener({ kind: "thread", thread: { ...complete, revision: 3 } });
    expect(shown).toHaveLength(1);
    focused = true;
    await listener({ kind: "thread", thread: { ...working, revision: 4 } });
    await listener({ kind: "thread", thread: { ...complete, revision: 5 } });
    expect(shown).toHaveLength(1);
    focused = false;
    preferences.store.setState({ completion: false });
    await listener({ kind: "thread", thread: { ...working, revision: 6 } });
    await listener({ kind: "thread", thread: { ...complete, revision: 7 } });
    expect(shown).toHaveLength(1);
    await listener({ kind: "thread", thread: { ...working, revision: 8 } });
    await listener({
      kind: "thread",
      thread: { ...complete, revision: 9, displayStatus: "error" },
    });
    expect(shown[1]?.body).toBe("Run failed");
    expect(shown[1]?.tag).not.toBe(shown[0]?.tag);
    await listener({ kind: "connection", state: "offline" });
    await listener({ kind: "connection", state: "online" });
    await listener({ kind: "thread", thread: { ...complete, revision: 10 } });
    expect(shown).toHaveLength(2);
    preferences.store.setState({ enabled: false });
    await listener({ kind: "thread", thread: { ...working, revision: 11 } });
    await listener({
      kind: "thread",
      thread: { ...complete, revision: 12, displayStatus: "error" },
    });
    expect(shown).toHaveLength(2);
    preferences.store.setState({ enabled: true, completion: true });
    let releaseLookup: () => void = () => {};
    let lookupStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    registrationLookup = () => {
      lookupStarted();
      return new Promise<undefined>((resolve) => {
        releaseLookup = () => resolve(undefined);
      });
    };
    await listener({ kind: "thread", thread: { ...working, revision: 13 } });
    const delivery = listener({ kind: "thread", thread: { ...complete, revision: 14 } });
    await started;
    await listener({
      kind: "thread",
      thread: { ...complete, revision: 15, title: "Updated title" },
    });
    releaseLookup();
    await delivery;
    expect(shown).toHaveLength(3);
    expect(shown[2]?.title).toBe("Lilac · Updated title");
    expect(shown[2]?.tag).toContain(":14");
    expect(new Set(shown.map((notification) => notification.tag)).size).toBe(3);
    registrationLookup = async () => undefined;
    stop();
    expect(unsubscribed).toBe(true);
    expect(shown.every((notification) => notification.closed)).toBe(true);
  } finally {
    stop();
    for (const [key, original] of [
      ["window", originalWindow],
      ["navigator", originalNavigator],
      ["Notification", originalNotification],
    ] as const) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("test notification uses the service worker and preserves preferences", async () => {
  using fixture = notificationFixture();
  const before = fixture.preferences.store.getState();
  Object.defineProperty(Notification, "requestPermission", {
    configurable: true,
    value: async () => "granted",
  });
  expect((await sendTestNotification("thread")).isOk()).toBe(true);
  expect(fixture.shown).toHaveLength(1);
  expect(fixture.shown[0]).toMatchObject({
    body: "Your response is ready. This is a preview of the completed response.",
    data: { threadId: "thread" },
  });
  expect(fixture.preferences.store.getState()).toEqual(before);
});
