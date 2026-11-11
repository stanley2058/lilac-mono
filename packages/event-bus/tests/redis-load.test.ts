import { expect, it } from "bun:test";
import Redis from "ioredis";
import { env } from "@stanley2058/lilac-utils";
import {
  createRedisStreamsBus,
  managedRedisGroupId,
  managedRedisPhysicalGroup,
  type RawMessageDecodeOutcome,
} from "../index";
import { RedisConnectionPool } from "../redis-connection-pool";

async function deadline<T>(operation: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<T>();
  const timer = setTimeout(
    () => expired.reject(new Error(`Timed out waiting for ${label}`)),
    5_000,
  );
  try {
    return await Promise.race([operation, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function sequence(message: RawMessageDecodeOutcome): number {
  if ("_tag" in message || typeof message.data !== "number")
    throw new Error("Unexpected load event");
  return message.data;
}

async function drainPending(redis: Redis, stream: string, group: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const pending = await redis.xpending(stream, group);
    if (pending[0] === 0) return;
  }
  throw new Error(`Pending load deliveries did not drain: ${group}`);
}

async function ownedConnectionCount(redis: Redis, name: string): Promise<number> {
  const clients = await redis.client("LIST");
  if (typeof clients !== "string") throw new Error("Invalid Redis client listing");
  return clients.split("\n").filter((line) => line.split(" ").includes(`name=${name}`)).length;
}

async function waitForConnectionCount(
  redis: Redis,
  name: string,
  expected: number,
): Promise<number> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    const count = await ownedConnectionCount(redis, name);
    if (count === expected) return count;
  }
  throw new Error("Stopped load consumers retained Redis connections");
}

it("bounds pooled connections and retained history across slow-consumer bursts and subscription churn", async () => {
  const connectionName = `load-${crypto.randomUUID()}`;
  const redis = new Redis(env.redisUrl || "redis://127.0.0.1:6379", { connectionName });
  const keyPrefix = `test:load:${crypto.randomUUID()}`;
  const topic = "load";
  const stream = `${keyPrefix}:${topic}`;
  const raw = createRedisStreamsBus({ redis, keyPrefix, subscriberPool: { max: 2 } });
  const pool = Reflect.get(raw, "subPool");
  if (!(pool instanceof RedisConnectionPool)) throw new Error("Missing subscription pool");
  const groupIds = ["fast", "slow"].map((id) => managedRedisPhysicalGroup("fanout", id));
  const metadataPrefixes = groupIds.map(
    (group) => `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(stream, group)}:*`,
  );
  const count = 128;
  const slowSeen: number[] = [];
  const fastSeen: number[] = [];
  try {
    for (let wave = 0; wave < 3; wave += 1) {
      const first = wave * count;
      const last = first + count - 1;
      const releaseSlow = Promise.withResolvers<void>();
      const slowStarted = Promise.withResolvers<void>();
      const fastFinished = Promise.withResolvers<void>();
      const slowFinished = Promise.withResolvers<void>();
      const fast = (
        await raw.subscribe(
          topic,
          {
            mode: "fanout",
            subscriptionId: "fast",
            startFrom: "beginning",
            batch: { maxWaitMs: 10 },
          },
          async (message) => {
            const value = sequence(message);
            fastSeen.push(value);
            if (value === last) fastFinished.resolve();
            return { disposition: "commit" };
          },
        )
      ).unwrap();
      const slow = (
        await raw.subscribe(
          topic,
          {
            mode: "fanout",
            subscriptionId: "slow",
            startFrom: "beginning",
            batch: { maxWaitMs: 10 },
          },
          async (message) => {
            const value = sequence(message);
            slowSeen.push(value);
            if (value === first) {
              slowStarted.resolve();
              await releaseSlow.promise;
            }
            if (value === last) slowFinished.resolve();
            return { disposition: "commit" };
          },
        )
      ).unwrap();
      try {
        expect(pool.stats()).toMatchObject({ max: 2, created: 2, inUse: 2 });
        expect(await ownedConnectionCount(redis, connectionName)).toBeLessThanOrEqual(5);
        const overflow = await raw.subscribe(topic, { mode: "tail" }, async () => ({
          disposition: "commit",
        }));
        expect(overflow.isErr()).toBe(true);
        expect(pool.stats().created).toBe(2);
        for (let value = first; value <= last; value += 1)
          await raw.publish({ topic, type: "load", data: value }, { topic, type: "load" });
        await deadline(
          Promise.all([slowStarted.promise, fastFinished.promise]),
          "fast fanout progress",
        );
        await drainPending(redis, stream, groupIds[0]!);
        expect(await ownedConnectionCount(redis, connectionName)).toBe(5);
        expect(fastSeen).toEqual(Array.from({ length: last + 1 }, (_, index) => index));
        expect(slowSeen).toHaveLength(first + 1);
        await raw.flushPendingTrims();
        expect(await redis.xlen(stream)).toBe(count);
        releaseSlow.resolve();
        await deadline(slowFinished.promise, "slow fanout catch-up");
        await drainPending(redis, stream, groupIds[1]!);
        expect(slowSeen).toEqual(fastSeen);
        await raw.flushPendingTrims();
        expect(await redis.xlen(stream)).toBe(1);
      } finally {
        releaseSlow.resolve();
        (await fast.stop()).unwrap();
        (await slow.stop()).unwrap();
        (await fast.done).unwrap();
        (await slow.done).unwrap();
      }
      expect(pool.stats().inUse).toBe(0);
      expect(pool.stats().created).toBeLessThanOrEqual(2);
      expect(
        await waitForConnectionCount(redis, connectionName, 1 + pool.stats().created),
      ).toBeLessThanOrEqual(3);
    }
    expect(fastSeen).toHaveLength(384);
    expect(slowSeen).toEqual(fastSeen);
  } finally {
    await raw.close();
    const keys = [...(await redis.keys(`${keyPrefix}:*`))];
    for (const prefix of metadataPrefixes) keys.push(...(await redis.keys(prefix)));
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
}, 20_000);
