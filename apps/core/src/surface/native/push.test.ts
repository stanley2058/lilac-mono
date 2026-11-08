import { createHash } from "node:crypto";
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { WebPushError, type sendNotification } from "web-push";
import { NativePush, allowedPushEndpoint, PUSH_ESCALATION_MS } from "./push";
import { NativeStore } from "./store";
import { NativeSurfaceAdapter } from "./adapter";
import { NativeSurfaceStore } from "./store-surface";

function fixture(
  send: typeof sendNotification = async () => ({ statusCode: 201, headers: {}, body: "" }),
  deviceId?: string,
) {
  const db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  for (const id of ["owner", "alice", "bob"] as const)
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  const push = new NativePush(db, store, send);
  push.key().unwrap();
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/device",
    keys: { p256dh: "x".repeat(87), auth: "y".repeat(22) },
    completion: true,
    failure: true,
  };
  push.subscribe("alice", subscription).unwrap();
  push.start();
  const thread = store.createThread("alice", { commandId: "new" }).unwrap();
  const receipt = store
    .acceptInput("alice", {
      threadId: thread.id,
      commandId: "input",
      deviceId,
      historyGeneration: 0,
      text: "Hello",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  store.setActiveRun(thread.id, 0, "run").unwrap();
  function finish(state: "complete" | "failed" = "complete") {
    store
      .projectTurn(thread.id, 0, "finish", receipt.turnId!, (slot) =>
        Result.ok({
          slot: {
            ...slot,
            state,
            messages: [
              ...slot.messages,
              {
                id: "reply",
                role: "assistant",
                parts: [
                  { type: "text", text: "**Done.** Read [the result](https://example.com)." },
                ],
              },
            ],
          },
          changes: [],
        }),
      )
      .unwrap();
    store.setActiveRun(thread.id, 0).unwrap();
  }
  return { db, store, push, thread, receipt, subscription, finish };
}

test("push endpoints reject arbitrary destinations", () => {
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://fcm.googleapis.com:444/x",
    "https://user@fcm.googleapis.com/x",
  ])
    expect(allowedPushEndpoint(endpoint)).toBe(false);
  for (const endpoint of [
    "https://fcm.googleapis.com/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/x",
    "https://wns2.notify.windows.com/x",
  ])
    expect(allowedPushEndpoint(endpoint)).toBe(true);
});

test("subscriptions and signing keys survive restart, removals are owner scoped", async () => {
  const f = fixture();
  const key = f.push.key().unwrap();
  const restarted = new NativePush(f.db, f.store);
  expect(restarted.key().unwrap()).toEqual(key);
  restarted.unsubscribe("bob", f.subscription.endpoint).unwrap();
  expect(f.db.query("SELECT endpoint FROM native_push_subscriptions").all()).toHaveLength(1);
  restarted.unsubscribe("alice", f.subscription.endpoint).unwrap();
  expect(f.db.query("SELECT endpoint FROM native_push_subscriptions").all()).toHaveLength(0);
  await f.push.stop();
  f.db.close();
});

test("completion sends one bounded preview with the thread destination", async () => {
  const sent: string[] = [];
  const f = fixture(async (_subscription, payload) => {
    sent.push(String(payload));
    return { statusCode: 201, headers: {}, body: "" };
  });
  await Promise.resolve();
  f.finish();
  await Promise.resolve();
  await f.push.stop();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toMatchObject({
    threadId: f.thread.id,
    title: "Lilac · New thread",
    body: "Done. Read the result.",
  });
  expect(f.store.notificationContent("bob", f.thread.id).isErr()).toBe(true);
  f.db.close();
});

test.each(["disabled", "viewed", "revoked"] as const)(
  "does not push %s notifications",
  async (mode) => {
    const sent: string[] = [];
    const f = fixture(async (_subscription, payload) => {
      sent.push(String(payload));
      return { statusCode: 201, headers: {}, body: "" };
    });
    await Promise.resolve();
    if (mode === "disabled")
      f.push.subscribe("alice", { ...f.subscription, completion: false }).unwrap();
    if (mode === "viewed")
      f.push
        .presence("alice", {
          threadId: f.thread.id,
          clientId: "tab",
        })
        .unwrap();
    if (mode === "revoked") f.push.subscribe("bob", f.subscription).unwrap();
    if (mode === "viewed") f.push.presence("alice", { clientId: "background-tab" }).unwrap();
    f.finish();
    await Promise.resolve();
    await f.push.stop();
    expect(sent).toHaveLength(0);
    f.db.close();
  },
);

function pendingQuestion(f: ReturnType<typeof fixture>) {
  f.store
    .projectTurn(f.thread.id, 0, "ask", f.receipt.turnId!, (slot) =>
      Result.ok({
        slot: {
          ...slot,
          messages: [
            ...slot.messages,
            {
              id: "question",
              role: "assistant",
              parts: [
                {
                  type: "data-question",
                  id: "question-part",
                  data: {
                    questionCallId: "q1",
                    respondentId: "alice",
                    historyGeneration: 0,
                    view: { state: "pending" },
                  },
                },
              ],
            },
          ] as typeof slot.messages,
        },
        changes: [],
      }),
    )
    .unwrap();
}

test("a question during a live run pushes once, and the run's completion still pushes", async () => {
  const sent: string[] = [];
  const f = fixture(async (_subscription, payload) => {
    sent.push(String(payload));
    return { statusCode: 201, headers: {}, body: "" };
  });
  await Promise.resolve();
  pendingQuestion(f);
  await Promise.resolve();
  expect(f.store.getThread("alice", f.thread.id).unwrap().waitingOn).toBe("input");
  expect(sent.map((payload) => JSON.parse(payload).body)).toEqual(["Needs your input"]);

  f.store.notifyDisplayChanged(f.thread.id);
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  await f.push.stop();
});

test("a question left pending when the run ends pushes once, not again as a completion", async () => {
  const sent: string[] = [];
  const f = fixture(async (_subscription, payload) => {
    sent.push(String(payload));
    return { statusCode: 201, headers: {}, body: "" };
  });
  await Promise.resolve();
  pendingQuestion(f);
  await Promise.resolve();
  f.store.setActiveRun(f.thread.id, 0).unwrap();
  await Promise.resolve();
  expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("input");
  expect(sent).toHaveLength(1);
  await f.push.stop();
});

test("expired subscriptions are removed", async () => {
  const f = fixture(async () => {
    throw new WebPushError("gone", 410, {}, "", "https://fcm.googleapis.com/x");
  });
  await Promise.resolve();
  f.finish("failed");
  await Promise.resolve();
  await f.push.stop();
  expect(f.db.query("SELECT endpoint FROM native_push_subscriptions").all()).toHaveLength(0);
  f.db.close();
});

for (const state of ["complete", "failed"] as const) {
  test.each(["focused", "other-thread", "other-user", "cleared", "expired"] as const)(
    `${state} push across devices with %s presence`,
    async (mode) => {
      const sent: string[] = [];
      const f = fixture(async (subscription) => {
        sent.push(subscription.endpoint);
        return { statusCode: 201, headers: {}, body: "" };
      });
      const secondDevice = {
        ...f.subscription,
        endpoint: "https://fcm.googleapis.com/fcm/send/second-device",
      };
      f.push.subscribe("alice", secondDevice).unwrap();
      await Promise.resolve();
      const userId = mode === "other-user" ? "bob" : "alice";
      const threadId =
        mode === "other-thread"
          ? f.store.createThread("alice", { commandId: "other" }).unwrap().id
          : f.thread.id;
      f.push.presence(userId, { threadId, clientId: "focused-tab" }).unwrap();
      f.push.presence(userId, { clientId: "background-tab" }).unwrap();
      f.push.presence(userId === "alice" ? "bob" : "alice", { clientId: "focused-tab" }).unwrap();
      if (mode === "cleared") f.push.presence(userId, { clientId: "focused-tab" }).unwrap();
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now + (mode === "expired" ? 60_001 : 0));
      f.finish(state);
      await Promise.resolve();
      clock.mockRestore();
      await f.push.stop();
      expect(sent.sort()).toEqual(
        mode === "focused" ? [] : [f.subscription.endpoint, secondDevice.endpoint].sort(),
      );
      f.db.close();
    },
  );
}

test("enabling push during a run delivers its completion", async () => {
  const f = fixture();
  await f.push.stop();
  f.push.unsubscribe("alice", f.subscription.endpoint).unwrap();
  const sent: string[] = [];
  const push = new NativePush(f.db, f.store, async (_subscription, payload) => {
    sent.push(String(payload));
    return { statusCode: 201, headers: {}, body: "" };
  });
  push.start();
  push.subscribe("alice", f.subscription).unwrap();
  f.finish();
  await Promise.resolve();
  await push.stop();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!).threadId).toBe(f.thread.id);
  f.db.close();
});

for (const mode of ["notify", "silent", "viewed", "disabled"] as const) {
  test(`surface post without a run respects notification policy: ${mode}`, async () => {
    const sent: string[] = [];
    const f = fixture(async (_subscription, payload) => {
      sent.push(String(payload));
      return { statusCode: 201, headers: {}, body: "" };
    });
    const target = f.store.ensureDirectThread("alice").unwrap();
    const surface = new NativeSurfaceStore(f.db, f.store);
    surface.initialize().unwrap();
    const kicks: string[] = [];
    const adapter = new NativeSurfaceAdapter({
      store: f.store,
      surface,
      shouldTriggerRun: () => true,
      kick: (id) => {
        kicks.push(id);
      },
      notifyPostedMessage: (id) => f.push.posted(id),
    }).forRequest({ principalId: "alice", sourceThreadId: f.thread.id });
    if (mode === "viewed")
      f.push.presence("alice", { threadId: target.id, clientId: "view" }).unwrap();
    if (mode === "disabled")
      f.push.subscribe("alice", { ...f.subscription, completion: false }).unwrap();
    (
      await adapter.sendMsg(
        { platform: "native", channelId: target.id },
        { text: "Notification without a run" },
        { suppressRun: true, silent: mode === "silent" },
      )
    ).unwrap();
    await f.push.stop();
    expect(kicks).toEqual([]);
    expect(f.store.listPendingInputs(target.id).unwrap()).toEqual([]);
    expect(sent).toHaveLength(mode === "notify" ? 1 : 0);
    if (mode === "notify")
      expect(JSON.parse(sent[0]!)).toMatchObject({
        threadId: target.id,
        body: "Notification without a run",
      });
    f.db.close();
  });
}

test("a disconnected viewer no longer suppresses push on another device", async () => {
  let sent = 0;
  const f = fixture(async () => {
    sent++;
    return { statusCode: 201, headers: {}, body: "" };
  });
  const connection = new AbortController();
  f.push
    .presence("alice", { clientId: "phone", threadId: f.thread.id }, connection.signal)
    .unwrap();
  f.push.posted(f.thread.id);
  expect(sent).toBe(0);
  connection.abort();
  f.push.posted(f.thread.id);
  await f.push.stop();
  expect(sent).toBe(1);
  f.db.close();
});

test("an old socket cannot clear or restore presence after reconnect", async () => {
  let sent = 0;
  const f = fixture(async () => {
    sent++;
    return { statusCode: 201, headers: {}, body: "" };
  });
  const old = new AbortController();
  const current = new AbortController();
  const input = { clientId: "phone", threadId: f.thread.id };
  f.push.presence("alice", input, old.signal).unwrap();
  f.push.presence("alice", input, current.signal).unwrap();
  old.abort();
  f.push.presence("alice", { clientId: "phone" }, old.signal).unwrap();
  f.push.posted(f.thread.id);
  expect(sent).toBe(0);
  current.abort();
  f.push.presence("alice", input, old.signal).unwrap();
  f.push.posted(f.thread.id);
  await f.push.stop();
  expect(sent).toBe(1);
  f.db.close();
});

const primaryEndpoint = "https://fcm.googleapis.com/fcm/send/device";
const primaryDeviceId = createHash("sha256").update(primaryEndpoint).digest("hex");
const secondaryEndpoint = "https://fcm.googleapis.com/fcm/send/second";

function escalationClock() {
  const callbacks: Array<() => void> = [];
  const original = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(
    Object.assign((...args: Parameters<typeof setTimeout>) => {
      const [callback, delay] = args;
      if (delay === PUSH_ESCALATION_MS) callbacks.push(() => callback());
      return original(...args);
    }, original),
  );
  return {
    callbacks,
    [Symbol.dispose]() {
      timer.mockRestore();
    },
  };
}

function stagedFixture(send?: typeof sendNotification, deviceId = primaryDeviceId) {
  const sent: string[] = [];
  const f = fixture(
    send ??
      (async (subscription) => {
        sent.push(subscription.endpoint);
        return { statusCode: 201, headers: {}, body: "" };
      }),
    deviceId,
  );
  f.push.subscribe("alice", { ...f.subscription, endpoint: secondaryEndpoint }).unwrap();
  return { ...f, sent };
}

test("completion pushes the initiating device first and escalates once after 60 seconds", async () => {
  using clock = escalationClock();
  const f = stagedFixture();
  await Promise.resolve();
  f.finish();
  await Promise.resolve();
  expect(PUSH_ESCALATION_MS).toBe(60_000);
  expect(f.sent).toEqual([primaryEndpoint]);
  expect(clock.callbacks).toHaveLength(1);
  clock.callbacks[0]!();
  expect(f.sent).toEqual([primaryEndpoint, secondaryEndpoint]);
  clock.callbacks[0]!();
  expect(f.sent).toHaveLength(2);
  await f.push.stop();
  f.db.close();
});

for (const mode of [
  "read",
  "working",
  "archived",
  "revoked",
  "reassigned",
  "viewing",
  "disabled",
  "unsubscribed",
  "generation",
  "stopped",
] as const) {
  test(`delayed push rechecks ${mode} before delivery`, async () => {
    using clock = escalationClock();
    const f = stagedFixture();
    await Promise.resolve();
    f.finish();
    await Promise.resolve();
    expect(f.sent).toEqual([primaryEndpoint]);
    const fire = clock.callbacks[0]!;
    if (mode === "read") {
      const surface = new NativeSurfaceStore(f.db, f.store);
      surface.initialize().unwrap();
      surface.markTurnRead("alice", f.thread.id, f.receipt.turnId!).unwrap();
    }
    if (mode === "working") f.store.setActiveRun(f.thread.id, 0, "next-run").unwrap();
    if (mode === "archived" || mode === "generation") {
      const field = mode === "archived" ? "archived" : "historyGeneration";
      f.db
        .query(
          `UPDATE native_records SET data_json=json_set(data_json,'$.value.${field}',json(?)) WHERE kind='thread' AND id=?`,
        )
        .run(mode === "archived" ? "true" : "1", f.thread.id);
    }
    if (mode === "revoked")
      f.db
        .query(
          "UPDATE native_records SET data_json=json_set(data_json,'$.value.starterId','bob') WHERE kind='thread' AND id=?",
        )
        .run(f.thread.id);
    if (mode === "reassigned")
      f.push.subscribe("bob", { ...f.subscription, endpoint: secondaryEndpoint }).unwrap();
    if (mode === "viewing")
      f.push.presence("alice", { threadId: f.thread.id, clientId: "reader" }).unwrap();
    if (mode === "disabled")
      f.push
        .subscribe("alice", { ...f.subscription, endpoint: secondaryEndpoint, completion: false })
        .unwrap();
    if (mode === "unsubscribed") f.push.unsubscribe("alice", secondaryEndpoint).unwrap();
    if (mode === "stopped") await f.push.stop();
    fire();
    expect(f.sent).toEqual([primaryEndpoint]);
    await f.push.stop();
    f.db.close();
  });
}

for (const mode of ["unknown", "disabled", "missing", "failure"] as const) {
  test(`completion fallback for ${mode} origin preserves immediate broadcast`, async () => {
    using clock = escalationClock();
    const f = stagedFixture(undefined, mode === "unknown" ? "0".repeat(64) : primaryDeviceId);
    if (mode === "disabled")
      f.push.subscribe("alice", { ...f.subscription, completion: false }).unwrap();
    if (mode === "missing") f.push.unsubscribe("alice", primaryEndpoint).unwrap();
    await Promise.resolve();
    f.finish(mode === "failure" ? "failed" : "complete");
    await Promise.resolve();
    expect(f.sent.sort()).toEqual(
      mode === "disabled" || mode === "missing"
        ? [secondaryEndpoint]
        : [primaryEndpoint, secondaryEndpoint].sort(),
    );
    expect(clock.callbacks).toHaveLength(0);
    await f.push.stop();
    f.db.close();
  });
}

test("a rejected primary push falls back immediately without waiting for escalation", async () => {
  using clock = escalationClock();
  const sent: string[] = [];
  const fallback = Promise.withResolvers<void>();
  const f = stagedFixture(async (subscription) => {
    sent.push(subscription.endpoint);
    if (subscription.endpoint === primaryEndpoint)
      throw new WebPushError("gone", 410, {}, "", primaryEndpoint);
    fallback.resolve();
    return { statusCode: 201, headers: {}, body: "" };
  });
  await Promise.resolve();
  f.finish();
  await fallback.promise;
  expect(sent).toEqual([primaryEndpoint, secondaryEndpoint]);
  clock.callbacks[0]!();
  expect(sent).toHaveLength(2);
  expect(
    f.db
      .query("SELECT endpoint FROM native_push_subscriptions WHERE endpoint=?")
      .get(primaryEndpoint),
  ).toBeNull();
  await f.push.stop();
  f.db.close();
});

test("origin survives a store reopen and schema 4 upgrades without rewriting inputs", async () => {
  const f = stagedFixture();
  const original = f.store.getInput(f.receipt.inputId).unwrap();
  expect(original.deviceId).toBe(primaryDeviceId);
  f.db.run("PRAGMA user_version = 4");
  const reopened = new NativeStore(f.db);
  reopened.initialize().unwrap();
  expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  expect(reopened.getInput(f.receipt.inputId).unwrap()).toEqual(original);
  expect(reopened.notificationOrigin("alice", f.thread.id).unwrap()).toMatchObject({
    deviceId: primaryDeviceId,
    turnId: f.receipt.turnId,
    userId: "alice",
  });
  expect(reopened.notificationOrigin("bob", f.thread.id).isErr()).toBe(true);
  await f.push.stop();
  f.db.close();
});

test("an old timer cannot notify a newer completed turn or resend its primary push", async () => {
  using clock = escalationClock();
  const f = stagedFixture();
  await Promise.resolve();
  f.finish();
  await Promise.resolve();
  const first = clock.callbacks[0]!;
  f.store.settleInput(f.receipt.inputId, "admitted").unwrap();
  f.store.markInputCompleted(f.receipt.inputId).unwrap();
  const next = f.store
    .acceptInput("alice", {
      threadId: f.thread.id,
      commandId: "next",
      historyGeneration: 0,
      text: "Next",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
      deviceId: primaryDeviceId,
    })
    .unwrap();
  f.store.setActiveRun(f.thread.id, 0, "next").unwrap();
  await Promise.resolve();
  f.store
    .projectTurn(f.thread.id, 0, "next-complete", next.turnId!, (slot) =>
      Result.ok({
        slot: {
          ...slot,
          state: "complete",
          messages: [
            ...slot.messages,
            { id: "next-reply", role: "assistant", parts: [{ type: "text", text: "Next done" }] },
          ],
        },
        changes: [],
      }),
    )
    .unwrap();
  f.store.setActiveRun(f.thread.id, 0).unwrap();
  await Promise.resolve();
  expect(f.sent).toEqual([primaryEndpoint, primaryEndpoint]);
  expect(clock.callbacks).toHaveLength(2);
  first();
  expect(f.sent).toHaveLength(2);
  clock.callbacks[1]!();
  expect(f.sent).toEqual([primaryEndpoint, primaryEndpoint, secondaryEndpoint]);
  await f.push.stop();
  f.db.close();
});

test("steering from another device does not replace the turn's originating device", async () => {
  using clock = escalationClock();
  const f = stagedFixture();
  f.store
    .setActiveRun(f.thread.id, 0, f.store.getInput(f.receipt.inputId).unwrap().requestId)
    .unwrap();
  f.store
    .acceptInput("alice", {
      threadId: f.thread.id,
      commandId: "steer",
      historyGeneration: 0,
      text: "Also check this",
      mode: "steer",
      attachmentIds: [],
      skillIds: [],
      deviceId: createHash("sha256").update(secondaryEndpoint).digest("hex"),
    })
    .unwrap();
  await Promise.resolve();
  f.finish();
  await Promise.resolve();
  expect(f.sent).toEqual([primaryEndpoint]);
  await f.push.stop();
  f.db.close();
});

test("schema 4 inputs without device identity remain readable after upgrade", async () => {
  const f = fixture();
  const original = f.store.getInput(f.receipt.inputId).unwrap();
  expect(original.deviceId).toBeUndefined();
  f.db.run("PRAGMA user_version = 4");
  const reopened = new NativeStore(f.db);
  reopened.initialize().unwrap();
  expect(reopened.getInput(f.receipt.inputId).unwrap()).toEqual(original);
  await f.push.stop();
  f.db.close();
});
