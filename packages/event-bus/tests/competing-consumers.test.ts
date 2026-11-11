import { describe, expect, it, spyOn } from "bun:test";
import { Result } from "better-result";
import Redis from "ioredis";
import { env } from "@stanley2058/lilac-utils";
import { createRedisStreamsBus } from "../redis-streams-bus";
import {
  MANAGED_REDIS_HEARTBEAT_MS,
  RedisManagedDelivery,
  managedRedisGroupId,
  managedRedisPhysicalGroup,
  type ManagedLease,
} from "../redis-managed-delivery";
import { COMMIT_SCRIPT, HEARTBEAT_SCRIPT } from "../redis-managed-delivery/lua";
import type { RawDeliveryHandler } from "../event-delivery";

type ManagedContext = Exclude<Parameters<RawDeliveryHandler>[1], { mode: "tail" }>;

async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(new Error(`Timed out: ${label}`)), 4_000);
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function controlHeartbeats() {
  const callbacks: Array<() => void> = [];
  const nativeTimeout = globalThis.setTimeout;
  const controlled = Object.assign(
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== MANAGED_REDIS_HEARTBEAT_MS) return nativeTimeout(callback, delay, ...args);
      callbacks.push(() => callback(...args));
      return { unref() {} } as ReturnType<typeof setTimeout>;
    },
    { __promisify__: nativeTimeout.__promisify__ },
  );
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(controlled as typeof setTimeout);
  return {
    triggerNext() {
      const callback = callbacks.shift();
      if (!callback) throw new Error("No managed heartbeat was scheduled");
      callback();
    },
    restore: () => timer.mockRestore(),
  };
}

function observeManagedCommands(redis: Redis) {
  const commit = Promise.withResolvers<unknown>();
  const heartbeat = Promise.withResolvers<unknown>();
  const nextRead = Promise.withResolvers<void>();
  const duplicate = redis.duplicate.bind(redis);
  let commits = 0;
  let reads = 0;
  redis.duplicate = (...args: Parameters<Redis["duplicate"]>) => {
    const client = duplicate(...args);
    const evaluate = client.eval.bind(client);
    const read = client.xreadgroup.bind(client);
    Reflect.set(client, "eval", async (...values: Parameters<Redis["eval"]>) => {
      const result = await evaluate(...values);
      if (values[0] === COMMIT_SCRIPT) {
        commits += 1;
        commit.resolve(result);
      }
      if (values[0] === HEARTBEAT_SCRIPT) heartbeat.resolve(result);
      return result;
    });
    Reflect.set(client, "xreadgroup", (...values: Parameters<Redis["xreadgroup"]>) => {
      if (++reads > 1) nextRead.resolve();
      return read(...values);
    });
    return client;
  };
  return {
    commit: commit.promise,
    heartbeat: heartbeat.promise,
    nextRead: nextRead.promise,
    commits: () => commits,
  };
}

describe("competing live Redis consumers", () => {
  for (const detectWithHeartbeat of [false, true]) {
    it(`fences a stale handler after takeover (${detectWithHeartbeat ? "heartbeat" : "late commit"})`, async () => {
      const redis = new Redis(env.redisUrl || "redis://127.0.0.1:6379");
      const replacementRedis = redis.duplicate();
      const observed = observeManagedCommands(redis);
      const heartbeatTimers = controlHeartbeats();
      const keyPrefix = `test:competing-consumers:${crypto.randomUUID()}`;
      const topic = "competing";
      const stream = `${keyPrefix}:${topic}`;
      const group = managedRedisPhysicalGroup("work", "shared");
      const metadata = `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(stream, group)}`;
      const original = createRedisStreamsBus({ redis, keyPrefix, subscriberPool: { max: 1 } });
      const replacement = createRedisStreamsBus({
        redis: replacementRedis,
        keyPrefix,
        subscriberPool: { max: 1 },
      });
      const entered = Promise.withResolvers<ManagedContext>();
      const recovered = Promise.withResolvers<ManagedContext>();
      const releaseOriginal = Promise.withResolvers<void>();
      const releaseReplacement = Promise.withResolvers<void>();
      const originalAborted = Promise.withResolvers<void>();
      const replacementCommitted = Promise.withResolvers<void>();
      const observations: string[] = [];
      const invocations: Array<{ owner: string; attempt: number }> = [];
      try {
        const oldSubscription = (
          await original.subscribe(
            topic,
            {
              mode: "work",
              subscriptionId: "shared",
              consumerId: "original",
              startFrom: "beginning",
              batch: { maxWaitMs: 10 },
            },
            async (_message, context) => {
              if (context.mode === "tail") throw new Error("Expected managed context");
              invocations.push({ owner: "original", attempt: context.attempt });
              context.signal.addEventListener("abort", () => originalAborted.resolve(), {
                once: true,
              });
              entered.resolve(context);
              await releaseOriginal.promise;
              return {
                disposition: "commit",
                observePostCommit: async () => {
                  observations.push("original");
                  return Result.ok(undefined);
                },
              };
            },
          )
        ).unwrap();
        const published = await original.publish(
          { topic, type: "competing.test", data: "work" },
          { topic, type: "competing.test" },
        );
        const first = await deadline(entered.promise, "original handler");
        const stateKey = `${metadata}:message:${published.id}`;
        const oldState = await redis.hgetall(stateKey);
        const staleLease: ManagedLease = {
          token: oldState.token!,
          deliveryId: first.deliveryId,
          attempt: first.attempt,
          leaseDeadline: first.leaseDeadline,
        };
        const staleDriver = new RedisManagedDelivery(
          redis,
          stream,
          group,
          "original",
          oldState.owner_id!,
        );
        // Advance only this test delivery's persisted deadline, preserving the lease index invariant.
        await redis
          .multi()
          .hset(stateKey, "lease_deadline", "0")
          .zadd(`${metadata}:lease`, 0, published.id)
          .exec();
        const currentSubscription = (
          await replacement.subscribe(
            topic,
            {
              mode: "work",
              subscriptionId: "shared",
              consumerId: "replacement",
              startFrom: "beginning",
              batch: { maxWaitMs: 10 },
            },
            async (_message, context) => {
              if (context.mode === "tail") throw new Error("Expected managed context");
              invocations.push({ owner: "replacement", attempt: context.attempt });
              recovered.resolve(context);
              await releaseReplacement.promise;
              return {
                disposition: "commit",
                observePostCommit: async () => {
                  observations.push("replacement");
                  replacementCommitted.resolve();
                  return Result.ok(undefined);
                },
              };
            },
          )
        ).unwrap();
        const second = await deadline(recovered.promise, "replacement handler");
        expect(second.deliveryId).toBe(first.deliveryId);
        expect(second.attempt).toBe(2);
        let currentState = await redis.hgetall(stateKey);
        expect(currentState.token).not.toBe(oldState.token);
        expect(currentState.consumer_id).toBe("replacement");
        const currentDriver = new RedisManagedDelivery(
          replacementRedis,
          stream,
          group,
          "replacement",
          currentState.owner_id!,
        );
        const renewed = await currentDriver.heartbeat(published.id, {
          token: currentState.token!,
          deliveryId: second.deliveryId,
          attempt: second.attempt,
          leaseDeadline: second.leaseDeadline,
        });
        expect(renewed.status).toBe("extended");
        currentState = await redis.hgetall(stateKey);
        expect(await redis.zscore(`${metadata}:lease`, published.id)).toBe(
          currentState.lease_deadline!,
        );

        expect(await staleDriver.heartbeat(published.id, staleLease)).toEqual({ status: "stale" });
        expect(
          await staleDriver.scheduleRetry(published.id, staleLease, {
            kind: "handler-error",
            errorTag: "LateFailure",
            errorMessage: "late handler completion",
          }),
        ).toEqual({ status: "stale" });
        expect(await staleDriver.park(published.id, staleLease)).toEqual({ status: "stale" });
        expect(await redis.hgetall(stateKey)).toEqual(currentState);

        if (detectWithHeartbeat) {
          heartbeatTimers.triggerNext();
          expect(await deadline(observed.heartbeat, "stale heartbeat response")).toEqual(["stale"]);
          await deadline(originalAborted.promise, "stale handler abort");
          expect(first.signal.aborted).toBe(true);
        }
        releaseOriginal.resolve();
        if (!detectWithHeartbeat)
          expect(await deadline(observed.commit, "stale commit response")).toEqual(["stale"]);
        await deadline(observed.nextRead, "original consumer advances");
        expect(observed.commits()).toBe(detectWithHeartbeat ? 0 : 1);
        expect(await redis.hgetall(stateKey)).toEqual(currentState);
        const pending = await redis.xpending(stream, group, published.id, published.id, 1);
        expect(pending).toHaveLength(1);
        const pendingEntry = pending[0];
        if (!Array.isArray(pendingEntry)) throw new Error("Expected pending ownership entry");
        expect(pendingEntry[1]).toBe("replacement");
        expect(observations).toEqual([]);

        releaseReplacement.resolve();
        await deadline(replacementCommitted.promise, "current owner commit");
        expect((await redis.xpending(stream, group))[0]).toBe(0);
        expect(await redis.exists(stateKey)).toBe(0);
        expect(observations).toEqual(["replacement"]);
        expect(invocations).toEqual([
          { owner: "original", attempt: 1 },
          { owner: "replacement", attempt: 2 },
        ]);
        expect(await staleDriver.commit(published.id, staleLease)).toEqual({ status: "stale" });
        expect(await staleDriver.heartbeat(published.id, staleLease)).toEqual({ status: "stale" });
        expect(await redis.exists(stateKey)).toBe(0);
        (await oldSubscription.stop()).unwrap();
        (await currentSubscription.stop()).unwrap();
        (await oldSubscription.done).unwrap();
        (await currentSubscription.done).unwrap();
      } finally {
        releaseOriginal.resolve();
        releaseReplacement.resolve();
        await original.close();
        await replacement.close();
        heartbeatTimers.restore();
        const keys = [
          ...(await redis.keys(`${keyPrefix}:*`)),
          ...(await redis.keys(`${metadata}:*`)),
        ];
        if (keys.length) await redis.del(...keys);
        await redis.quit();
        await replacementRedis.quit();
      }
    });
  }
});
