import { describe, expect, it } from "bun:test";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import {
  createLilacBus,
  lilacEventTypes,
  type CmdRequestMessageData,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { startHeartbeatService } from "../../src/heartbeat/heartbeat-service";
import { getHeartbeatQuietState } from "../../src/heartbeat/common";

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${Math.random()}`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const sub of subs) {
        if (sub.topic !== opts.topic) continue;
        await sub.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },
    subscribe: async <TData>(
      topic: string,
      _opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);
      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },
    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((msg) => ({ msg: msg as Message<TData>, cursor: msg.id })),
        next: existing.at(-1)?.id,
      };
    },
    close: async () => {},
  };
}

function createFakeTimers() {
  let nextId = 1;
  const timeouts = new Map<number, { ms: number; fn: () => void }>();
  const intervals = new Map<number, { ms: number; fn: () => void }>();

  return {
    timeouts,
    intervals,
    timers: {
      setInterval(fn: () => void, ms: number) {
        const id = nextId++;
        intervals.set(id, { ms, fn });
        return id as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval(handle: ReturnType<typeof setInterval>) {
        intervals.delete(handle as unknown as number);
      },
      setTimeout(fn: () => void, ms: number) {
        const id = nextId++;
        timeouts.set(id, { ms, fn });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout(handle: ReturnType<typeof setTimeout>) {
        timeouts.delete(handle as unknown as number);
      },
    },
  };
}

describe("heartbeat service", () => {
  it("falls back gracefully when quiet-hours timezone is invalid", () => {
    const quietState = getHeartbeatQuietState({
      nowMs: Date.UTC(2026, 2, 11, 10, 0, 0),
      quietHours: {
        start: "23:00",
        end: "08:00",
        timezone: "Asia/Taipai",
      },
    });

    expect(quietState.label).toBe("outside");
  });

  it("publishes an internal heartbeat request when idle", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];

    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "hb-test-requests",
        consumerId: "hb-test-requests",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.CmdRequestMessage) {
          requests.push(msg);
        }
        await ctx.commit();
      },
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          every: "30m",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await service.tick("interval");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers?.session_id).toBe("__heartbeat__");
    expect(requests[0]?.data.runPolicy).toBe("idle_only_global");
    expect(requests[0]?.data.origin).toEqual({ kind: "heartbeat", reason: "interval" });
    expect(requests[0]?.data.messages[0]).toEqual({
      role: "user",
      content: expect.stringContaining("Last observed activity: none recorded."),
    });
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Normal assistant output is discarded.",
    );
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Default proactive output session: none configured; do not guess a destination.",
    );
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "When you are done, reply exactly HEARTBEAT_OK.",
    );

    await service.stop();
    await sub.stop();
  });

  it("includes configured default output session in the heartbeat prompt", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];

    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "hb-test-requests",
        consumerId: "hb-test-requests",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.CmdRequestMessage) {
          requests.push(msg);
        }
        await ctx.commit();
      },
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          defaultOutputSession: "discord/ops",
          every: "30m",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
    });

    await service.tick("interval");

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Default proactive output target: client=discord, session=ops.",
    );

    await service.stop();
    await sub.stop();
  });

  it("suppresses while busy and retries later", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];
    const fakeTimers = createFakeTimers();
    let nowMs = Date.UTC(2026, 2, 11, 10, 0, 0);

    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "hb-test-requests",
        consumerId: "hb-test-requests",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.CmdRequestMessage) {
          requests.push(msg);
        }
        await ctx.commit();
      },
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          every: "30m",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => nowMs,
      timers: fakeTimers.timers,
    });

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: nowMs },
      {
        headers: {
          request_id: "req:1",
          session_id: "discord-session",
          request_client: "discord",
        },
      },
    );

    await service.tick("interval");

    expect(requests).toHaveLength(0);
    expect([...fakeTimers.timeouts.values()].map((entry) => entry.ms)).toEqual([60000]);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: nowMs },
      {
        headers: {
          request_id: "req:1",
          session_id: "discord-session",
          request_client: "discord",
        },
      },
    );

    nowMs += 300001;
    const retry = [...fakeTimers.timeouts.values()][0];
    retry?.fn();
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.data.origin).toEqual({ kind: "heartbeat", reason: "retry" });
    expect(String(requests[0]?.data.messages[0]?.content)).toContain(
      "Last observed activity: 2026-03-11T10:00:00.000Z (5m ago).",
    );

    await service.stop();
    await sub.stop();
  });

  it("coalesces concurrent ticks into a single heartbeat request", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const requests: Array<Message<CmdRequestMessageData>> = [];
    const fakeTimers = createFakeTimers();

    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "hb-test-requests",
        consumerId: "hb-test-requests",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.CmdRequestMessage) {
          requests.push(msg);
        }
        await ctx.commit();
      },
    );

    const cfg = {
      surface: {
        heartbeat: {
          enabled: true,
          every: "30m",
          quietAfterActivityMs: 300000,
          retryBusyMs: 60000,
        },
      },
    } as unknown as CoreConfig;

    const service = await startHeartbeatService({
      bus,
      subscriptionId: "hb-test",
      config: cfg,
      now: () => Date.UTC(2026, 2, 11, 10, 0, 0),
      timers: fakeTimers.timers,
    });

    const [first, second] = await Promise.all([service.tick("interval"), service.tick("retry")]);
    void first;
    void second;

    expect(requests).toHaveLength(1);

    await service.stop();
    await sub.stop();
  });
});
