import { describe, expect, it } from "bun:test";
import { Result } from "better-result";
import Redis from "ioredis";
import { env } from "@stanley2058/lilac-utils";
import {
  createLilacBus,
  createRedisStreamsBus,
  lilacEventTypes,
  managedRedisGroupId,
  managedRedisPhysicalGroup,
  RedisEventDeadLetter,
  type DecodedLilacMessageForTopic,
  type LilacTopic,
} from "../index";
import { compatibilityFixtures } from "./helpers/event-contract-fixtures";

async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<T>();
  const timer = setTimeout(
    () => timeout.reject(new Error("Bus contract delivery timed out")),
    5_000,
  );
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

describe("canonical contracts over Redis", () => {
  it("covers every event in the production catalog", () => {
    expect(compatibilityFixtures.map(({ type }) => type).sort()).toEqual(
      Object.values(lilacEventTypes).sort(),
    );
  });

  for (const fixture of compatibilityFixtures) {
    it(`publishes, consumes, fetches and quarantines ${fixture.type}`, async () => {
      const redis = new Redis(env.redisUrl || "redis://127.0.0.1:6379");
      const keyPrefix = `test:contract:${crypto.randomUUID()}`;
      const isOutput = fixture.topic.startsWith("out.req.");
      const version = isOutput || fixture.topic === "cmd.request" ? ":v2" : "";
      const streamKey = `${keyPrefix}${version}:${fixture.topic}`;
      const subscriptionId = "contract";
      const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
      const metadataPrefix = `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(streamKey, physicalGroup)}`;
      const deadLetterPrefix = `${keyPrefix}:dead-letter`;
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const firstCommitted = Promise.withResolvers<void>();
      const secondCommitted = Promise.withResolvers<void>();
      const delivered: DecodedLilacMessageForTopic<LilacTopic>[] = [];
      let committed = 0;
      const fatal: unknown[] = [];
      const bus = createLilacBus(raw, {
        deadLetter: new RedisEventDeadLetter({
          redis,
          keyPrefix: deadLetterPrefix,
          encryptionKey: Buffer.alloc(32, 0x42),
        }),
        reportFatal: {
          report: (error) => {
            fatal.push(error);
          },
        },
        postCommitObserver: {
          observe: async () => {
            committed += 1;
            if (committed === 1) firstCommitted.resolve();
            if (committed === 2) secondCommitted.resolve();
            return Result.ok(undefined);
          },
        },
      });
      try {
        const subscription = (
          await bus.subscribeTopic(
            fixture.topic,
            isOutput
              ? { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 10 } }
              : { mode: "work", subscriptionId, startFrom: "beginning", batch: { maxWaitMs: 10 } },
            async (message) => {
              delivered.push(message);
              if (isOutput && delivered.length === 1) firstCommitted.resolve();
              if (isOutput && delivered.length === 2) secondCommitted.resolve();
              return Result.ok(undefined);
            },
            () => "stop",
          )
        ).unwrap();
        try {
          await fixture.publish(bus);
          await withinDeadline(firstCommitted.promise);
          expect(delivered).toHaveLength(1);
          const expected = {
            type: fixture.type,
            topic: fixture.topic,
            key: fixture.message.key,
            ...(fixture.message.headers === undefined ? {} : { headers: fixture.message.headers }),
            data: fixture.message.data,
          };
          expect(delivered[0]).toMatchObject(expected);
          const fetched = (
            await bus.fetchTopic(fixture.topic, { offset: { type: "begin" } })
          ).unwrap();
          expect(fetched.messages).toHaveLength(1);
          expect(fetched.messages[0]?.msg).toEqual(delivered[0]);
          expect(fetched.messages[0]?.cursor).toBe(delivered[0]?.id);

          const rejected = await fixture.publishMalformed(bus);
          expect(rejected.isErr()).toBe(true);
          if (rejected.isErr()) expect(rejected.error._tag).toBe("EventPublishContractInvalid");
          expect(await redis.xlen(streamKey)).toBe(1);

          // Bypass the producer codec to model a malformed entry from another bus client.
          await raw.publish(
            { ...fixture.message, data: fixture.malformedData },
            { topic: fixture.topic, type: fixture.type },
          );
          const invalidFetch = await bus.fetchTopic(fixture.topic, { offset: { type: "begin" } });
          expect(invalidFetch.isErr()).toBe(true);
          if (invalidFetch.isErr())
            expect(invalidFetch.error._tag).toBe("EventFetchContractInvalid");

          await fixture.publish(bus);
          await withinDeadline(secondCommitted.promise);
          expect(delivered).toHaveLength(2);
          expect(delivered[1]).toMatchObject(expected);
          expect(await redis.zcard(`${deadLetterPrefix}:v3:records`)).toBe(1);
          if (!isOutput) {
            const pending = await redis.xpending(streamKey, physicalGroup);
            expect(pending[0]).toBe(0);
          }
          expect(fatal).toEqual([]);
        } finally {
          (await subscription.stop()).unwrap();
          (await subscription.done).unwrap();
        }
      } finally {
        (await bus.close()).unwrap();
        const keys = [
          ...(await redis.keys(`${keyPrefix}:*`)),
          ...(await redis.keys(`${metadataPrefix}*`)),
        ];
        if (keys.length > 0) await redis.del(...keys);
        await redis.quit();
      }
    });
  }
});
