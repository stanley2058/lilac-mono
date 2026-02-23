import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { createLilacBus, createRedisStreamsBus, lilacEventTypes, outReqTopic } from "../index";
import { env } from "@stanley2058/lilac-utils";
import type { ModelMessage } from "ai";

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

describe("RedisStreamsBus", () => {
  it("does not block publish while a tail subscription is blocked", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("hol")}`;
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      ownsRedis: true,
      subscriberPool: { max: 4, warm: 2 },
    });

    const topicA = "topic-a";
    const topicB = "topic-b";

    const sub = await raw.subscribe(
      topicA,
      { mode: "tail", offset: { type: "now" }, batch: { maxWaitMs: 2000 } },
      async () => {},
    );

    // Give the subscription loop a moment to enter XREAD BLOCK.
    await new Promise((r) => setTimeout(r, 50));

    const startedAt = Date.now();
    await raw.publish(
      { topic: topicB, type: "test.publish", data: { ok: true } },
      { topic: topicB, type: "test.publish" },
    );
    const publishMs = Date.now() - startedAt;

    // On the old single-connection implementation, this would be ~BLOCK ms.
    expect(publishMs).toBeLessThan(600);

    await sub.stop();
    await raw.close();
  });

  it("stop() interrupts a blocking XREAD promptly", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("stop")}`;
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      ownsRedis: true,
      subscriberPool: { max: 2, warm: 1 },
    });

    const topic = "topic";

    const sub = await raw.subscribe(
      topic,
      { mode: "tail", offset: { type: "now" }, batch: { maxWaitMs: 5000 } },
      async () => {},
    );

    await new Promise((r) => setTimeout(r, 50));

    const startedAt = Date.now();
    await sub.stop();
    const stopMs = Date.now() - startedAt;

    expect(stopMs).toBeLessThan(600);
    await raw.close();
  });

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

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "hello",
        seq: 1,
      },
      { headers: { request_id: requestId } },
    );

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

    const received: Array<{
      status: string;
      display: string;
    }> = [];

    let sub: { stop(): Promise<void> } | undefined;
    sub = await bus.subscribeTopic(
      topic,
      { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
      async (msg) => {
        if (msg.type === lilacEventTypes.EvtAgentOutputToolCall) {
          received.push({
            status: msg.data.status,
            display: msg.data.display,
          });
          if (received.length >= 2) await sub?.stop();
        }
      },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "call-1",
        status: "start",
        display: "[bash] ls -al",
      },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "call-1",
        status: "end",
        display: "[bash] ls -al",
        ok: true,
      },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([
      { status: "start", display: "[bash] ls -al" },
      { status: "end", display: "[bash] ls -al" },
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

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: { request_id: requestId },
      },
    );

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

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "a",
        seq: 1,
      },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "b",
        seq: 2,
      },
      { headers: { request_id: requestId } },
    );

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

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "ping" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "unknown",
        },
      },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toBe(1);

    await bus.close();
  });

  it("serializes complex objects with URLs and non-standard types using superjson", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("superjson")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");

    // Create complex object with URL and special types
    const complexData = {
      queue: "prompt" as const,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Check out https://example.com/path?query=value",
            },
            {
              type: "file",
              data: new URL("https://example.com/example.pdf"),
              mediaType: "application/pdf",
            },
          ],
        },
      ] satisfies ModelMessage[],
      raw: {
        url: new URL("https://example.com/api"),
        date: new Date(),
        nested: {
          innerUrl: "https://nested.example.com",
        },
      },
    };

    let received: unknown;

    let sub: { stop(): Promise<void> } | undefined;
    sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: "test-agent",
        consumerId: "instance-1",
        offset: { type: "begin" },
        batch: { maxWaitMs: 250 },
      },
      async (msg, ctx) => {
        if (msg.type === lilacEventTypes.CmdRequestMessage) {
          received = msg.data;
        }
        await ctx.commit();
        await sub?.stop();
      },
    );

    await bus.publish(lilacEventTypes.CmdRequestMessage, complexData, {
      headers: { request_id: requestId },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual(complexData);
    await bus.close();
  });

  it("keeps work subscription loop alive after handler error", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("work-loop")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    let calls = 0;
    let deliveredAfterError = false;

    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId: "agent-service-loop",
        consumerId: "instance-1",
        offset: { type: "begin" },
        batch: { maxWaitMs: 250 },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.CmdRequestMessage) return;

        calls += 1;
        if (calls === 1) {
          throw new Error("boom");
        }

        deliveredAfterError = true;
        await ctx.commit();
      },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "first" }],
      },
      {
        headers: {
          request_id: randomId("req"),
          session_id: "chan",
          request_client: "unknown",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "second" }],
      },
      {
        headers: {
          request_id: randomId("req"),
          session_id: "chan",
          request_client: "unknown",
        },
      },
    );

    await new Promise((r) => setTimeout(r, 120));

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(deliveredAfterError).toBe(true);

    await sub.stop();
    await bus.close();
  });
});
