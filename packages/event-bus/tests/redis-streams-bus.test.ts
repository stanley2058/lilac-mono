import { describe, expect, it } from "bun:test";
import Redis from "ioredis";

import {
  createLilacBus,
  createRedisStreamsBus,
  lilacEventTypes,
  outReqTopic,
} from "../index";

const TEST_REDIS_URL = "redis://127.0.0.1:6379";
// TODO: make this configurable (env var / config layer).

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

describe("RedisStreamsBus", () => {
  it("publishes and tails output stream events", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("tail")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");
    const topic = outReqTopic(requestId);

    const received: string[] = [];

    let sub: { stop(): Promise<void> } | undefined;
    sub = await bus.subscribeTopic(
      topic,
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
      async (msg) => {
        if (msg.type === lilacEventTypes.EvtAgentOutputDeltaText) {
          received.push(msg.data.delta);
        }
        await sub?.stop();
      },
    );

    await bus.publish(lilacEventTypes.EvtAgentOutputDeltaText, {
      requestId,
      delta: "hello",
      seq: 1,
    });

    // Wait a tick for the subscriber to receive.
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(["hello"]);
    await bus.close();
  });

  it("publishes tool-call progress events on the output stream", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("toolcall")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");
    const topic = outReqTopic(requestId);

    const received: Array<{ status: string; toolName: string; display: string }> = [];

    let sub: { stop(): Promise<void> } | undefined;
    sub = await bus.subscribeTopic(
      topic,
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
      async (msg) => {
        if (msg.type === lilacEventTypes.EvtAgentOutputToolCall) {
          received.push({
            status: msg.data.status,
            toolName: msg.data.toolName,
            display: msg.data.display,
          });
          if (received.length >= 2) await sub?.stop();
        }
      },
    );

    await bus.publish(lilacEventTypes.EvtAgentOutputToolCall, {
      requestId,
      status: "start",
      toolName: "bash",
      display: "[bash] ls -al",
    });

    await bus.publish(lilacEventTypes.EvtAgentOutputToolCall, {
      requestId,
      status: "end",
      toolName: "bash",
      display: "[bash] ls -al",
      ok: true,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([
      { status: "start", toolName: "bash", display: "[bash] ls -al" },
      { status: "end", toolName: "bash", display: "[bash] ls -al" },
    ]);

    await bus.close();
  });

  it("fans out evt.request to different subscriptionIds", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("fanout")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");

    let aCount = 0;
    let bCount = 0;

    const subA = await bus.subscribeTopic(
      "evt.request",
      {
        mode: "fanout",
        subscriptionId: "adapter-a",
        consumerId: "a",
        offset: { type: "now" },
        batch: { maxWaitMs: 250 },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.EvtRequestReply) {
          aCount++;
        }
        await ctx.commit();
      },
    );

    const subB = await bus.subscribeTopic(
      "evt.request",
      {
        mode: "fanout",
        subscriptionId: "adapter-b",
        consumerId: "b",
        offset: { type: "now" },
        batch: { maxWaitMs: 250 },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.EvtRequestReply) {
          bCount++;
        }
        await ctx.commit();
      },
    );

    await bus.publish(lilacEventTypes.EvtRequestReply, {
      requestId,
      outputTopic: outReqTopic(requestId),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(aCount).toBe(1);
    expect(bCount).toBe(1);

    await subA.stop();
    await subB.stop();
    await bus.close();
  });

  it("supports cursor resume in tail mode", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("cursor")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");
    const topic = outReqTopic(requestId);

    await bus.publish(lilacEventTypes.EvtAgentOutputDeltaText, {
      requestId,
      delta: "a",
      seq: 1,
    });
    await bus.publish(lilacEventTypes.EvtAgentOutputDeltaText, {
      requestId,
      delta: "b",
      seq: 2,
    });

    const first = await bus.fetchTopic(topic, {
      offset: { type: "begin" },
      limit: 1,
    });

    expect(first.messages.length).toBe(1);
    const cursor = first.messages[0]!.cursor;

    const received: string[] = [];

    let sub: { stop(): Promise<void> } | undefined;
    sub = await bus.subscribeTopic(
      topic,
      {
        mode: "tail",
        offset: { type: "cursor", cursor },
        batch: { maxWaitMs: 250 },
      },
      async (msg) => {
        if (msg.type === lilacEventTypes.EvtAgentOutputDeltaText) {
          received.push(msg.data.delta);
        }
        await sub?.stop();
      },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["b"]);

    await bus.close();
  });

  it("delivers cmd.request.message in work mode", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("work")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");

    let received = 0;

    let sub: { stop(): Promise<void> } | undefined;
    sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: "agent-service",
        consumerId: "instance-1",
        offset: { type: "begin" },
        batch: { maxWaitMs: 250 },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.CmdRequestMessage) {
          received++;
        }
        await ctx.commit();
        await sub?.stop();
      },
    );

    await bus.publish(lilacEventTypes.CmdRequestMessage, {
      requestId,
      platform: "unknown",
      channelId: "chan",
      userId: "user",
      text: "ping",
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(1);

    await bus.close();
  });
});
