import { describe, expect, it, spyOn } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";
import Redis from "ioredis";
import SuperJSON from "superjson";
import { env } from "@stanley2058/lilac-utils";

import {
  computeCoreLineagePrefixDigestV2,
  createLilacBus,
  createRedisStreamsBus,
  type EventDeliveryStopFailed,
  EventHandlerFailed,
  EventPostCommitObservationFailed,
  lilacEventTypes,
  MANAGED_REDIS_HEARTBEAT_MS,
  managedRedisDeliveryId,
  managedRedisGroupId,
  managedRedisPhysicalGroup,
  outReqTopic,
  REQUEST_PUBLICATION_CLAIM_TTL_MS,
  RedisEventDeadLetter,
  type CoreLineageAtomV2,
  type CoreLineageManifestV2,
  type BusMessageV2,
  type DecodedMessage,
  type RawMessageDecodeOutcome,
  type RedisMessageDecodeFailure,
} from "../index";
import { RedisConnectionPool } from "../redis-connection-pool";
import { COMMIT_SCRIPT, HEARTBEAT_SCRIPT } from "../redis-managed-delivery/lua";

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function requireOk<TValue, TError>(result: ResultType<TValue, TError>): TValue {
  if (result.status === "error") throw result.error;
  return result.value;
}

async function eventually<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (predicate(value)) return value;
  }
  throw new Error("Observable Redis state did not converge before the test deadline");
}

async function pendingCount(redis: Redis, streamKey: string, group: string): Promise<number> {
  const summary = (await redis.xpending(streamKey, group)) as unknown;
  if (!Array.isArray(summary) || typeof summary[0] !== "number") {
    throw new Error("Redis returned an invalid pending summary");
  }
  return summary[0];
}

function requireDecodedMessage(message: RawMessageDecodeOutcome): DecodedMessage<unknown> {
  if (!("_tag" in message)) return message;
  throw new Error(`Expected a decoded message, received ${message._tag}`);
}

function requireDecodeFailure(message: RawMessageDecodeOutcome): RedisMessageDecodeFailure {
  if ("_tag" in message) return message;
  throw new Error("Expected a Redis message decode failure");
}

function subscriberPoolStats(raw: ReturnType<typeof createRedisStreamsBus>) {
  const pool = Reflect.get(raw, "subPool");
  if (!(pool instanceof RedisConnectionPool))
    throw new Error("Redis subscriber pool is unavailable");
  return pool.stats();
}

function consumerGroupNames(groups: unknown): readonly string[] {
  if (!Array.isArray(groups)) throw new Error("Redis consumer groups response is invalid");
  return groups.flatMap((group) => {
    if (!Array.isArray(group)) return [];
    const nameIndex = group.indexOf("name");
    const name = group[nameIndex + 1];
    return typeof name === "string" ? [name] : [];
  });
}

function ephemeralGroupNames(groups: unknown): readonly string[] {
  return consumerGroupNames(groups).filter((group) => group.startsWith("__lilac_ephemeral__:"));
}

function observeSubscriberRead(redis: Redis): Promise<void> {
  const started = Promise.withResolvers<void>();
  const duplicate = redis.duplicate.bind(redis);
  Reflect.set(redis, "duplicate", () => {
    const subscriber = duplicate();
    const xread = Reflect.get(subscriber, "xread");
    Reflect.set(subscriber, "xread", (...args: unknown[]) => {
      const result = Reflect.apply(xread, subscriber, args);
      started.resolve();
      return result;
    });
    return subscriber;
  });
  return started.promise;
}

function testDeadLetter(redis: Redis, keyPrefix: string): RedisEventDeadLetter {
  return new RedisEventDeadLetter({
    redis,
    encryptionKey: Buffer.alloc(32, 7),
    keyPrefix: `${keyPrefix}:dead-letter`,
  });
}

function controlManagedHeartbeatTimers(): {
  next(): Promise<() => void>;
  restore(): void;
} {
  const callbacks: Array<() => void> = [];
  const waiters: Array<ReturnType<typeof Promise.withResolvers<() => void>>> = [];
  const nativeSetTimeout = globalThis.setTimeout;
  const controlledSetTimeout = Object.assign(
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== MANAGED_REDIS_HEARTBEAT_MS) {
        return nativeSetTimeout(callback, delay, ...args);
      }
      const scheduled = () => callback(...args);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(scheduled);
      else callbacks.push(scheduled);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    },
    { __promisify__: nativeSetTimeout.__promisify__ },
  );
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(
    controlledSetTimeout as typeof setTimeout,
  );
  return {
    next: () => {
      const callback = callbacks.shift();
      if (callback) return Promise.resolve(callback);
      const waiter = Promise.withResolvers<() => void>();
      waiters.push(waiter);
      return waiter.promise;
    },
    restore: () => timerSpy.mockRestore(),
  };
}

describe("RedisStreamsBus", () => {
  it("ignores pending entries in a preexisting unversioned group", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("pending-start-observability")}`;
    const streamKey = `${keyPrefix}:topic`;
    const subscriptionId = "pending-start-observability";
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const id = await redis.xadd(streamKey, "*", "type", "test", "ts", "1", "data", "null");
    if (typeof id !== "string") throw new Error("Redis did not return an entry id");
    await redis.xgroup("CREATE", streamKey, subscriptionId, "0-0");
    await redis.xreadgroup("GROUP", subscriptionId, "abandoned", "STREAMS", streamKey, ">");

    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const logger = Reflect.get(raw, "logger") as {
      warn(event: string, context: Record<string, unknown>): void;
    };
    const warnings: Array<{ event: string; context: Record<string, unknown> }> = [];
    const warn = spyOn(logger, "warn").mockImplementation((event, context) => {
      warnings.push({ event, context });
    });
    try {
      const subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId,
            consumerId: "replacement",
            batch: { maxWaitMs: 50 },
          },
          async () => ({ disposition: "commit" }),
        ),
      );
      expect(await pendingCount(redis, streamKey, subscriptionId)).toBe(1);
      expect(await pendingCount(redis, streamKey, physicalGroup)).toBe(0);
      expect(warnings).toEqual([]);
      requireOk(await subscription.stop());
    } finally {
      warn.mockRestore();
      await raw.close();
      await redis.del(streamKey);
      redis.disconnect();
    }
  });

  it("warns with aggregate PEL health when a delivery is parked", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("pending-park-observability")}`;
    const streamKey = `${keyPrefix}:topic`;
    const subscriptionId = "pending-park-observability";
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const logger = Reflect.get(raw, "logger") as {
      warn(event: string, context: Record<string, unknown>): void;
    };
    const warningObserved = Promise.withResolvers<Record<string, unknown>>();
    const warn = spyOn(logger, "warn").mockImplementation((event, context) => {
      if (event === "event_bus.pending_entries") warningObserved.resolve(context);
    });
    try {
      const subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId,
            consumerId: "consumer",
            batch: { maxWaitMs: 50 },
          },
          async () => ({ disposition: "park-pending" }),
        ),
      );
      await raw.publish(
        {
          topic: "topic",
          type: "test",
          data: { secret: "must-not-be-logged" },
        },
        {
          topic: "topic",
          type: "test",
          headers: { request_id: "private-request" },
        },
      );
      expect(await warningObserved.promise).toEqual({
        topic: "topic",
        group: physicalGroup,
        trigger: "parked",
        pendingCount: 1,
        oldestPendingIdleMs: expect.any(Number),
      });
      requireOk(await subscription.stop());
    } finally {
      warn.mockRestore();
      await raw.close();
      await redis.del(streamKey);
      redis.disconnect();
    }
  });

  it("fails typed fetches for malformed XREAD stream, entry, and id responses", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const keyPrefix = `test:lilac-event-bus:${randomId("malformed-xread")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw);
    const malformedResponses: readonly unknown[] = [
      [],
      [[`${streamKey}:unexpected`, []]],
      [[streamKey, [["1-0"]]]],
      [[streamKey, [["invalid-id", []]]]],
    ];
    try {
      for (const response of malformedResponses) {
        Reflect.set(redis, "xread", async () => response);
        const fetched = await bus.fetchTopic("evt.adapter", {
          offset: { type: "begin" },
        });
        expect(fetched.status).toBe("error");
        if (fetched.status === "error") {
          expect(fetched.error._tag).toBe("EventFetchTransportFailed");
        }
      }
    } finally {
      await raw.close();
      redis.disconnect();
    }
  });

  it("fails closed for malformed watermark, XADD, XTRIM, and retirement responses", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix: `test:lilac-event-bus:${randomId("malformed-command-response")}`,
    });
    const bus = createLilacBus(raw);
    try {
      Reflect.set(redis, "xrevrange", async () => [["invalid-id", []]]);
      const watermark = await bus.getTopicWatermark("evt.adapter");
      expect(watermark.status).toBe("error");
      if (watermark.status === "error") {
        expect(watermark.error._tag).toBe("EventTopicOperationFailed");
      }

      Reflect.set(redis, "xadd", async () => "invalid-id");
      await expect(
        bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
          runId: "run-1",
          revisionId: "revision-1",
          state: "running",
          previousState: "queued",
          ts: 1,
        }),
      ).rejects.toBeInstanceOf(Panic);

      Reflect.set(redis, "eval", async () => "invalid-count");
      await expect(bus.trimTopicBeforeCheckpoint("evt.adapter", "1-0", 10)).rejects.toBeInstanceOf(
        Panic,
      );
      await expect(
        bus.retireTopicConsumerGroup("evt.adapter", "retired", true),
      ).rejects.toBeInstanceOf(Panic);
    } finally {
      await raw.close();
      redis.disconnect();
    }
  });

  it("surfaces a malformed acknowledged-prefix XTRIM response as Panic", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const keyPrefix = `test:lilac-event-bus:${randomId("malformed-acknowledged-trim")}`;
    const streamKey = `${keyPrefix}:topic`;
    Reflect.set(redis, "eval", async () => "invalid-count");
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const scheduleAcknowledgedTrim = Reflect.get(raw, "scheduleAcknowledgedTrim");
    Reflect.apply(scheduleAcknowledgedTrim, raw, ["topic", streamKey]);
    await expect(raw.flushPendingTrims()).rejects.toBeInstanceOf(Panic);
    await expect(raw.close()).rejects.toBeInstanceOf(Panic);
    redis.disconnect();
  });

  it("returns a delivery transport failure for a malformed subscription XREAD response", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const duplicate = redis.duplicate();
    const keyPrefix = `test:lilac-event-bus:${randomId("malformed-subscription-xread")}`;
    const streamKey = `${keyPrefix}:topic`;
    Reflect.set(redis, "duplicate", () => duplicate);
    Reflect.set(duplicate, "xread", async () => [[streamKey, [["invalid-id", []]]]]);
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      subscriberPool: { max: 1 },
    });
    const subscription = requireOk(
      await raw.subscribe(
        "topic",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
        async () => ({ disposition: "commit" }),
      ),
    );
    const done = await subscription.done;
    expect(done.status).toBe("error");
    if (done.status === "error") expect(done.error._tag).toBe("EventDeliveryTransportFailed");
    requireOk(await subscription.stop());
    await raw.close();
    redis.disconnect();
  });

  it("does not convert an arbitrary read rejection into cancellation after stop", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const duplicate = redis.duplicate();
    const read = Promise.withResolvers<unknown>();
    const readStarted = Promise.withResolvers<void>();
    const rejection = new Error("forced read race failure");
    let disconnected = false;
    Reflect.set(redis, "duplicate", () => duplicate);
    Reflect.set(duplicate, "xread", async () => {
      readStarted.resolve();
      return await read.promise;
    });
    Reflect.set(duplicate, "disconnect", () => {
      if (disconnected) return;
      disconnected = true;
      read.reject(rejection);
    });
    const raw = createRedisStreamsBus({ redis, subscriberPool: { max: 1 } });
    const subscription = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "tail",
          offset: { type: "begin" },
          batch: { maxWaitMs: 5_000 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );
    await readStarted.promise;
    const stopping = subscription.stop();
    const done = await subscription.done;
    expect(done.status).toBe("error");
    if (done.status === "error" && done.error._tag === "EventDeliveryTransportFailed") {
      expect(done.error.cause).toBe(rejection);
    }
    requireOk(await stopping);
    await raw.close();
    redis.disconnect();
  });

  it("releases its pooled lease when an ephemeral consumer group collides", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const subscriberRedis = redis.duplicate();
    let destroyCalls = 0;
    Reflect.set(redis, "duplicate", () => subscriberRedis);
    Reflect.set(subscriberRedis, "xgroup", async (command: string) => {
      if (command === "DESTROY") {
        destroyCalls += 1;
        return 1;
      }
      throw new Error("BUSYGROUP Consumer Group name already exists");
    });
    const raw = createRedisStreamsBus({ redis, subscriberPool: { max: 1 } });

    const subscription = await raw.subscribe(
      "topic",
      {
        mode: "work",
        subscriptionId: "colliding-ephemeral",
        ephemeral: true,
      },
      async () => ({ disposition: "commit" }),
    );

    expect(subscription.status).toBe("error");
    expect(destroyCalls).toBe(0);
    expect(subscriberPoolStats(raw).inUse).toBe(0);
    await raw.close();
    redis.disconnect();
  });

  it("removes a newly created ephemeral group when managed setup fails", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-init-rollback")}`;
    const streamKey = `${keyPrefix}:topic`;
    const duplicate = redis.duplicate.bind(redis);
    const setupFailure = new Error("managed setup failed");
    let duplicateCalls = 0;
    Reflect.set(redis, "duplicate", () => {
      duplicateCalls += 1;
      if (duplicateCalls === 2) throw setupFailure;
      return duplicate();
    });
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      subscriberPool: { max: 1 },
    });
    try {
      const subscription = await raw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "ephemeral-init-rollback",
          ephemeral: true,
        },
        async () => ({ disposition: "commit" }),
      );

      expect(subscription.status).toBe("error");
      if (subscription.status === "error") expect(subscription.error.cause).toBe(setupFailure);
      expect(ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey))).toEqual([]);
      expect(subscriberPoolStats(raw).inUse).toBe(0);
    } finally {
      await raw.close();
      await redis.del(streamKey);
      redis.disconnect();
    }
  });

  it("retries ephemeral initialization after rolling back a partial setup", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-init-retry")}`;
    const streamKey = `${keyPrefix}:topic`;
    const duplicate = redis.duplicate.bind(redis);
    let duplicateCalls = 0;
    Reflect.set(redis, "duplicate", () => {
      duplicateCalls += 1;
      if (duplicateCalls === 2) throw new Error("first managed setup failed");
      return duplicate();
    });
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      subscriberPool: { max: 1 },
    });
    try {
      const first = await raw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "ephemeral-init-retry",
          ephemeral: true,
          batch: { maxWaitMs: 50 },
        },
        async () => ({ disposition: "commit" }),
      );
      expect(first.status).toBe("error");
      expect(ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey))).toEqual([]);

      const retried = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId: "ephemeral-init-retry",
            ephemeral: true,
            batch: { maxWaitMs: 50 },
          },
          async () => ({ disposition: "commit" }),
        ),
      );
      expect(ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey))).toHaveLength(1);
      requireOk(await retried.stop());
      expect(ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey))).toEqual([]);
    } finally {
      await raw.close();
      await redis.del(streamKey);
      redis.disconnect();
    }
  });

  it("preserves an initialization Panic when ephemeral rollback also panics", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const subscriberRedis = redis.duplicate();
    const initializationPanic = new Panic({
      message: "subscription initialization invariant",
    });
    const cleanupPanic = new Panic({
      message: "subscription rollback invariant",
    });
    let duplicateCalls = 0;
    let destroyCalls = 0;
    Reflect.set(redis, "duplicate", () => {
      duplicateCalls += 1;
      if (duplicateCalls === 2) throw initializationPanic;
      return subscriberRedis;
    });
    Reflect.set(subscriberRedis, "xgroup", async (command: string) => {
      if (command === "CREATE") return "OK";
      destroyCalls += 1;
      throw cleanupPanic;
    });
    const raw = createRedisStreamsBus({ redis, subscriberPool: { max: 1 } });
    let caught: unknown;

    try {
      await raw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "panicking-initialization",
          ephemeral: true,
        },
        async () => ({ disposition: "commit" }),
      );
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBe(initializationPanic);
    expect(destroyCalls).toBe(1);
    expect(subscriberPoolStats(raw).inUse).toBe(0);
    await raw.close();
    redis.disconnect();
  });

  it("preserves Panic from a read rejection racing with stop", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const duplicate = redis.duplicate();
    const read = Promise.withResolvers<unknown>();
    const readStarted = Promise.withResolvers<void>();
    const panic = new Panic({ message: "read race invariant" });
    let disconnected = false;
    Reflect.set(redis, "duplicate", () => duplicate);
    Reflect.set(duplicate, "xread", async () => {
      readStarted.resolve();
      return await read.promise;
    });
    Reflect.set(duplicate, "disconnect", () => {
      if (disconnected) return;
      disconnected = true;
      read.reject(panic);
    });
    const raw = createRedisStreamsBus({ redis, subscriberPool: { max: 1 } });
    const subscription = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "tail",
          offset: { type: "begin" },
          batch: { maxWaitMs: 5_000 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );
    await readStarted.promise;
    const doneCause = subscription.done.then(
      () => null,
      (cause: unknown) => cause,
    );
    const stoppingCause = subscription.stop().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(await doneCause).toBe(panic);
    expect(await stoppingCause).toBe(panic);
    await raw.close();
    redis.disconnect();
  });

  it("preserves an ephemeral loop Panic after DESTROY and lease cleanup failures", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const subscriberRedis = redis.duplicate();
    const managedRedis = redis.duplicate();
    const read = Promise.withResolvers<unknown>();
    const readStarted = Promise.withResolvers<void>();
    const panic = new Panic({ message: "ephemeral loop invariant" });
    let duplicateCalls = 0;
    let subscriberDisconnectCalls = 0;
    let managedDisconnectCalls = 0;
    let destroyCalls = 0;
    Reflect.set(redis, "duplicate", () => {
      duplicateCalls += 1;
      return duplicateCalls === 1 ? subscriberRedis : managedRedis;
    });
    Reflect.set(subscriberRedis, "xgroup", async (...args: unknown[]) => {
      if (args[0] === "CREATE" && typeof args[2] === "string") physicalGroup = args[2];
      return "OK";
    });
    Reflect.set(managedRedis, "eval", async () => ["none"]);
    let physicalGroup = "";
    Reflect.set(subscriberRedis, "xreadgroup", async (...args: unknown[]) => {
      expect(args).toEqual([
        "GROUP",
        physicalGroup,
        expect.any(String),
        "COUNT",
        "1",
        "BLOCK",
        "1000",
        "STREAMS",
        "lilac:event-bus:topic",
        ">",
      ]);
      readStarted.resolve();
      return await read.promise;
    });
    Reflect.set(subscriberRedis, "disconnect", () => {
      subscriberDisconnectCalls += 1;
      if (subscriberDisconnectCalls === 1) {
        read.reject(panic);
        return;
      }
      if (subscriberDisconnectCalls === 2) throw new Error("lease disconnect failed");
    });
    Reflect.set(managedRedis, "disconnect", () => {
      managedDisconnectCalls += 1;
    });
    Reflect.set(redis, "xgroup", async (command: string) => {
      if (command === "DESTROY") destroyCalls += 1;
      throw new Error("group destroy failed");
    });
    const raw = createRedisStreamsBus({ redis, subscriberPool: { max: 1 } });
    const subscription = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "panic-ephemeral",
          consumerId: "panic-ephemeral-consumer",
          ephemeral: true,
          batch: { maxWaitMs: 5_000 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );
    await readStarted.promise;
    const doneCause = subscription.done.then(
      () => null,
      (cause: unknown) => cause,
    );
    const stopCause = subscription.stop().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(await doneCause).toBe(panic);
    expect(await stopCause).toBe(panic);
    expect(destroyCalls).toBe(1);
    expect(subscriberDisconnectCalls).toBe(2);
    expect(managedDisconnectCalls).toBe(2);
    expect(subscriberPoolStats(raw)).toEqual({
      max: 1,
      created: 0,
      available: 0,
      inUse: 0,
    });
    await raw.close();
    redis.disconnect();
  });

  it("preserves a work loop Panic after DELCONSUMER cleanup failure", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const subscriberRedis = redis.duplicate();
    const managedRedis = redis.duplicate();
    const read = Promise.withResolvers<unknown>();
    const readStarted = Promise.withResolvers<void>();
    const panic = new Panic({ message: "work loop invariant" });
    let duplicateCalls = 0;
    let subscriberDisconnectCalls = 0;
    let managedDisconnectCalls = 0;
    let pendingCalls = 0;
    let delconsumerCalls = 0;
    Reflect.set(redis, "duplicate", () => {
      duplicateCalls += 1;
      return duplicateCalls === 1 ? subscriberRedis : managedRedis;
    });
    Reflect.set(subscriberRedis, "xgroup", async () => "OK");
    Reflect.set(managedRedis, "eval", async () => ["none"]);
    Reflect.set(subscriberRedis, "xreadgroup", async () => {
      readStarted.resolve();
      return await read.promise;
    });
    Reflect.set(subscriberRedis, "disconnect", () => {
      subscriberDisconnectCalls += 1;
      if (subscriberDisconnectCalls === 1) read.reject(panic);
    });
    Reflect.set(managedRedis, "disconnect", () => {
      managedDisconnectCalls += 1;
    });
    Reflect.set(redis, "xpending", async () => {
      pendingCalls += 1;
      return [];
    });
    Reflect.set(redis, "xgroup", async (command: string) => {
      if (command === "DELCONSUMER") delconsumerCalls += 1;
      throw new Error("consumer cleanup failed");
    });
    const raw = createRedisStreamsBus({ redis, subscriberPool: { max: 1 } });
    const subscription = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "panic-work",
          batch: { maxWaitMs: 5_000 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );
    await readStarted.promise;
    const doneCause = subscription.done.then(
      () => null,
      (cause: unknown) => cause,
    );
    const stopCause = subscription.stop().then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(await doneCause).toBe(panic);
    expect(await stopCause).toBe(panic);
    expect(pendingCalls).toBe(1);
    expect(delconsumerCalls).toBe(1);
    expect(subscriberDisconnectCalls).toBe(2);
    expect(managedDisconnectCalls).toBe(2);
    expect(subscriberPoolStats(raw)).toEqual({
      max: 1,
      created: 0,
      available: 0,
      inUse: 0,
    });
    await raw.close();
    redis.disconnect();
  });

  it("rejects malformed XGROUP create and cleanup responses", async () => {
    const createRedis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const createDuplicate = createRedis.duplicate();
    Reflect.set(createRedis, "duplicate", () => createDuplicate);
    Reflect.set(createDuplicate, "xgroup", async () => "INVALID");
    const createRaw = createRedisStreamsBus({ redis: createRedis });
    const failedStart = await createRaw.subscribe(
      "topic",
      {
        mode: "work",
        subscriptionId: "malformed-create",
      },
      async () => ({ disposition: "commit" }),
    );
    expect(failedStart.status).toBe("error");
    await createRaw.close();
    createRedis.disconnect();

    const cleanupRedis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const cleanupSubscriberRedis = cleanupRedis.duplicate();
    const cleanupManagedRedis = cleanupRedis.duplicate();
    const read = Promise.withResolvers<unknown>();
    const readStarted = Promise.withResolvers<void>();
    let cleanupDuplicateCalls = 0;
    let disconnected = false;
    Reflect.set(cleanupRedis, "duplicate", () => {
      cleanupDuplicateCalls += 1;
      return cleanupDuplicateCalls === 1 ? cleanupSubscriberRedis : cleanupManagedRedis;
    });
    Reflect.set(cleanupSubscriberRedis, "xgroup", async () => "OK");
    Reflect.set(cleanupManagedRedis, "eval", async () => ["none"]);
    Reflect.set(cleanupSubscriberRedis, "xreadgroup", async () => {
      readStarted.resolve();
      return await read.promise;
    });
    Reflect.set(cleanupSubscriberRedis, "disconnect", () => {
      if (disconnected) return;
      disconnected = true;
      read.reject(new Error("Connection is closed."));
    });
    Reflect.set(cleanupRedis, "xgroup", async () => "INVALID");
    const cleanupRaw = createRedisStreamsBus({
      redis: cleanupRedis,
      subscriberPool: { max: 1 },
    });
    const subscription = requireOk(
      await cleanupRaw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "malformed-cleanup",
          ephemeral: true,
          batch: { maxWaitMs: 5_000 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );
    await readStarted.promise;
    const stopped = await subscription.stop();
    expect(stopped.status).toBe("error");
    if (stopped.status === "error") expect(stopped.error._tag).toBe("EventDeliveryStopFailed");
    await expect(cleanupRaw.close()).rejects.toHaveProperty("_tag", "EventDeliveryStopFailed");
    cleanupRedis.disconnect();

    const consumerRedis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const consumerSubscriberRedis = consumerRedis.duplicate();
    const consumerManagedRedis = consumerRedis.duplicate();
    const consumerRead = Promise.withResolvers<unknown>();
    const consumerReadStarted = Promise.withResolvers<void>();
    let consumerDuplicateCalls = 0;
    let consumerDisconnected = false;
    Reflect.set(consumerRedis, "duplicate", () => {
      consumerDuplicateCalls += 1;
      return consumerDuplicateCalls === 1 ? consumerSubscriberRedis : consumerManagedRedis;
    });
    Reflect.set(consumerSubscriberRedis, "xgroup", async () => "OK");
    Reflect.set(consumerManagedRedis, "eval", async () => ["none"]);
    Reflect.set(consumerSubscriberRedis, "xreadgroup", async () => {
      consumerReadStarted.resolve();
      return await consumerRead.promise;
    });
    Reflect.set(consumerSubscriberRedis, "disconnect", () => {
      if (consumerDisconnected) return;
      consumerDisconnected = true;
      consumerRead.reject(new Error("Connection is closed."));
    });
    Reflect.set(consumerRedis, "xpending", async () => []);
    Reflect.set(consumerRedis, "xgroup", async () => "INVALID");
    const consumerRaw = createRedisStreamsBus({
      redis: consumerRedis,
      subscriberPool: { max: 1 },
    });
    const consumerSubscription = requireOk(
      await consumerRaw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "malformed-delconsumer",
          batch: { maxWaitMs: 5_000 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );
    await consumerReadStarted.promise;
    const consumerStopped = await consumerSubscription.stop();
    expect(consumerStopped.status).toBe("error");
    if (consumerStopped.status === "error") {
      expect(consumerStopped.error._tag).toBe("EventDeliveryStopFailed");
    }
    await expect(consumerRaw.close()).rejects.toHaveProperty("_tag", "EventDeliveryStopFailed");
    consumerRedis.disconnect();
  });

  it("stop disconnects an unresolved managed operation without hanging", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const subscriberRedis = redis.duplicate();
    const managedRedis = redis.duplicate();
    const operation = Promise.withResolvers<unknown>();
    const operationStarted = Promise.withResolvers<void>();
    const rejection = new Error("Connection is closed.");
    let duplicateCalls = 0;
    let managedDisconnectCalls = 0;
    Reflect.set(redis, "duplicate", () => {
      duplicateCalls += 1;
      return duplicateCalls === 1 ? subscriberRedis : managedRedis;
    });
    Reflect.set(subscriberRedis, "xgroup", async () => "OK");
    Reflect.set(managedRedis, "eval", async () => {
      operationStarted.resolve();
      return await operation.promise;
    });
    Reflect.set(managedRedis, "disconnect", () => {
      managedDisconnectCalls += 1;
      if (managedDisconnectCalls === 1) operation.reject(rejection);
    });
    Reflect.set(redis, "xpending", async () => []);
    Reflect.set(redis, "xgroup", async () => 0);
    const raw = createRedisStreamsBus({ redis, subscriberPool: { max: 1 } });
    const subscription = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "work",
          subscriptionId: "unresolved-managed-operation",
          consumerId: "consumer",
          batch: { maxWaitMs: 50 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );
    await operationStarted.promise;

    const stopping = subscription.stop();
    const done = await subscription.done;
    expect(done.status).toBe("error");
    if (done.status === "error" && done.error._tag === "EventDeliveryTransportFailed") {
      expect(done.error.cause).toBe(rejection);
    }
    requireOk(await stopping);
    expect(managedDisconnectCalls).toBe(2);
    await raw.close();
    redis.disconnect();
  });

  it("awaits an in-flight heartbeat failure before committing handler success", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("heartbeat-close-race")}`;
    const streamKey = `${keyPrefix}:topic`;
    const duplicate = redis.duplicate.bind(redis);
    const heartbeat = Promise.withResolvers<unknown>();
    const heartbeatStarted = Promise.withResolvers<void>();
    const handlerAction = Promise.withResolvers<{ disposition: "commit" }>();
    const handlerReturning = Promise.withResolvers<void>();
    const laterReadFailure = new Error("read after an incorrect commit");
    const heartbeatFailure = new Error("forced in-flight heartbeat failure");
    let duplicateCalls = 0;
    let commitCalls = 0;
    let subscription:
      | {
          readonly done: Promise<ResultType<void, unknown>>;
          stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
        }
      | undefined;

    Reflect.set(redis, "duplicate", () => {
      const client = duplicate();
      duplicateCalls += 1;
      if (duplicateCalls === 1) {
        const xreadgroup = client.xreadgroup.bind(client);
        let reads = 0;
        Reflect.set(client, "xreadgroup", async (...args: Parameters<Redis["xreadgroup"]>) => {
          reads += 1;
          if (reads > 1) throw laterReadFailure;
          return await xreadgroup(...args);
        });
      } else {
        const evaluate = client.eval.bind(client);
        Reflect.set(client, "eval", async (script: string, ...args: unknown[]) => {
          if (script === HEARTBEAT_SCRIPT) {
            heartbeatStarted.resolve();
            return await heartbeat.promise;
          }
          if (script === COMMIT_SCRIPT) commitCalls += 1;
          return await Reflect.apply(evaluate, client, [script, ...args]);
        });
      }
      return client;
    });

    const heartbeatTimers = controlManagedHeartbeatTimers();
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      subscriberPool: { max: 1 },
    });

    try {
      subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId: "heartbeat-close-race",
            consumerId: "consumer",
            batch: { maxWaitMs: 50 },
          },
          async () => {
            const action = await handlerAction.promise;
            handlerReturning.resolve();
            return action;
          },
        ),
      );
      await raw.publish(
        { topic: "topic", type: "test", data: null },
        { topic: "topic", type: "test" },
      );
      const heartbeatTimer = await heartbeatTimers.next();
      heartbeatTimer();
      await heartbeatStarted.promise;
      handlerAction.resolve({ disposition: "commit" });
      await handlerReturning.promise;
      heartbeat.reject(heartbeatFailure);

      const done = await subscription.done;
      expect(done.status).toBe("error");
      if (done.status === "error") {
        expect(done.error).toMatchObject({
          _tag: "EventDeliveryTransportFailed",
          cause: heartbeatFailure,
          operation: "read",
          message: "Redis delivery heartbeat failed",
        });
      }
      expect(commitCalls).toBe(0);
    } finally {
      heartbeatTimers.restore();
      if (subscription) await subscription.stop().catch(() => undefined);
      await raw.close();
      await redis.del(streamKey);
      await redis.quit();
    }
  });

  it("keeps a live managed handler owned through multiple heartbeats and commits", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("heartbeat-live-handler")}`;
    const streamKey = `${keyPrefix}:topic`;
    const subscriptionId = "heartbeat-live-handler";
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const duplicate = redis.duplicate.bind(redis);
    const handlerStarted = Promise.withResolvers<AbortSignal>();
    const handlerAction = Promise.withResolvers<{ disposition: "commit" }>();
    const commitCompleted = Promise.withResolvers<void>();
    let duplicateCalls = 0;
    let heartbeatCalls = 0;
    let commitCalls = 0;

    Reflect.set(redis, "duplicate", () => {
      const client = duplicate();
      duplicateCalls += 1;
      if (duplicateCalls === 2) {
        const evaluate = client.eval.bind(client);
        Reflect.set(client, "eval", async (script: string, ...args: unknown[]) => {
          if (script === HEARTBEAT_SCRIPT) heartbeatCalls += 1;
          if (script === COMMIT_SCRIPT) commitCalls += 1;
          const response = await Reflect.apply(evaluate, client, [script, ...args]);
          if (script === COMMIT_SCRIPT) commitCompleted.resolve();
          return response;
        });
      }
      return client;
    });

    const heartbeatTimers = controlManagedHeartbeatTimers();
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      subscriberPool: { max: 1 },
    });
    let subscription: { stop(): Promise<ResultType<void, EventDeliveryStopFailed>> } | undefined;
    try {
      subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId,
            consumerId: "consumer",
            batch: { maxWaitMs: 50 },
          },
          async (_message, context) => {
            if (context.mode === "tail") throw new Error("Expected a managed delivery context");
            handlerStarted.resolve(context.signal);
            return await handlerAction.promise;
          },
        ),
      );
      await raw.publish(
        { topic: "topic", type: "test", data: null },
        { topic: "topic", type: "test" },
      );
      const signal = await handlerStarted.promise;

      const firstHeartbeat = await heartbeatTimers.next();
      firstHeartbeat();
      const secondHeartbeat = await heartbeatTimers.next();
      expect(heartbeatCalls).toBe(1);
      expect(signal.aborted).toBe(false);

      secondHeartbeat();
      await heartbeatTimers.next();
      expect(heartbeatCalls).toBe(2);
      expect(signal.aborted).toBe(false);

      handlerAction.resolve({ disposition: "commit" });
      await commitCompleted.promise;
      expect(commitCalls).toBe(1);
      expect(signal.aborted).toBe(false);
      expect(await pendingCount(redis, streamKey, physicalGroup)).toBe(0);
    } finally {
      heartbeatTimers.restore();
      if (subscription) await subscription.stop().catch(() => undefined);
      await raw.close().catch(() => undefined);
      await redis.del(streamKey);
      await redis.quit();
    }
  });

  it("aborts an active managed handler and preserves its pending entry after a stale heartbeat", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("heartbeat-stale-handler")}`;
    const streamKey = `${keyPrefix}:topic`;
    const subscriptionId = "heartbeat-stale-handler";
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const duplicate = redis.duplicate.bind(redis);
    const handlerStarted = Promise.withResolvers<AbortSignal>();
    const handlerAborted = Promise.withResolvers<void>();
    const handlerReleased = Promise.withResolvers<void>();
    const handlerReturned = Promise.withResolvers<void>();
    const nextReadStarted = Promise.withResolvers<void>();
    let duplicateCalls = 0;
    let heartbeatCalls = 0;
    let commitCalls = 0;

    Reflect.set(redis, "duplicate", () => {
      const client = duplicate();
      duplicateCalls += 1;
      if (duplicateCalls === 1) {
        const xreadgroup = client.xreadgroup.bind(client);
        let reads = 0;
        Reflect.set(client, "xreadgroup", async (...args: Parameters<Redis["xreadgroup"]>) => {
          reads += 1;
          if (reads > 1) nextReadStarted.resolve();
          return await xreadgroup(...args);
        });
      } else {
        const evaluate = client.eval.bind(client);
        Reflect.set(client, "eval", async (script: string, ...args: unknown[]) => {
          if (script === HEARTBEAT_SCRIPT) {
            heartbeatCalls += 1;
            return ["stale"];
          }
          if (script === COMMIT_SCRIPT) commitCalls += 1;
          return await Reflect.apply(evaluate, client, [script, ...args]);
        });
      }
      return client;
    });

    const heartbeatTimers = controlManagedHeartbeatTimers();
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      subscriberPool: { max: 1 },
    });
    let subscription: { stop(): Promise<ResultType<void, EventDeliveryStopFailed>> } | undefined;
    try {
      subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId,
            consumerId: "consumer",
            batch: { maxWaitMs: 50 },
          },
          async (_message, context) => {
            if (context.mode === "tail") throw new Error("Expected a managed delivery context");
            handlerStarted.resolve(context.signal);
            context.signal.addEventListener(
              "abort",
              () => {
                handlerAborted.resolve();
                handlerReleased.resolve();
              },
              { once: true },
            );
            await handlerReleased.promise;
            handlerReturned.resolve();
            return { disposition: "commit" };
          },
        ),
      );
      await raw.publish(
        { topic: "topic", type: "test", data: null },
        { topic: "topic", type: "test" },
      );
      const signal = await handlerStarted.promise;

      const heartbeat = await heartbeatTimers.next();
      heartbeat();
      await handlerAborted.promise;
      await handlerReturned.promise;
      await nextReadStarted.promise;

      expect(heartbeatCalls).toBe(1);
      expect(signal.aborted).toBe(true);
      expect(commitCalls).toBe(0);
      expect(await pendingCount(redis, streamKey, physicalGroup)).toBe(1);
    } finally {
      handlerReleased.resolve();
      heartbeatTimers.restore();
      if (subscription) await subscription.stop().catch(() => undefined);
      await raw.close().catch(() => undefined);
      await redis.del(streamKey);
      await redis.quit();
    }
  });

  it("close aborts an active durable handler and settles every dedicated client", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("close-active-durable")}`;
    const streamKey = `${keyPrefix}:topic`;
    const duplicates: Redis[] = [];
    const duplicate = redis.duplicate.bind(redis);
    Reflect.set(redis, "duplicate", () => {
      const client = duplicate();
      duplicates.push(client);
      return client;
    });
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      subscriberPool: { max: 1 },
    });
    const handlerStarted = Promise.withResolvers<AbortSignal>();
    const handlerAborted = Promise.withResolvers<void>();
    const handlerReleased = Promise.withResolvers<void>();
    try {
      const subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId: "close-active-durable",
            consumerId: "consumer",
            batch: { maxWaitMs: 5_000 },
          },
          async (_message, context) => {
            if (context.mode === "tail") throw new Error("Expected a managed delivery context");
            handlerStarted.resolve(context.signal);
            context.signal.addEventListener(
              "abort",
              () => {
                handlerAborted.resolve();
                handlerReleased.resolve();
              },
              { once: true },
            );
            await handlerReleased.promise;
            return { disposition: "commit" };
          },
        ),
      );
      await raw.publish(
        { topic: "topic", type: "test", data: null },
        { topic: "topic", type: "test" },
      );
      const signal = await handlerStarted.promise;
      const subscriberRedis = duplicates[0];
      const managedRedis = duplicates[1];
      if (!subscriberRedis || !managedRedis) {
        throw new Error("Durable subscription did not create both dedicated Redis clients");
      }
      const subscriberEnded = Promise.withResolvers<void>();
      const managedEnded = Promise.withResolvers<void>();
      let subscriberReconnects = 0;
      let managedReconnects = 0;
      subscriberRedis.once("end", () => subscriberEnded.resolve());
      managedRedis.once("end", () => managedEnded.resolve());
      subscriberRedis.on("reconnecting", () => {
        subscriberReconnects += 1;
      });
      managedRedis.on("reconnecting", () => {
        managedReconnects += 1;
      });

      const closing = raw.close();
      await handlerAborted.promise;
      const [done] = await Promise.all([
        subscription.done,
        closing,
        subscriberEnded.promise,
        managedEnded.promise,
      ]);

      expect(signal.aborted).toBe(true);
      requireOk(done);
      expect(subscriberRedis.status).toBe("end");
      expect(managedRedis.status).toBe("end");
      expect(subscriberReconnects).toBe(0);
      expect(managedReconnects).toBe(0);
      expect(Reflect.get(subscriberRedis, "reconnectTimeout")).toBeNull();
      expect(Reflect.get(managedRedis, "reconnectTimeout")).toBeNull();
      expect(subscriberPoolStats(raw)).toEqual({
        max: 1,
        created: 0,
        available: 0,
        inUse: 0,
      });
      expect(Reflect.get(raw, "activeSubscriptionStops").size).toBe(0);
      expect(Reflect.get(raw, "trimTimers").size).toBe(0);
      expect(Reflect.get(raw, "activeTrims").size).toBe(0);
      requireOk(await subscription.stop());
    } finally {
      await raw.close().catch(() => undefined);
      await redis.del(streamKey);
      await redis.quit();
    }
  });

  it("retries ephemeral managed state cleanup without destroying the group twice", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-cleanup-retry")}`;
    const streamKey = `${keyPrefix}:topic`;
    const subscriptionId = "ephemeral-cleanup-retry";
    const consumerId = "consumer";
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    let physicalGroup = "";
    let metadataPattern = "";
    let statePattern = "";
    const parked = Promise.withResolvers<void>();
    const cleanupFailure = new Error("forced managed state cleanup failure");
    const originalScan = Reflect.get(redis, "scan");
    const originalXgroup = Reflect.get(redis, "xgroup");
    if (typeof originalScan !== "function" || typeof originalXgroup !== "function") {
      throw new Error("Redis cleanup commands are unavailable");
    }
    let cleanupAttempts = 0;
    let destroyCalls = 0;
    Reflect.set(redis, "scan", async (...args: unknown[]) => {
      if (args[0] === "0" && args[1] === "MATCH" && args[2] === statePattern) {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw cleanupFailure;
      }
      return await Reflect.apply(originalScan, redis, args);
    });
    Reflect.set(redis, "xgroup", (...args: unknown[]) => {
      if (args[0] === "DESTROY" && args[1] === streamKey && args[2] === physicalGroup) {
        destroyCalls += 1;
      }
      return Reflect.apply(originalXgroup, redis, args);
    });
    let subscription: { stop(): Promise<ResultType<void, EventDeliveryStopFailed>> } | undefined;
    try {
      subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId,
            consumerId,
            ephemeral: true,
            batch: { maxWaitMs: 50 },
          },
          async () => {
            parked.resolve();
            return { disposition: "park-pending" };
          },
        ),
      );
      const groups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
      expect(groups).toHaveLength(1);
      physicalGroup = groups[0]!;
      metadataPattern = `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(streamKey, physicalGroup)}*`;
      statePattern = metadataPattern.replace(/\*$/, ":message:*");
      await raw.publish(
        { topic: "topic", type: "test", data: null },
        { topic: "topic", type: "test" },
      );
      await parked.promise;
      expect(
        await eventually(
          () => redis.keys(metadataPattern),
          (keys) => keys.length > 0,
        ),
      ).not.toEqual([]);

      const firstStop = await subscription.stop();
      expect(firstStop.status).toBe("error");
      if (firstStop.status === "error") {
        expect(firstStop.error._tag).toBe("EventDeliveryStopFailed");
        expect(firstStop.error.cause).toBe(cleanupFailure);
      }
      expect(consumerGroupNames(await redis.xinfo("GROUPS", streamKey))).not.toContain(
        physicalGroup,
      );
      expect(await redis.keys(metadataPattern)).not.toEqual([]);

      requireOk(await subscription.stop());
      expect(cleanupAttempts).toBe(2);
      expect(destroyCalls).toBe(1);
      expect(await redis.keys(metadataPattern)).toEqual([]);
    } finally {
      Reflect.set(redis, "scan", originalScan);
      Reflect.set(redis, "xgroup", originalXgroup);
      if (subscription) await subscription.stop().catch(() => undefined);
      await raw.close().catch(() => undefined);
      await redis.del(streamKey);
      await redis.quit();
    }
  });

  it("single-flights concurrent stop and close during ephemeral cleanup", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-stop-close")}`;
    const streamKey = `${keyPrefix}:topic`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const originalXgroup = Reflect.get(redis, "xgroup");
    if (typeof originalXgroup !== "function") throw new Error("Redis XGROUP is unavailable");
    const destroyStarted = Promise.withResolvers<void>();
    const releaseDestroy = Promise.withResolvers<void>();
    let destroyCalls = 0;
    let subscription: { stop(): Promise<ResultType<void, EventDeliveryStopFailed>> } | undefined;
    try {
      subscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId: "ephemeral-stop-close",
            consumerId: "consumer",
            ephemeral: true,
            batch: { maxWaitMs: 50 },
          },
          async () => ({ disposition: "commit" }),
        ),
      );
      const groups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
      expect(groups).toHaveLength(1);
      const physicalGroup = groups[0]!;
      Reflect.set(redis, "xgroup", async (...args: unknown[]) => {
        if (args[0] === "DESTROY" && args[1] === streamKey && args[2] === physicalGroup) {
          destroyCalls += 1;
          destroyStarted.resolve();
          await releaseDestroy.promise;
        }
        return await Reflect.apply(originalXgroup, redis, args);
      });

      const stopping = subscription.stop();
      await destroyStarted.promise;
      const closing = raw.close();
      releaseDestroy.resolve();

      requireOk(await stopping);
      await closing;
      expect(destroyCalls).toBe(1);
      expect(consumerGroupNames(await redis.xinfo("GROUPS", streamKey))).not.toContain(
        physicalGroup,
      );
    } finally {
      releaseDestroy.resolve();
      Reflect.set(redis, "xgroup", originalXgroup);
      if (subscription) await subscription.stop().catch(() => undefined);
      await raw.close().catch(() => undefined);
      await redis.del(streamKey);
      await redis.quit();
    }
  });

  it("isolates a same-bus replacement ephemeral incarnation from stale cleanup", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-replacement")}`;
    const streamKey = `${keyPrefix}:topic`;
    const subscriptionId = "ephemeral-replacement";
    const consumerId = "consumer";
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    let firstStatePattern = "";
    const firstParked = Promise.withResolvers<string>();
    const cleanupFailure = new Error("forced first incarnation cleanup failure");
    const originalScan = Reflect.get(redis, "scan");
    if (typeof originalScan !== "function") throw new Error("Redis SCAN is unavailable");
    let failedFirstCleanup = false;
    Reflect.set(redis, "scan", async (...args: unknown[]) => {
      if (
        args[0] === "0" &&
        args[1] === "MATCH" &&
        args[2] === firstStatePattern &&
        !failedFirstCleanup
      ) {
        failedFirstCleanup = true;
        throw cleanupFailure;
      }
      return await Reflect.apply(originalScan, redis, args);
    });
    let firstSubscription:
      | { stop(): Promise<ResultType<void, EventDeliveryStopFailed>> }
      | undefined;
    let secondSubscription: typeof firstSubscription;
    try {
      firstSubscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId,
            consumerId,
            ephemeral: true,
            batch: { maxWaitMs: 50 },
          },
          async (_message, context) => {
            if (context.mode === "tail") throw new Error("Expected a managed delivery context");
            firstParked.resolve(context.deliveryId);
            return { disposition: "park-pending" };
          },
        ),
      );
      const firstGroups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
      expect(firstGroups).toHaveLength(1);
      const firstGroup = firstGroups[0]!;
      const firstMetadataPattern = `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(streamKey, firstGroup)}*`;
      firstStatePattern = firstMetadataPattern.replace(/\*$/, ":message:*");
      const firstPublished = await raw.publish(
        { topic: "topic", type: "test.first", data: null },
        { topic: "topic", type: "test.first" },
      );
      const firstDeliveryId = await firstParked.promise;
      await eventually(
        () => redis.keys(firstMetadataPattern),
        (keys) => keys.length > 0,
      );
      const firstStop = await firstSubscription.stop();
      expect(firstStop.status).toBe("error");
      expect(consumerGroupNames(await redis.xinfo("GROUPS", streamKey))).not.toContain(firstGroup);
      expect(await redis.keys(firstMetadataPattern)).not.toEqual([]);

      const secondDelivered = Promise.withResolvers<{
        cursor: string;
        deliveryId: string;
      }>();
      secondSubscription = requireOk(
        await raw.subscribe(
          "topic",
          {
            mode: "work",
            subscriptionId,
            consumerId,
            ephemeral: true,
            batch: { maxWaitMs: 50 },
          },
          async (_message, context) => {
            if (context.mode === "tail") throw new Error("Expected a managed delivery context");
            secondDelivered.resolve({
              cursor: context.cursor,
              deliveryId: context.deliveryId,
            });
            return { disposition: "park-pending" };
          },
        ),
      );
      const secondGroups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
      expect(secondGroups).toHaveLength(1);
      const secondGroup = secondGroups[0]!;
      expect(secondGroup).not.toBe(firstGroup);
      const secondMetadataPattern = `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(streamKey, secondGroup)}*`;
      const secondPublished = await raw.publish(
        { topic: "topic", type: "test.second", data: null },
        { topic: "topic", type: "test.second" },
      );
      const replacement = await secondDelivered.promise;
      expect(replacement).toEqual({
        cursor: secondPublished.cursor,
        deliveryId: managedRedisDeliveryId(streamKey, secondGroup, secondPublished.id),
      });
      expect(replacement.deliveryId).not.toBe(firstDeliveryId);
      expect(firstDeliveryId).toBe(
        managedRedisDeliveryId(streamKey, firstGroup, firstPublished.id),
      );
      expect(await redis.keys(firstMetadataPattern)).not.toEqual([]);
      // The lease key lasts only until the handler parks, so compare state from after that point.
      const replacementMetadata = await eventually(
        () => redis.keys(secondMetadataPattern),
        (keys) =>
          keys.some((key) => key.includes(":message:")) &&
          !keys.some((key) => key.endsWith(":lease")),
      );

      requireOk(await firstSubscription.stop());
      expect(await redis.keys(firstMetadataPattern)).toEqual([]);
      expect((await redis.keys(secondMetadataPattern)).toSorted()).toEqual(
        replacementMetadata.toSorted(),
      );
      requireOk(await secondSubscription.stop());
      expect(await redis.keys(secondMetadataPattern)).toEqual([]);
    } finally {
      Reflect.set(redis, "scan", originalScan);
      if (firstSubscription) await firstSubscription.stop().catch(() => undefined);
      if (secondSubscription) await secondSubscription.stop().catch(() => undefined);
      await raw.close().catch(() => undefined);
      await redis.del(streamKey);
      await redis.quit();
    }
  });

  it("returns structural evidence without retaining malformed SuperJSON data", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("malformed-superjson")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      const id = await redis.xadd(
        streamKey,
        "*",
        "type",
        "test.malformed",
        "ts",
        "123",
        "data",
        "{not-superjson",
      );
      if (typeof id !== "string") throw new Error("Redis did not return an entry id");

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const failure = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(failure.id).toBe(id);
      expect(failure.error.source).toEqual({
        transport: "redis-streams",
        streamKey,
        topic,
        messageId: id,
      });
      expect(failure.error.issues).toEqual([{ field: "data", reason: "invalid_superjson" }]);
      const retained = JSON.stringify(failure.error.evidence);
      expect(retained).not.toContain("{not-superjson");
      expect(failure.error.evidence.fields).toContainEqual({
        kind: "string",
        path: "fields[5]",
        role: "field-value",
        field: "data",
        valueKind: "structured",
        charLength: "{not-superjson".length,
      });
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("reports missing and invalid envelope fields without fabricating values", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("invalid-fields")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      await redis.xadd(streamKey, "*", "unexpected", "field");
      await redis.xadd(
        streamKey,
        "*",
        "type",
        "",
        "ts",
        "not-a-number",
        "data",
        SuperJSON.stringify({ ok: true }),
      );

      const fetched = await raw.fetch(topic, {
        offset: { type: "begin" },
        limit: 10,
      });
      const missing = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(missing.error.issues).toEqual([
        { field: "type", reason: "missing" },
        { field: "ts", reason: "missing" },
        { field: "data", reason: "missing" },
      ]);
      expect("type" in missing).toBe(false);
      expect("ts" in missing).toBe(false);

      const invalid = requireDecodeFailure(fetched.messages[1]!.msg);
      expect(invalid.error.issues).toEqual([
        { field: "type", reason: "empty" },
        { field: "ts", reason: "invalid_number" },
      ]);
      expect("type" in invalid).toBe(false);
      expect("ts" in invalid).toBe(false);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("rejects decoded headers containing non-string values", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("invalid-headers")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      await redis.xadd(
        streamKey,
        "*",
        "type",
        "test.headers",
        "ts",
        "123",
        "data",
        SuperJSON.stringify(null),
        "headers",
        SuperJSON.stringify({ request_id: 42 }),
      );

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const failure = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(failure.error.issues).toEqual([{ field: "headers", reason: "not_string_record" }]);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("preserves the existing SuperJSON URL, Date, and header wire encoding", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("wire-compatibility")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const data = {
      url: new URL("https://example.com/path?query=value"),
      date: new Date("2026-08-03T12:34:56.789Z"),
    };
    const headers = { request_id: "request-1" };
    try {
      const published = await raw.publish(
        { topic, type: "test.compatibility", headers, data },
        { topic, type: "test.compatibility", headers },
      );
      const entries = await redis.xrange(streamKey, published.id, published.id);
      const fields = entries[0]?.[1];
      if (!fields) throw new Error("Published Redis entry was not found");
      expect(fields[fields.indexOf("data") + 1]).toBe(SuperJSON.stringify(data));
      expect(fields[fields.indexOf("headers") + 1]).toBe(SuperJSON.stringify(headers));

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const decoded = requireDecodedMessage(fetched.messages[0]!.msg);
      expect(decoded.data).toEqual(data);
      expect(decoded.headers).toEqual(headers);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("caps structural wire evidence without retaining a large opaque value", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("bounded-evidence")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const oversizedData = "opaque-value!".repeat(500);
    const fields = ["type", "test.large", "ts", "123", "data", oversizedData];
    for (let index = 0; index < 20; index += 1) {
      fields.push(`extra-${index}`, `value-${index}`);
    }
    try {
      const id = await redis.xadd(streamKey, "*", ...fields);
      if (typeof id !== "string") throw new Error("Redis did not return an entry id");

      const fetched = await raw.fetch(topic, { offset: { type: "begin" } });
      const failure = requireDecodeFailure(fetched.messages[0]!.msg);
      expect(failure.error.source.messageId).toBe(id);
      expect(failure.error.evidence.fields).toHaveLength(32);
      expect(failure.error.evidence.omittedValueCount).toBe(fields.length - 32);
      const dataEvidence = failure.error.evidence.fields[5];
      expect(dataEvidence).toEqual({
        kind: "string",
        path: "fields[5]",
        role: "field-value",
        field: "data",
        valueKind: "text",
        charLength: oversizedData.length,
      });
      expect(JSON.stringify(failure.error.evidence)).not.toContain(oversizedData.slice(0, 64));
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("classifies malformed base64 fields and data URLs without retaining their content", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("redacted-binary-evidence")}`;
    const topic = "topic";
    const streamKey = `${keyPrefix}:${topic}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const base64Sentinel = `binary-sentinel-${randomId("base64")}`;
    const malformedDataBase64 = `{"dataBase64":"${base64Sentinel}`;
    const dataUrlSentinel = `data-url-sentinel-${randomId("url")}`;
    const malformedDataUrl = `data:text/plain;base64,${dataUrlSentinel}`;
    try {
      await redis.xadd(
        streamKey,
        "*",
        "type",
        "test.base64",
        "ts",
        "123",
        "data",
        malformedDataBase64,
      );
      await redis.xadd(
        streamKey,
        "*",
        "type",
        "test.data-url",
        "ts",
        "123",
        "data",
        malformedDataUrl,
      );

      const fetched = await raw.fetch(topic, {
        offset: { type: "begin" },
        limit: 2,
      });
      const base64Failure = requireDecodeFailure(fetched.messages[0]!.msg);
      const dataUrlFailure = requireDecodeFailure(fetched.messages[1]!.msg);
      expect(base64Failure.error.evidence.fields[5]).toEqual({
        kind: "string",
        path: "fields[5]",
        role: "field-value",
        field: "data",
        valueKind: "managed-binary-field",
        charLength: malformedDataBase64.length,
      });
      expect(dataUrlFailure.error.evidence.fields[5]).toEqual({
        kind: "string",
        path: "fields[5]",
        role: "field-value",
        field: "data",
        valueKind: "data-url",
        charLength: malformedDataUrl.length,
      });
      const retained = JSON.stringify([
        base64Failure.error.evidence,
        dataUrlFailure.error.evidence,
      ]);
      expect(retained).not.toContain(base64Sentinel);
      expect(retained).not.toContain(dataUrlSentinel);
      expect(retained).not.toContain("data:text/plain;base64");
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("returns the latest durable topic watermark", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix: `test:lilac-event-bus:${randomId("watermark")}`,
      ownsRedis: true,
    });
    try {
      expect(await raw.watermark("evt.adapter")).toBeNull();
      const first = await raw.publish(
        { topic: "evt.adapter", type: "test.first", data: {} },
        { topic: "evt.adapter", type: "test.first" },
      );
      const second = await raw.publish(
        { topic: "evt.adapter", type: "test.second", data: {} },
        { topic: "evt.adapter", type: "test.second" },
      );
      expect(await raw.watermark("evt.adapter")).toBe(second.cursor);
      expect(second.cursor).not.toBe(first.cursor);
    } finally {
      await raw.close();
    }
  });

  it("does not block publish while a tail subscription is blocked", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const readStarted = observeSubscriberRead(redis);
    const keyPrefix = `test:lilac-event-bus:${randomId("hol")}`;
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      ownsRedis: true,
      subscriberPool: { max: 4, warm: 2 },
    });

    const topicA = "topic-a";
    const topicB = "topic-b";

    const sub = requireOk(
      await raw.subscribe(
        topicA,
        { mode: "tail", offset: { type: "now" }, batch: { maxWaitMs: 2000 } },
        async () => ({ disposition: "commit" }),
      ),
    );

    await readStarted;

    const startedAt = Date.now();
    await raw.publish(
      { topic: topicB, type: "test.publish", data: { ok: true } },
      { topic: topicB, type: "test.publish" },
    );
    const publishMs = Date.now() - startedAt;

    // On the old single-connection implementation, this would be ~BLOCK ms.
    expect(publishMs).toBeLessThan(600);

    requireOk(await sub.stop());
    await raw.close();
  });

  it("stop() interrupts a blocking XREAD promptly", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const readStarted = observeSubscriberRead(redis);
    const keyPrefix = `test:lilac-event-bus:${randomId("stop")}`;
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix,
      ownsRedis: true,
      subscriberPool: { max: 2, warm: 1 },
    });

    const topic = "topic";

    const sub = requireOk(
      await raw.subscribe(
        topic,
        { mode: "tail", offset: { type: "now" }, batch: { maxWaitMs: 5000 } },
        async () => ({ disposition: "commit" }),
      ),
    );

    await readStarted;

    const startedAt = Date.now();
    requireOk(await sub.stop());
    requireOk(await sub.done);
    const stopMs = Date.now() - startedAt;

    expect(stopMs).toBeLessThan(600);
    await raw.close();
  });

  it("exposes tail subscription loop failures through done", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const raw = createRedisStreamsBus({
      redis,
      keyPrefix: `test:lilac-event-bus:${randomId("done-failure")}`,
      ownsRedis: true,
    });
    const sub = requireOk(
      await raw.subscribe(
        "topic",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
        async () => {
          throw new Error("tail handler failed");
        },
      ),
    );
    try {
      await raw.publish(
        { topic: "topic", type: "test.failure", data: {} },
        { topic: "topic", type: "test.failure" },
      );
      await expect(sub.done).rejects.toThrow("tail handler failed");
    } finally {
      await sub.stop().catch(() => undefined);
      await raw.close();
    }
  });

  it("publishes and tails output stream events", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("tail")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);

    const requestId = randomId("req");
    const topic = outReqTopic(requestId);

    const received: string[] = [];
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        topic,
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 250 } },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtAgentOutputDeltaText) {
            received.push(msg.data.delta);
            delivered.resolve();
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "hello",
        seq: 1,
      },
      { headers: { request_id: requestId } },
    );

    await delivered.promise;

    expect(received).toEqual(["hello"]);
    requireOk(await sub.stop());
    await bus.close();
  });

  it("omits successful publish logs for agent output deltas", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("quiet-output-deltas")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw);
    const logger = Reflect.get(raw, "logger") as {
      debug(event: string, context: Record<string, unknown>): void;
    };
    const publishedTypes: unknown[] = [];
    const debug = spyOn(logger, "debug").mockImplementation((event, context) => {
      if (event === "event_bus.publish") publishedTypes.push(context.type);
    });
    const requestId = randomId("req");

    try {
      requireOk(
        await bus.publish(
          lilacEventTypes.EvtAgentOutputDeltaText,
          { delta: "hello" },
          { headers: { request_id: requestId } },
        ),
      );
      requireOk(
        await bus.publish(
          lilacEventTypes.EvtAgentOutputDeltaReasoning,
          { delta: "thinking" },
          { headers: { request_id: requestId } },
        ),
      );
      requireOk(
        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          { finalText: "hello" },
          { headers: { request_id: requestId } },
        ),
      );

      expect(publishedTypes).toEqual([lilacEventTypes.EvtAgentOutputResponseText]);
    } finally {
      debug.mockRestore();
      await bus.close();
      await redis.del(`${keyPrefix}:v2:${outReqTopic(requestId)}`);
      redis.disconnect();
    }
  });

  it("refreshes a 24-hour TTL on request output streams", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("output-ttl")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw);
    const requestId = randomId("req");
    const topic = outReqTopic(requestId);
    const streamKey = `${keyPrefix}:v2:${topic}`;

    const published = requireOk(
      await bus.publish(
        lilacEventTypes.EvtAgentOutputDeltaText,
        { delta: "hello", seq: 1 },
        { headers: { request_id: requestId } },
      ),
    );

    const ttl = await redis.ttl(streamKey);
    expect(ttl).toBeGreaterThan(24 * 60 * 60 - 10);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);
    expect(published.replayDeadline).toBeGreaterThan(Date.now() + (24 * 60 * 60 - 10) * 1000);

    const observed = requireOk(await bus.getOutputStreamExpiry(requestId));
    const redisExpiry = Number(await redis.call("PEXPIRETIME", streamKey));
    expect(observed).toEqual({ kind: "present", expiresAt: redisExpiry });

    await redis.persist(streamKey);
    const uncertain = await bus.getOutputStreamExpiry(requestId);
    expect(uncertain.status).toBe("error");
    if (uncertain.status === "error") {
      expect(uncertain.error._tag).toBe("EventOutputStreamExpiryUnavailable");
      expect(uncertain.error.reason).toBe("expiry-uncertain");
    }

    await redis.del(streamKey);
    expect(await bus.getOutputStreamExpiry(requestId)).toEqual(Result.ok({ kind: "absent" }));
    await bus.close();
    await redis.quit();
  });

  it("trims only entries acknowledged by every consumer group", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("acked-trim")}`;
    const streamKey = `${keyPrefix}:topic`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    let deliveriesA = 0;
    let deliveriesB = 0;
    const firstBAction = Promise.withResolvers<{ disposition: "commit" }>();
    const commitsAReady = Promise.withResolvers<void>();
    const firstBReady = Promise.withResolvers<void>();
    const secondBReady = Promise.withResolvers<void>();

    const subA = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "group-a",
          consumerId: "consumer-a",
          batch: { maxWaitMs: 50 },
        },
        async () => {
          deliveriesA += 1;
          if (deliveriesA === 2) commitsAReady.resolve();
          return { disposition: "commit" };
        },
      ),
    );
    const subB = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "group-b",
          consumerId: "consumer-b",
          batch: { maxWaitMs: 50 },
        },
        async () => {
          deliveriesB += 1;
          if (deliveriesB === 1) {
            firstBReady.resolve();
            return await firstBAction.promise;
          }
          secondBReady.resolve();
          return { disposition: "commit" };
        },
      ),
    );

    await raw.publish({ topic: "topic", type: "test", data: 1 }, { topic: "topic", type: "test" });
    await raw.publish({ topic: "topic", type: "test", data: 2 }, { topic: "topic", type: "test" });
    await Promise.all([commitsAReady.promise, firstBReady.promise]);

    await raw.flushPendingTrims();
    expect(await redis.xlen(streamKey)).toBe(2);

    firstBAction.resolve({ disposition: "commit" });
    await secondBReady.promise;
    await eventually(
      () => pendingCount(redis, streamKey, managedRedisPhysicalGroup("fanout", "group-b")),
      (count) => count === 0,
    );
    await raw.flushPendingTrims();
    expect(await redis.xlen(streamKey)).toBe(1);

    requireOk(await subA.stop());
    requireOk(await subB.stop());
    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("preserves evt.request history used by cursor recovery", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("tail-recovery")}`;
    const streamKey = `${keyPrefix}:evt.request`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    let deliveries = 0;
    const commitsReady = Promise.withResolvers<void>();
    const sub = requireOk(
      await raw.subscribe(
        "evt.request",
        {
          mode: "fanout",
          subscriptionId: "durable-group",
          consumerId: "consumer",
          batch: { maxWaitMs: 50 },
        },
        async () => {
          deliveries += 1;
          if (deliveries === 2) commitsReady.resolve();
          return { disposition: "commit" };
        },
      ),
    );

    await raw.publish(
      { topic: "evt.request", type: "test", data: 1 },
      { topic: "evt.request", type: "test" },
    );
    await raw.publish(
      { topic: "evt.request", type: "test", data: 2 },
      { topic: "evt.request", type: "test" },
    );
    await commitsReady.promise;
    await raw.flushPendingTrims();
    expect(await redis.xlen(streamKey)).toBe(2);

    requireOk(await sub.stop());
    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("bounds evt.adapter history behind the durable checkpoint safety margin", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("adapter-checkpoint-trim")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const cursors: string[] = [];
    try {
      for (let index = 0; index < 150; index += 1) {
        const published = await raw.publish(
          { topic: "evt.adapter", type: "test", data: index },
          { topic: "evt.adapter", type: "test" },
        );
        cursors.push(published.cursor);
      }
      expect(await raw.trimBeforeCheckpoint("evt.adapter", cursors.at(-1)!, 20)).toBe(130);
      expect(await redis.xlen(streamKey)).toBe(20);
      expect(await redis.xrange(streamKey, cursors[129]!, cursors[129]!)).toHaveLength(0);
      expect(await redis.xrange(streamKey, cursors[130]!, cursors[130]!)).toHaveLength(1);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("does not reclaim beyond a lagging resolver checkpoint or durable group frontier", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("adapter-lag-frontier")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const cursors: string[] = [];
    try {
      for (let index = 0; index < 120; index += 1) {
        const published = await raw.publish(
          {
            topic: "evt.adapter",
            type: index === 100 ? "test.barrier" : "test",
            data: index,
          },
          {
            topic: "evt.adapter",
            type: index === 100 ? "test.barrier" : "test",
          },
        );
        cursors.push(published.cursor);
      }

      await raw.trimBeforeCheckpoint("evt.adapter", cursors[49]!, 10);
      expect(await redis.xrange(streamKey, cursors[49]!, cursors[49]!)).toHaveLength(1);
      expect(await redis.xrange(streamKey, cursors[39]!, cursors[39]!)).toHaveLength(0);

      await redis.xgroup(
        "CREATE",
        streamKey,
        managedRedisPhysicalGroup("fanout", "durable-adapter-reader"),
        cursors[79]!,
      );
      await raw.trimBeforeCheckpoint("evt.adapter", cursors.at(-1)!, 10);
      expect(await redis.xrange(streamKey, cursors[79]!, cursors[79]!)).toHaveLength(1);
      expect(await redis.xrange(streamKey, cursors[69]!, cursors[69]!)).toHaveLength(0);
      expect(await redis.xrange(streamKey, cursors[100]!, cursors[100]!)).toHaveLength(1);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("preserves a parked ephemeral source until its group is destroyed", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-checkpoint-trim")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const subscriptionId = "ephemeral-checkpoint-reader";
    const consumerId = "ephemeral-checkpoint-consumer";
    const parked = Promise.withResolvers<void>();
    const subscription = requireOk(
      await raw.subscribe(
        "evt.adapter",
        {
          mode: "fanout",
          subscriptionId,
          consumerId,
          ephemeral: true,
          batch: { maxWaitMs: 50 },
        },
        async () => {
          parked.resolve();
          return { disposition: "park-pending" };
        },
      ),
    );
    const groups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
    expect(groups).toHaveLength(1);
    const physicalGroup = groups[0]!;
    try {
      const sourceBody = `ephemeral-source-${randomId("body")}`;
      const source = await raw.publish(
        { topic: "evt.adapter", type: "test", data: { body: sourceBody } },
        { topic: "evt.adapter", type: "test" },
      );
      await parked.promise;
      await eventually(
        () => pendingCount(redis, streamKey, physicalGroup),
        (count) => count === 1,
      );
      await raw.publish(
        { topic: "evt.adapter", type: "test", data: { body: "later-1" } },
        { topic: "evt.adapter", type: "test" },
      );
      const checkpoint = await raw.publish(
        { topic: "evt.adapter", type: "test", data: { body: "later-2" } },
        { topic: "evt.adapter", type: "test" },
      );

      await raw.trimBeforeCheckpoint("evt.adapter", checkpoint.cursor, 1);
      const retained = await redis.xrange(streamKey, source.id, source.id);
      expect(retained).toHaveLength(1);
      expect(retained[0]?.[1]).toContain(SuperJSON.stringify({ body: sourceBody }));

      requireOk(await subscription.stop());
      await raw.trimBeforeCheckpoint("evt.adapter", checkpoint.cursor, 1);
      expect(await redis.xrange(streamKey, source.id, source.id)).toEqual([]);
    } finally {
      await subscription.stop().catch(() => undefined);
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("retires the pre-tail workflow wait group without pinning adapter retention", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("retired-workflow-waits")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      const first = await raw.publish(
        { topic: "evt.adapter", type: "test", data: 1 },
        { topic: "evt.adapter", type: "test" },
      );
      const second = await raw.publish(
        { topic: "evt.adapter", type: "test", data: 2 },
        { topic: "evt.adapter", type: "test" },
      );
      await redis.xgroup("CREATE", streamKey, "core:workflow-waits", first.cursor);

      expect(await raw.retireConsumerGroup("evt.adapter", "core:workflow-waits", true)).toBe(
        "destroyed",
      );
      expect(await redis.xinfo("GROUPS", streamKey)).toEqual([]);
      expect(await raw.trimBeforeCheckpoint("evt.adapter", second.cursor, 1)).toBe(1);
      expect(await redis.xlen(streamKey)).toBe(1);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("requires single-version confirmation before retiring registered pre-tail consumers", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("workflow-waits-rollout-guard")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      await raw.publish(
        { topic: "evt.adapter", type: "test", data: 1 },
        { topic: "evt.adapter", type: "test" },
      );
      await redis.xgroup("CREATE", streamKey, "core:workflow-waits", "0-0");
      await redis.xreadgroup(
        "GROUP",
        "core:workflow-waits",
        "old-core",
        "COUNT",
        1,
        "STREAMS",
        streamKey,
        ">",
      );

      await expect(
        raw.retireConsumerGroup("evt.adapter", "core:workflow-waits", false),
      ).rejects.toThrow("confirmed single-version rollout");
      expect(await raw.retireConsumerGroup("evt.adapter", "core:workflow-waits", true)).toBe(
        "destroyed",
      );
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("does not trim topic history while publishing", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("publish-without-trim")}`;
    const streamKey = `${keyPrefix}:evt.adapter`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    try {
      const first = await raw.publish(
        { topic: "evt.adapter", type: "test.reply", data: 1 },
        { topic: "evt.adapter", type: "test.reply" },
      );
      await raw.publish(
        { topic: "evt.adapter", type: "test.barrier", data: 2 },
        { topic: "evt.adapter", type: "test.barrier" },
      );
      expect(await redis.xlen(streamKey)).toBe(2);
      expect(await redis.xrange(streamKey, first.cursor, first.cursor)).toHaveLength(1);
    } finally {
      await redis.del(streamKey);
      await raw.close();
      await redis.quit();
    }
  });

  it("destroys ephemeral consumer groups on stop", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral")}`;
    const streamKey = `${keyPrefix}:topic`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const sub = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "temporary-group",
          consumerId: "temporary-consumer",
          ephemeral: true,
          batch: { maxWaitMs: 50 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );

    const groups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
    expect(groups).toHaveLength(1);
    const physicalGroup = groups[0]!;
    requireOk(await sub.stop());
    expect(consumerGroupNames(await redis.xinfo("GROUPS", streamKey))).not.toContain(physicalGroup);

    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("gives concurrent ephemeral subscriptions distinct independently destroyed groups", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("ephemeral-owner")}`;
    const streamKey = `${keyPrefix}:topic`;
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const options = {
      mode: "fanout" as const,
      subscriptionId: "shared-temporary-group",
      ephemeral: true,
      batch: { maxWaitMs: 50 },
    };
    const owner = requireOk(
      await raw.subscribe("topic", { ...options, consumerId: "owner" }, async () => ({
        disposition: "commit",
      })),
    );
    const participant = requireOk(
      await raw.subscribe("topic", { ...options, consumerId: "participant" }, async () => ({
        disposition: "commit",
      })),
    );
    const ephemeralGroups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
    expect(ephemeralGroups).toHaveLength(2);
    expect(new Set(ephemeralGroups).size).toBe(2);

    const durable = requireOk(
      await raw.subscribe(
        "topic",
        {
          mode: "fanout",
          subscriptionId: "shared-temporary-group",
          consumerId: "durable",
          batch: { maxWaitMs: 50 },
        },
        async () => ({ disposition: "commit" }),
      ),
    );

    const durableGroup = managedRedisPhysicalGroup("fanout", "shared-temporary-group");
    expect(consumerGroupNames(await redis.xinfo("GROUPS", streamKey))).toEqual(
      expect.arrayContaining([...ephemeralGroups, durableGroup]),
    );

    requireOk(await owner.stop());
    const remainingEphemeralGroups = ephemeralGroupNames(await redis.xinfo("GROUPS", streamKey));
    expect(remainingEphemeralGroups).toHaveLength(1);
    expect(ephemeralGroups).toContain(remainingEphemeralGroups[0]!);
    requireOk(await participant.stop());
    expect(consumerGroupNames(await redis.xinfo("GROUPS", streamKey))).toEqual([durableGroup]);
    requireOk(await durable.stop());

    await redis.del(streamKey);
    await raw.close();
    await redis.quit();
  });

  it("fans out evt.request to different subscriptionIds", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("fanout")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw, {
      deadLetter: testDeadLetter(redis, keyPrefix),
    });

    const requestId = randomId("req");

    let aCount = 0;
    let bCount = 0;
    const aDelivered = Promise.withResolvers<void>();
    const bDelivered = Promise.withResolvers<void>();

    const subA = requireOk(
      await bus.subscribeTopic(
        "evt.request",
        {
          mode: "fanout",
          subscriptionId: "adapter-a",
          consumerId: "a",
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtRequestReply) {
            aCount++;
          }
          aDelivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    const subB = requireOk(
      await bus.subscribeTopic(
        "evt.request",
        {
          mode: "fanout",
          subscriptionId: "adapter-b",
          consumerId: "b",
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtRequestReply) {
            bCount++;
          }
          bDelivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: { request_id: requestId },
      },
    );

    await Promise.all([aDelivered.promise, bDelivered.promise]);

    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
    const streamKey = `${keyPrefix}:evt.request`;
    expect(
      await eventually(
        () => pendingCount(redis, streamKey, managedRedisPhysicalGroup("fanout", "adapter-a")),
        (count) => count === 0,
      ),
    ).toBe(0);
    expect(
      await eventually(
        () => pendingCount(redis, streamKey, managedRedisPhysicalGroup("fanout", "adapter-b")),
        (count) => count === 0,
      ),
    ).toBe(0);

    requireOk(await subA.stop());
    requireOk(await subB.stop());
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

    const first = requireOk(
      await bus.fetchTopic(topic, {
        offset: { type: "begin" },
        limit: 1,
      }),
    );

    expect(first.messages.length).toBe(1);
    const cursor = first.messages[0]!.cursor;

    const received: string[] = [];
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        topic,
        {
          mode: "tail",
          offset: { type: "cursor", cursor },
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.EvtAgentOutputDeltaText) {
            received.push(msg.data.delta);
            delivered.resolve();
          }
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await delivered.promise;
    expect(received).toEqual(["b"]);

    requireOk(await sub.stop());
    await bus.close();
  });

  it("delivers cmd.request.message in work mode", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("work")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw, {
      deadLetter: testDeadLetter(redis, keyPrefix),
    });

    const requestId = randomId("req");

    let received = 0;
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: "agent-service",
          consumerId: "instance-1",
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            received++;
          }
          delivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
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

    await delivered.promise;
    expect(received).toBe(1);
    expect(
      await eventually(
        () =>
          pendingCount(
            redis,
            `${keyPrefix}:v2:cmd.request`,
            managedRedisPhysicalGroup("work", "agent-service"),
          ),
        (count) => count === 0,
      ),
    ).toBe(0);

    requireOk(await sub.stop());
    await bus.close();
  });

  it("fences a stale caller after claim expiry and reacquisition across clients", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const secondRedis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("request-claim-fence")}`;
    const bus = createLilacBus(createRedisStreamsBus({ redis, keyPrefix }));
    const secondBus = createLilacBus(createRedisStreamsBus({ redis: secondRedis, keyPrefix }));
    const requestDeliveryId = crypto.randomUUID();
    const claimKey = `${keyPrefix}:v2:request-publication-claim:${requestDeliveryId}`;
    const data = {
      requestDeliveryId,
      queue: "prompt" as const,
      messages: [{ role: "user" as const, content: "once" }],
    };
    const options = { headers: { request_id: randomId("request") } };

    const firstAcquisition = requireOk(await bus.acquireRequestPublicationClaim(requestDeliveryId));
    expect(firstAcquisition.status).toBe("acquired");
    if (firstAcquisition.status !== "acquired") throw new Error("First claim was not acquired");
    expect(requireOk(await secondBus.acquireRequestPublicationClaim(requestDeliveryId))).toEqual({
      status: "contended",
    });
    const ttl = await redis.pttl(claimKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(REQUEST_PUBLICATION_CLAIM_TTL_MS);

    await redis.pexpire(claimKey, 1);
    await eventually(
      () => redis.exists(claimKey),
      (exists) => exists === 0,
    );
    const secondAcquisition = requireOk(
      await secondBus.acquireRequestPublicationClaim(requestDeliveryId),
    );
    if (secondAcquisition.status !== "acquired") throw new Error("Second claim was not acquired");

    const [stale, current] = await Promise.all([
      bus.publishClaimedRequest(data, firstAcquisition.claim, options),
      secondBus.publishClaimedRequest(data, secondAcquisition.claim, options),
    ]);
    expect(stale.status).toBe("error");
    if (stale.status === "error")
      expect(stale.error._tag).toBe("EventRequestPublicationClaimFenced");
    const receipt = requireOk(current);
    expect(receipt.duplicate).toBe(false);
    expect(await redis.xlen(`${keyPrefix}:v2:cmd.request`)).toBe(1);

    await redis.del(`${keyPrefix}:v2:cmd.request`, claimKey);
    await secondBus.close();
    await bus.close();
    await secondRedis.quit();
    await redis.quit();
  });

  it("recovers a crash-after-XADD marker and deletes marker and claim on confirmation", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const secondRedis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("request-marker-recovery")}`;
    const bus = createLilacBus(createRedisStreamsBus({ redis, keyPrefix }));
    const secondBus = createLilacBus(createRedisStreamsBus({ redis: secondRedis, keyPrefix }));
    const requestDeliveryId = crypto.randomUUID();
    const claimKey = `${keyPrefix}:v2:request-publication-claim:${requestDeliveryId}`;
    const markerKey = `${keyPrefix}:v2:request-publication:${requestDeliveryId}`;
    const data = {
      requestDeliveryId,
      queue: "prompt" as const,
      messages: [{ role: "user" as const, content: "recover" }],
    };
    const options = { headers: { request_id: randomId("request") } };

    const firstAcquisition = requireOk(await bus.acquireRequestPublicationClaim(requestDeliveryId));
    if (firstAcquisition.status !== "acquired") throw new Error("First claim was not acquired");
    const first = requireOk(await bus.publishClaimedRequest(data, firstAcquisition.claim, options));
    expect(await redis.get(markerKey)).toBe(first.id);

    await redis.pexpire(claimKey, 1);
    await eventually(
      () => redis.exists(claimKey),
      (exists) => exists === 0,
    );
    const recoveredAcquisition = requireOk(
      await secondBus.acquireRequestPublicationClaim(requestDeliveryId),
    );
    if (recoveredAcquisition.status !== "acquired") throw new Error("Claim was not recovered");
    const recovered = requireOk(
      await secondBus.publishClaimedRequest(data, recoveredAcquisition.claim, options),
    );
    expect(recovered).toMatchObject({ id: first.id, duplicate: true });
    expect(await redis.xlen(`${keyPrefix}:v2:cmd.request`)).toBe(1);
    expect(
      await secondBus.confirmRequestPublication(recoveredAcquisition.claim, recovered.id),
    ).toEqual(Result.ok("confirmed"));
    expect(await redis.exists(markerKey, claimKey)).toBe(0);
    expect(await bus.confirmRequestPublication(firstAcquisition.claim, first.id)).toEqual(
      Result.ok("fenced"),
    );

    await redis.del(`${keyPrefix}:v2:cmd.request`);
    await secondBus.close();
    await bus.close();
    await secondRedis.quit();
    await redis.quit();
  });

  it("reports absent and mismatch and only abandons an unpublished exact claim", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("request-claim-outcomes")}`;
    const bus = createLilacBus(createRedisStreamsBus({ redis, keyPrefix }));
    const requestDeliveryId = crypto.randomUUID();
    const claimKey = `${keyPrefix}:v2:request-publication-claim:${requestDeliveryId}`;
    const markerKey = `${keyPrefix}:v2:request-publication:${requestDeliveryId}`;
    const data = {
      requestDeliveryId,
      queue: "prompt" as const,
      messages: [{ role: "user" as const, content: "outcomes" }],
    };
    const options = { headers: { request_id: randomId("request") } };

    const emptyAcquisition = requireOk(await bus.acquireRequestPublicationClaim(requestDeliveryId));
    if (emptyAcquisition.status !== "acquired") throw new Error("Empty claim was not acquired");
    expect(await bus.confirmRequestPublication(emptyAcquisition.claim, "0-0")).toEqual(
      Result.ok("absent"),
    );
    expect(await redis.exists(claimKey)).toBe(0);

    const abandonedAcquisition = requireOk(
      await bus.acquireRequestPublicationClaim(requestDeliveryId),
    );
    if (abandonedAcquisition.status !== "acquired") throw new Error("Claim was not reacquired");
    expect(await bus.abandonRequestPublicationClaim(abandonedAcquisition.claim)).toEqual(
      Result.ok("abandoned"),
    );
    expect(await bus.abandonRequestPublicationClaim(abandonedAcquisition.claim)).toEqual(
      Result.ok("absent"),
    );

    const publishedAcquisition = requireOk(
      await bus.acquireRequestPublicationClaim(requestDeliveryId),
    );
    if (publishedAcquisition.status !== "acquired")
      throw new Error("Publish claim was not acquired");
    const published = requireOk(
      await bus.publishClaimedRequest(data, publishedAcquisition.claim, options),
    );
    expect(await bus.confirmRequestPublication(publishedAcquisition.claim, "0-0")).toEqual(
      Result.ok("mismatch"),
    );
    expect(await bus.abandonRequestPublicationClaim(publishedAcquisition.claim)).toEqual(
      Result.ok("marker-present"),
    );
    expect(await redis.exists(markerKey, claimKey)).toBe(2);
    expect(await bus.confirmRequestPublication(publishedAcquisition.claim, published.id)).toEqual(
      Result.ok("confirmed"),
    );
    expect(await redis.exists(markerKey, claimKey)).toBe(0);

    await redis.del(`${keyPrefix}:v2:cmd.request`);
    await bus.close();
    await redis.quit();
  });

  it("reports post-commit observation failure after the source is acknowledged", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("post-commit")}`;
    let observed = 0;
    const bus = createLilacBus(createRedisStreamsBus({ redis, keyPrefix }), {
      postCommitObserver: {
        observe: async (_message, context) => {
          observed += 1;
          return Result.err(
            new EventPostCommitObservationFailed({
              cause: new Error("bookkeeping unavailable"),
              topic: "cmd.request",
              cursor: context.cursor,
              message: "Core request commit observation failed",
            }),
          );
        },
      },
    });
    const group = managedRedisPhysicalGroup("work", "post-commit-observer");
    const started = requireOk(
      await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: "post-commit-observer",
          batch: { maxWaitMs: 50 },
        },
        async () => Result.ok(undefined),
        () => "commit",
      ),
    );
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "prompt",
        messages: [{ role: "user", content: "observe" }],
      },
      { headers: { request_id: randomId("request") } },
    );

    const done = await started.done;
    expect(done.status).toBe("error");
    if (done.status === "error") expect(done.error._tag).toBe("EventPostCommitObservationFailed");
    expect(observed).toBe(1);
    expect(await pendingCount(redis, `${keyPrefix}:v2:cmd.request`, group)).toBe(0);

    requireOk(await started.stop());
    await redis.del(`${keyPrefix}:v2:cmd.request`);
    await bus.close();
    await redis.quit();
  });

  it("serializes complex objects with URLs and non-standard types using superjson", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("superjson")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw, {
      deadLetter: testDeadLetter(redis, keyPrefix),
    });

    const requestId = randomId("req");

    // Create complex object with URL and special types
    const complexData = {
      requestDeliveryId: crypto.randomUUID(),
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
              type: "blob",
              blob: { version: 1, objectId: `b1_${"11".repeat(16)}` },
              mediaType: "application/pdf",
            },
            {
              type: "resource",
              uri: `resource://r1_${"ab".repeat(16)}`,
              filename: "diagram.png",
              mediaType: "image/png",
              size: 321,
            },
          ],
        },
      ] satisfies BusMessageV2[],
      raw: {
        url: new URL("https://example.com/api"),
        date: new Date(),
        nested: {
          innerUrl: "https://nested.example.com",
        },
      },
    };

    let received: unknown;
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: "test-agent",
          consumerId: "instance-1",
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type === lilacEventTypes.CmdRequestMessage) {
            received = msg.data;
          }
          delivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(lilacEventTypes.CmdRequestMessage, complexData, {
      headers: { request_id: requestId },
    });

    await delivered.promise;

    expect(received).toEqual(complexData);
    requireOk(await sub.stop());
    await bus.close();
  });

  it("preserves Core primary lineage through request transport", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("primary-lineage")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw);
    const messages = [{ role: "user" as const, content: "canonical prompt" }];
    const atom = {
      kind: "surface",
      requestClient: "discord",
      surfaceId: "discord",
      sessionId: "channel-1",
      messageId: "message-1",
    } satisfies CoreLineageAtomV2;
    const corePrimaryLineage = {
      state: "complete",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      segments: [
        {
          atoms: [atom],
          canonicalMessages: messages,
          canonicalStart: 0,
          canonicalEnd: 1,
          cumulativeAtomCount: 1,
          cumulativePrefixDigest: computeCoreLineagePrefixDigestV2([atom]),
        },
      ],
    } satisfies CoreLineageManifestV2;
    const requestDeliveryId = crypto.randomUUID();

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { requestDeliveryId, queue: "prompt", messages, corePrimaryLineage },
      { headers: { request_id: randomId("req") } },
    );
    const fetched = requireOk(
      await bus.fetchTopic("cmd.request", {
        offset: { type: "begin" },
        limit: 1,
      }),
    );

    expect(fetched.messages[0]?.msg.data).toEqual({
      requestDeliveryId,
      queue: "prompt",
      messages,
      corePrimaryLineage,
    });
    await bus.close();
  });

  it("keeps work subscription loop alive after a handler error is committed by policy", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-event-bus:${randomId("work-loop")}`;
    const raw = createRedisStreamsBus({ redis, keyPrefix, ownsRedis: true });
    const bus = createLilacBus(raw, {
      deadLetter: testDeadLetter(redis, keyPrefix),
    });

    let calls = 0;
    let deliveredAfterError = false;
    const delivered = Promise.withResolvers<void>();

    const sub = requireOk(
      await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId: "agent-service-loop",
          consumerId: "instance-1",
          batch: { maxWaitMs: 250 },
        },
        async (msg) => {
          if (msg.type !== lilacEventTypes.CmdRequestMessage) return Result.ok(undefined);

          calls += 1;
          if (calls === 1) {
            return Result.err(new EventHandlerFailed({ message: "expected handler failure" }));
          }

          deliveredAfterError = true;
          delivered.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
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
        requestDeliveryId: crypto.randomUUID(),
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

    await delivered.promise;

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(deliveredAfterError).toBe(true);
    expect(
      await eventually(
        () =>
          pendingCount(
            redis,
            `${keyPrefix}:v2:cmd.request`,
            managedRedisPhysicalGroup("work", "agent-service-loop"),
          ),
        (count) => count === 0,
      ),
    ).toBe(0);

    requireOk(await sub.stop());
    await bus.close();
  });
});
