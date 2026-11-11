import { afterEach, describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { Result } from "better-result";
import {
  createLilacBus,
  createRedisStreamsBus,
  lilacEventTypes,
  managedRedisGroupId,
  managedRedisPhysicalGroup,
} from "../../index";
import {
  createIsolatedRedis,
  createRedisFaultProxy,
  withinRedisDeadline,
} from "../helpers/isolated-redis";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map(async (cleanup) => cleanup()),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Outage fixture cleanup failed",
    );
});

async function isolatedRedis() {
  const server = await createIsolatedRedis();
  cleanups.push(() => server.close());
  return server;
}

async function faultProxy(url: string) {
  const proxy = await createRedisFaultProxy(url);
  cleanups.push(() => proxy.close());
  return proxy;
}

async function connectRedis(url: string) {
  const redis = new Redis(url, {
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  });
  cleanups.push(() => redis.disconnect());
  redis.on("error", () => {});
  await redis.connect();
  await redis.ping();
  return redis;
}

async function observe<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
  }
  throw new Error("Redis state did not reach the expected boundary");
}

async function pending(redis: Redis, stream: string, group: string) {
  const summary = await redis.xpending(stream, group);
  return summary[0];
}

describe("real Redis connection loss and server restart", () => {
  it("recovers publication when Redis committed but the TCP reply was lost", async () => {
    const server = await isolatedRedis();
    const proxy = await faultProxy(server.url);
    const redis = await connectRedis(proxy.url);
    const admin = await connectRedis(server.url);
    const keyPrefix = "resilience:lost-publication";
    const bus = createLilacBus(createRedisStreamsBus({ redis, keyPrefix }));
    const recoveredBus = createLilacBus(createRedisStreamsBus({ redis: admin, keyPrefix }));
    try {
      const requestDeliveryId = crypto.randomUUID();
      const data = {
        requestDeliveryId,
        queue: "prompt" as const,
        messages: [{ role: "user" as const, content: "survive a lost reply" }],
      };
      const options = { headers: { request_id: "lost-reply", session_id: "session" } };
      const acquired = (await bus.acquireRequestPublicationClaim(requestDeliveryId)).unwrap();
      if (acquired.status !== "acquired") throw new Error("Expected publication claim");
      proxy.blockReplies();
      const publication = bus.publishClaimedRequest(data, acquired.claim, options);
      const marker = `${keyPrefix}:v2:request-publication:${requestDeliveryId}`;
      const originalId = await observe(
        () => admin.get(marker),
        (value) => value !== null,
      );
      proxy.disconnect();
      const failed = await withinRedisDeadline(publication, "lost publication reply");
      expect(failed.isErr()).toBe(true);
      expect(await admin.xlen(`${keyPrefix}:v2:cmd.request`)).toBe(1);
      await admin.pexpire(`${keyPrefix}:v2:request-publication-claim:${requestDeliveryId}`, 0);
      const reacquired = (
        await recoveredBus.acquireRequestPublicationClaim(requestDeliveryId)
      ).unwrap();
      if (reacquired.status !== "acquired") throw new Error("Expected recovered claim");
      const recovered = (
        await recoveredBus.publishClaimedRequest(data, reacquired.claim, options)
      ).unwrap();
      expect(recovered).toMatchObject({ id: originalId, duplicate: true });
      expect(
        (await recoveredBus.confirmRequestPublication(reacquired.claim, recovered.id)).unwrap(),
      ).toBe("confirmed");
      const fetched = (
        await recoveredBus.fetchTopic("cmd.request", { offset: { type: "begin" } })
      ).unwrap();
      expect(fetched.messages).toHaveLength(1);
      expect(fetched.messages[0]?.msg.data.requestDeliveryId).toBe(requestDeliveryId);
    } finally {
      await bus.close();
      await recoveredBus.close();
      redis.disconnect();
      admin.disconnect();
      await proxy.close();
      await server.close();
    }
  }, 40_000);

  it("does not replay an acknowledged delivery when its TCP reply is lost before Redis restarts", async () => {
    const server = await isolatedRedis();
    const proxy = await faultProxy(server.url);
    const redis = await connectRedis(proxy.url);
    let admin = await connectRedis(server.url);
    const keyPrefix = "resilience:lost-ack";
    const stream = `${keyPrefix}:evt.request`;
    const group = managedRedisPhysicalGroup("work", "lost-ack");
    const bus = createLilacBus(createRedisStreamsBus({ redis, keyPrefix }));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let replacementBus: ReturnType<typeof createLilacBus> | undefined;
    const first = (
      await bus.subscribeTopic(
        "evt.request",
        {
          mode: "work",
          subscriptionId: "lost-ack",
          consumerId: "before",
          startFrom: "beginning",
          batch: { maxWaitMs: 10 },
        },
        async () => {
          entered.resolve();
          await release.promise;
          return Result.ok(undefined);
        },
        () => "stop",
      )
    ).unwrap();
    try {
      const receipt = (
        await bus.publish(
          lilacEventTypes.EvtRequestReply,
          {},
          { headers: { request_id: "committed" } },
        )
      ).unwrap();
      await withinRedisDeadline(entered.promise, "handler before acknowledgement");
      proxy.blockReplies();
      release.resolve();
      await observe(
        () => pending(admin, stream, group),
        (count) => count === 0,
      );
      proxy.disconnect();
      const lost = await withinRedisDeadline(first.done, "lost acknowledgement reply");
      expect(lost.isErr()).toBe(true);
      const endpoint = server.url;
      await server.stop();
      admin.disconnect();
      await server.start();
      expect(server.url).toBe(endpoint);
      admin = await connectRedis(server.url);
      expect(await pending(admin, stream, group)).toBe(0);
      replacementBus = createLilacBus(createRedisStreamsBus({ redis: admin, keyPrefix }));
      const received: string[] = [];
      const barrier = Promise.withResolvers<void>();
      const replacement = (
        await replacementBus.subscribeTopic(
          "evt.request",
          {
            mode: "work",
            subscriptionId: "lost-ack",
            consumerId: "after",
            startFrom: "beginning",
            batch: { maxWaitMs: 10 },
          },
          async (message) => {
            received.push(message.id);
            barrier.resolve();
            return Result.ok(undefined);
          },
          () => "stop",
        )
      ).unwrap();
      const next = (
        await replacementBus.publish(
          lilacEventTypes.EvtRequestReply,
          {},
          { headers: { request_id: "after-restart" } },
        )
      ).unwrap();
      await withinRedisDeadline(barrier.promise, "post-restart delivery barrier");
      await observe(
        () => pending(admin, stream, group),
        (count) => count === 0,
      );
      expect(received).toEqual([next.id]);
      expect(received).not.toContain(receipt.id);
      (await replacement.stop()).unwrap();
    } finally {
      release.resolve();
      await first.stop();
      await bus.close();
      await replacementBus?.close();
      redis.disconnect();
      admin.disconnect();
      await proxy.close();
      await server.close();
    }
  }, 40_000);

  for (const boundary of ["acknowledgement", "heartbeat"] as const) {
    it(`retains pending work across Redis restart during ${boundary}`, async () => {
      const server = await isolatedRedis();
      const redis = await connectRedis(server.url);
      const keyPrefix = `resilience:${boundary}`;
      const stream = `${keyPrefix}:evt.request`;
      const group = managedRedisPhysicalGroup("work", "restart");
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const subscription = (
        await bus.subscribeTopic(
          "evt.request",
          {
            mode: "work",
            subscriptionId: "restart",
            consumerId: "before-restart",
            startFrom: "beginning",
            batch: { maxWaitMs: 10 },
          },
          async (_message, context) => {
            if (context.mode === "tail") throw new Error("Expected managed context");
            context.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                release.resolve();
              },
              { once: true },
            );
            started.resolve();
            await release.promise;
            return Result.ok(undefined);
          },
          () => "stop",
        )
      ).unwrap();
      let replacementRedis: Redis | undefined;
      let replacementBus: ReturnType<typeof createLilacBus> | undefined;
      try {
        const receipt = (
          await bus.publish(
            lilacEventTypes.EvtRequestReply,
            {},
            { headers: { request_id: "pending-request", session_id: "session" } },
          )
        ).unwrap();
        await withinRedisDeadline(started.promise, "active delivery");
        const endpoint = server.url;
        await server.stop();
        if (boundary === "acknowledgement") release.resolve();
        else await withinRedisDeadline(aborted.promise, "failed lease heartbeat", 20_000);
        const stopped = await withinRedisDeadline(subscription.done, "failed delivery loop");
        expect(stopped.isErr()).toBe(true);
        if (stopped.isErr()) {
          expect(stopped.error._tag).toBe("EventDeliveryTransportFailed");
          expect(stopped.error.message).toContain(
            boundary === "heartbeat" ? "heartbeat" : "commit",
          );
        }
        await server.start();
        expect(server.url).toBe(endpoint);
        replacementRedis = await connectRedis(server.url);
        expect(await pending(replacementRedis, stream, group)).toBe(1);
        expect(await replacementRedis.xlen(stream)).toBe(1);
        const metadata = `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(stream, group)}`;
        // Advance the expired owner's retained lease without waiting for the production minute-long TTL.
        await replacementRedis
          .multi()
          .hset(`${metadata}:message:${receipt.id}`, "lease_deadline", "0")
          .zadd(`${metadata}:lease`, 0, receipt.id)
          .exec();
        replacementBus = createLilacBus(
          createRedisStreamsBus({ redis: replacementRedis, keyPrefix }),
        );
        const received: string[] = [];
        const delivered = Promise.withResolvers<void>();
        const recovered = (
          await replacementBus.subscribeTopic(
            "evt.request",
            {
              mode: "work",
              subscriptionId: "restart",
              consumerId: "after-restart",
              startFrom: "beginning",
              batch: { maxWaitMs: 10 },
            },
            async (message) => {
              received.push(message.id);
              delivered.resolve();
              return Result.ok(undefined);
            },
            () => "stop",
          )
        ).unwrap();
        await withinRedisDeadline(delivered.promise, "recovered pending delivery");
        const recoveredRedis = replacementRedis;
        await observe(
          () => pending(recoveredRedis, stream, group),
          (count) => count === 0,
        );
        expect(received).toEqual([receipt.id]);
        (await recovered.stop()).unwrap();
      } finally {
        release.resolve();
        await subscription.stop();
        await bus.close();
        await replacementBus?.close();
        redis.disconnect();
        replacementRedis?.disconnect();
        await server.close();
      }
    }, 45_000);
  }
});
