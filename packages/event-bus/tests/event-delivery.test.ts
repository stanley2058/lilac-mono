import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";

import Redis from "ioredis";
import SuperJSON from "superjson";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { env } from "@stanley2058/lilac-utils";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";

import {
  RedisEventDeadLetterAuthenticationFailed,
  RedisEventDeadLetterCiphertextInvalid,
  RedisEventDeadLetterConfigInvalid,
  RedisEventDeadLetterContextMismatch,
  RedisEventDeadLetterRecordInvalid,
  RedisEventDeadLetter,
  RedisManagedDelivery,
  createManagedEventDeadLetterRecord,
  createLilacBus,
  createRedisStreamsBus,
  decryptRedisEventDeadLetterRecord,
  decryptRedisEventDeadLetterRecoveryValue,
  encryptRedisEventDeadLetterRecoveryValue,
  lilacEventTypes,
  managedRedisGroupId,
  managedRedisPhysicalGroup,
  outReqTopic,
  validateRedisEventDeadLetterConfig,
  type DeliveryDisposition,
  type EventDeadLetterRecord,
} from "../index";

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";
const TEST_DEAD_LETTER_KEY = Buffer.alloc(32, 0x42);

function testEvidenceBlobStore(
  contents = new Map<string, Uint8Array>(),
): Pick<BlobStore, "startUpload"> {
  let sequence = 0;
  return {
    startUpload: async ({ source, retention }) => {
      if (!(source instanceof Uint8Array)) throw new Error("Expected byte evidence fixture");
      sequence += 1;
      const objectId = `b1_${sequence.toString(16).padStart(32, "0")}`;
      contents.set(objectId, source);
      return Result.ok({
        handle: { version: 1, objectId },
        completion: Promise.resolve(
          Result.ok({
            version: 1,
            objectId,
            sha256: sequence.toString(16).padStart(64, "0"),
            byteLength: source.byteLength,
            ...(retention.kind === "expires" ? { expiresAt: retention.expiresAt } : {}),
          }),
        ),
      });
    },
  };
}

class HandlerFailure extends TaggedError("HandlerFailure")<{
  readonly message: string;
}> {}

function randomId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

async function pendingIds(
  redis: Redis,
  streamKey: string,
  group: string,
): Promise<readonly string[]> {
  const pending = (await redis.xpending(streamKey, group, "-", "+", 10)) as unknown;
  if (!Array.isArray(pending)) return [];
  return pending.flatMap((entry) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") return [];
    return [entry[0]];
  });
}

function redisFields(fields: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const key = fields[index];
    const value = fields[index + 1];
    if (key !== undefined && value !== undefined) result[key] = value;
  }
  return result;
}

async function deadLetterIndexEntries(
  redis: Redis,
  key: string,
): Promise<ReadonlyArray<{ readonly fields: readonly string[]; readonly score: number }>> {
  const values = await redis.zrange(key, 0, -1, "WITHSCORES");
  if (values.length % 2 !== 0) throw new Error("Redis returned an invalid dead-letter index");
  const entries: Array<{ readonly fields: readonly string[]; readonly score: number }> = [];
  for (let index = 0; index < values.length; index += 2) {
    const member = values[index];
    const score = Number(values[index + 1]);
    if (member === undefined || !Number.isFinite(score)) {
      throw new Error("Redis returned an invalid dead-letter index member");
    }
    const decoded: unknown = JSON.parse(member);
    if (!Array.isArray(decoded) || !decoded.every((value) => typeof value === "string")) {
      throw new Error("Redis returned malformed dead-letter index fields");
    }
    entries.push({ fields: decoded, score });
  }
  return entries;
}

function managedDeliveryKeys(streamKey: string, physicalGroup: string, messageId: string) {
  const prefix = `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(streamKey, physicalGroup)}`;
  return {
    state: `${prefix}:message:${messageId}`,
    due: `${prefix}:due`,
    lease: `${prefix}:lease`,
    terminal: `${prefix}:terminal`,
    pelCursor: `${prefix}:pel-cursor`,
  };
}

async function removeDeadLetters(redis: Redis, keyPrefix: string): Promise<void> {
  const keys = await redis.keys(`${keyPrefix}:v3:*`);
  if (keys.length > 0) await redis.del(...keys);
}

async function publishRequest(
  bus: ReturnType<typeof createLilacBus>,
  requestId: string,
): Promise<string> {
  const published = await bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      requestDeliveryId: crypto.randomUUID(),
      queue: "prompt",
      messages: [{ role: "user", content: "deliver" }],
    },
    { headers: { request_id: requestId } },
  );
  if (published.status === "error") throw published.error;
  return published.value.id;
}

function deadLetterRecordFixture(): EventDeadLetterRecord {
  const topic = "cmd.request";
  const cursor = "1-0";
  const physicalGroup = managedRedisPhysicalGroup("work", "fixture");
  return createManagedEventDeadLetterRecord({
    topic,
    cursor,
    mode: "work",
    physicalGroup,
    attempt: 1,
    recordedAt: 1,
    reason: {
      kind: "contract-invalid",
      diagnostic: "event_bus.contract_invalid",
      stage: "payload",
      issues: ["invalid payload"],
    },
    evidence: {
      source: {
        transport: "redis-streams",
        streamKey: "event-bus:cmd.request",
        topic,
        messageId: cursor,
      },
      wire: {
        kind: "bounded-complete",
        fields: [],
      },
    },
  });
}

function referencedDeadLetterRecordFixture(): EventDeadLetterRecord {
  const record = deadLetterRecordFixture();
  return {
    ...record,
    evidence: {
      source: record.evidence.source,
      wire: {
        kind: "controlled-reference",
        locator: {
          kind: "redis-stream-entry",
          streamKey: record.evidence.source.streamKey,
          messageId: record.source.messageId,
        },
        preview: { fields: [], omittedValueCount: 0 },
      },
    },
  };
}

function inconsistentDeadLetterRecordFixtures(): readonly EventDeadLetterRecord[] {
  const record = referencedDeadLetterRecordFixture();
  const invalidStreamIdentity = createManagedEventDeadLetterRecord({
    topic: record.source.topic,
    cursor: "not-a-stream-id",
    mode: "work",
    physicalGroup: managedRedisPhysicalGroup("work", "fixture"),
    attempt: 1,
    recordedAt: record.recordedAt,
    reason: record.reason,
    evidence: {
      source: { ...record.evidence.source, messageId: "not-a-stream-id" },
      wire: { kind: "bounded-complete", fields: [] },
    },
  });
  return [
    { ...record, source: { ...record.source, mode: "tail" } },
    { ...record, delivery: { kind: "tail" } },
    { ...record, source: { ...record.source, cursor: "2-0" } },
    {
      ...record,
      evidence: {
        ...record.evidence,
        source: { ...record.evidence.source, topic: "other.topic" },
      },
    },
    {
      ...record,
      evidence: {
        ...record.evidence,
        source: { ...record.evidence.source, messageId: "2-0" },
      },
    },
    {
      ...record,
      evidence: {
        ...record.evidence,
        wire: {
          kind: "controlled-reference",
          locator: {
            kind: "redis-stream-entry",
            streamKey: "other-stream",
            messageId: record.source.messageId,
          },
          preview: { fields: [], omittedValueCount: 0 },
        },
      },
    },
    {
      ...record,
      evidence: {
        ...record.evidence,
        wire: {
          kind: "controlled-reference",
          locator: {
            kind: "redis-stream-entry",
            streamKey: record.evidence.source.streamKey,
            messageId: "2-0",
          },
          preview: { fields: [], omittedValueCount: 0 },
        },
      },
    },
    {
      ...record,
      delivery: {
        kind: "managed-v2",
        physicalGroup: managedRedisPhysicalGroup("fanout", "fixture"),
        attempt: 1,
        maxAttempts: 5,
      },
    },
    {
      ...record,
      delivery: {
        kind: "managed-v2",
        physicalGroup: managedRedisPhysicalGroup("work", "fixture", true, "incarnation").replace(
          /:incarnation$/,
          "",
        ),
        attempt: 1,
        maxAttempts: 5,
      },
    },
    { ...record, deadLetterId: "not-the-deterministic-id" },
    invalidStreamIdentity,
    {
      ...record,
      deadLetterId: "",
      source: { ...record.source, mode: "tail" },
      delivery: { kind: "tail" },
    },
    {
      ...record,
      evidence: {
        ...record.evidence,
        wire: {
          kind: "bounded-complete",
          fields: [{ kind: "string", value: "data:text/plain;base64,c2VjcmV0", truncated: false }],
        },
      },
    } as unknown as EventDeadLetterRecord,
    { ...record, delivery: undefined } as unknown as EventDeadLetterRecord,
  ];
}

describe("result-based event delivery", () => {
  it("rejects malformed XRANGE evidence before starting a dead-letter transaction", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    let xrangeResponse: unknown = [];
    let transactionCalls = 0;
    Reflect.set(redis, "xrange", async () => xrangeResponse);
    Reflect.set(redis, "multi", () => {
      transactionCalls += 1;
      throw new Error("unexpected dead-letter transaction");
    });
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
    });
    const malformedResponses: readonly unknown[] = [
      [],
      [
        ["1-0", ["type", "cmd.request.message"]],
        ["1-0", ["type", "cmd.request.message"]],
      ],
      [["2-0", ["type", "cmd.request.message"]]],
      [["1-0"]],
      [["1-0", "not-fields"]],
      [["1-0", ["type"]]],
      [["1-0", ["type", 42]]],
    ];

    for (const malformed of malformedResponses) {
      xrangeResponse = malformed;
      const accepted = await deadLetter.accept(referencedDeadLetterRecordFixture());
      expect(accepted.status).toBe("error");
      if (accepted.status === "error") {
        expect(accepted.error._tag).toBe("EventDeadLetterAcceptFailed");
      }
    }
    expect(transactionCalls).toBe(0);
    redis.disconnect();
  });

  it("rejects malformed and semantically inconsistent v3 records before preparation work", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    let timeCalls = 0;
    let xrangeCalls = 0;
    let transactionCalls = 0;
    Reflect.set(redis, "time", async () => {
      timeCalls += 1;
      throw new Error("unexpected Redis TIME");
    });
    Reflect.set(redis, "xrange", async () => {
      xrangeCalls += 1;
      return [["1-0", ["type", "cmd.request.message"]]];
    });
    Reflect.set(redis, "multi", () => {
      transactionCalls += 1;
      throw new Error("unexpected dead-letter transaction");
    });
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
    });
    for (const inconsistent of inconsistentDeadLetterRecordFixtures()) {
      await expect(deadLetter.prepare(inconsistent)).rejects.toBeInstanceOf(Error);
      const accepted = await deadLetter.accept(inconsistent);
      expect(accepted.status).toBe("error");
      if (accepted.status === "error") {
        expect(accepted.error._tag).toBe("EventDeadLetterAcceptFailed");
      }
    }
    expect(timeCalls).toBe(0);
    expect(xrangeCalls).toBe(0);
    expect(transactionCalls).toBe(0);
    redis.disconnect();
  });

  it("validates Redis dead-letter configuration as a Result before constructor signaling", () => {
    expect(
      validateRedisEventDeadLetterConfig({
        recordTtlSeconds: 60,
        indexMaxLen: 100,
        encryptionKey: TEST_DEAD_LETTER_KEY,
      }),
    ).toEqual(
      Result.ok({
        recordTtlSeconds: 60,
        indexMaxLen: 100,
        encryptionKey: TEST_DEAD_LETTER_KEY,
      }),
    );

    for (const invalid of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const validated = validateRedisEventDeadLetterConfig({
        recordTtlSeconds: invalid,
        indexMaxLen: 100,
        encryptionKey: TEST_DEAD_LETTER_KEY,
      });
      expect(validated.status).toBe("error");
      if (validated.status === "error") {
        expect(validated.error).toBeInstanceOf(RedisEventDeadLetterConfigInvalid);
        expect(validated.error.option).toBe("recordTtlSeconds");
      }
    }

    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    expect(
      () =>
        new RedisEventDeadLetter({
          redis,
          encryptionKey: TEST_DEAD_LETTER_KEY,
          recordTtlSeconds: 60,
          indexMaxLen: 0,
        }),
    ).toThrow(RedisEventDeadLetterConfigInvalid);
    expect(() => new RedisEventDeadLetter({ redis, encryptionKey: Buffer.alloc(31) })).toThrow(
      RedisEventDeadLetterConfigInvalid,
    );
    redis.disconnect();
  });

  for (const disposition of ["commit", "park-pending", "stop", "dead-letter"] as const) {
    it(`owns the ${disposition} action in durable mode`, async () => {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId(disposition)}`;
      const deadLetterPrefix = `${keyPrefix}:dead`;
      const streamKey = `${keyPrefix}:v2:cmd.request`;
      const subscriptionId = `group-${disposition}`;
      const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
      const deadLetter = new RedisEventDeadLetter({
        redis,
        encryptionKey: TEST_DEAD_LETTER_KEY,
        keyPrefix: deadLetterPrefix,
      });
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, { deadLetter });
      const handled = Promise.withResolvers<void>();
      const started = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId,
          consumerId: "consumer",
          batch: { maxWaitMs: 50 },
        },
        async () => {
          handled.resolve();
          return Result.err(new HandlerFailure({ message: "expected handler failure" }));
        },
        (): DeliveryDisposition => disposition,
      );
      if (started.status === "error") throw started.error;

      try {
        const messageId = await publishRequest(bus, randomId("request"));
        await handled.promise;
        if (disposition === "stop") {
          const done = await started.value.done;
          expect(done.status).toBe("error");
          if (done.status === "error" && done.error._tag === "EventDeliveryStopped") {
            expect(done.error.reason).toBe("requested");
          }
        }

        const expectedPending = disposition === "commit" || disposition === "dead-letter" ? 0 : 1;
        const pending = await eventually(
          async () => ({
            ids: await pendingIds(redis, streamKey, physicalGroup),
            deadLetterCount: await redis.zcard(`${deadLetterPrefix}:v3:records`),
          }),
          ({ ids, deadLetterCount }) =>
            ids.length === expectedPending &&
            deadLetterCount === (disposition === "dead-letter" ? 1 : 0),
        );
        if (expectedPending === 1) expect(pending.ids[0]).toBe(messageId);
        expect(pending.deadLetterCount).toBe(disposition === "dead-letter" ? 1 : 0);
      } finally {
        await started.value.stop();
        await redis.del(streamKey);
        await removeDeadLetters(redis, deadLetterPrefix);
        await bus.close();
        await redis.quit();
      }
    });
  }

  it("retries one typed delivery without blocking newly published work", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("retry-fresh-work")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const streamKey = `${keyPrefix}:v2:cmd.request`;
    const subscriptionId = randomId("retry-fresh-work-group");
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      evidenceBlobStore: testEvidenceBlobStore(),
    });
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, { deadLetter });
    const firstRequestId = randomId("retry-request");
    const freshRequestId = randomId("fresh-request");
    const deliveries: Array<{
      requestId: string;
      deliveryId: string;
      attempt: number;
      signal: AbortSignal;
    }> = [];
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId,
        consumerId: randomId("retry-fresh-work-consumer"),
        batch: { maxWaitMs: 50 },
      },
      async (message, context) => {
        const requestId = message.headers?.request_id;
        if (requestId === undefined || context.mode === "tail") {
          throw new Error("Managed request delivery context is missing");
        }
        deliveries.push({
          requestId,
          deliveryId: context.deliveryId,
          attempt: context.attempt,
          signal: context.signal,
        });
        if (requestId === firstRequestId && context.attempt === 1) {
          return Result.err(new HandlerFailure({ message: "retry once" }));
        }
        return Result.ok(undefined);
      },
      () => "retry",
    );
    if (started.status === "error") throw started.error;

    try {
      const firstMessageId = await publishRequest(bus, firstRequestId);
      const firstKeys = managedDeliveryKeys(streamKey, physicalGroup, firstMessageId);
      const scheduled = await eventually(
        () => redis.hgetall(firstKeys.state),
        (state) => state.state === "retry-scheduled" && state.attempt === "1",
      );
      expect(scheduled.due_at).toBeDefined();
      expect(deliveries.map(({ requestId }) => requestId)).toEqual([firstRequestId]);

      await publishRequest(bus, freshRequestId);
      const finalized = await eventually(
        async () => ({
          deliveries: deliveries.slice(),
          pending: await pendingIds(redis, streamKey, physicalGroup),
        }),
        (observed) => observed.deliveries.length === 3 && observed.pending.length === 0,
      );

      expect(finalized.deliveries.map(({ requestId }) => requestId)).toEqual([
        firstRequestId,
        freshRequestId,
        firstRequestId,
      ]);
      const retried = finalized.deliveries.filter(({ requestId }) => requestId === firstRequestId);
      expect(retried.map(({ attempt }) => attempt)).toEqual([1, 2]);
      expect(retried[0]?.deliveryId).toBe(retried[1]?.deliveryId);
      expect(retried.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
      expect(retried.every(({ signal }) => !signal.aborted)).toBe(true);
      expect(new Set(retried.map(({ signal }) => signal)).size).toBe(2);
      expect(finalized.pending).toEqual([]);
    } finally {
      await started.value.stop();
      await redis.del(streamKey);
      await removeDeadLetters(redis, deadLetterPrefix);
      await bus.close();
      await redis.quit();
    }
  });

  it("does not increment a recovered attempt when exact source loading fails", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const originalDuplicate = redis.duplicate.bind(redis);
    const keyPrefix = `test:lilac-delivery:${randomId("recovery-source-failure")}`;
    const streamKey = `${keyPrefix}:v2:cmd.request`;
    const subscriptionId = randomId("recovery-source-failure-group");
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw);
    const attempts: number[] = [];
    const subscribe = (consumerId: string) =>
      bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId,
          consumerId,
          batch: { maxWaitMs: 50 },
        },
        async (_message, context) => {
          if (context.mode === "tail") throw new Error("Expected managed delivery context");
          attempts.push(context.attempt);
          return context.attempt === 1
            ? Result.err(new HandlerFailure({ message: "retry once" }))
            : Result.ok(undefined);
        },
        () => "retry",
      );
    const first = await subscribe("source-failure-first");
    if (first.status === "error") throw first.error;
    let keys: ReturnType<typeof managedDeliveryKeys> | undefined;
    try {
      const messageId = await publishRequest(bus, randomId("source-failure-request"));
      keys = managedDeliveryKeys(streamKey, physicalGroup, messageId);
      await eventually(
        () => redis.hgetall(keys!.state),
        (state) => state.state === "retry-scheduled" && state.attempt === "1",
      );
      await first.value.stop();
      await redis.hset(keys.state, "due_at", "0");
      await redis.zadd(keys.due, 0, messageId);
      const sourceLoadAttempted = Promise.withResolvers<void>();
      Reflect.set(redis, "duplicate", () => {
        const managedRedis = originalDuplicate();
        Reflect.set(managedRedis, "xrange", async () => {
          sourceLoadAttempted.resolve();
          throw new Error("forced exact source load failure");
        });
        return managedRedis;
      });

      const failingRecovery = await subscribe("source-failure-second");
      if (failingRecovery.status === "error") throw failingRecovery.error;
      await sourceLoadAttempted.promise;
      const failed = await failingRecovery.value.done;
      expect(failed.status).toBe("error");
      if (failed.status === "error") expect(failed.error._tag).toBe("EventDeliveryTransportFailed");
      expect(await redis.hgetall(keys.state)).toMatchObject({ state: "claimed", attempt: "1" });
      expect(attempts).toEqual([1]);
      await failingRecovery.value.stop();

      Reflect.set(redis, "duplicate", originalDuplicate);
      await redis.hset(keys.state, "lease_deadline", "0");
      await redis.zadd(keys.lease, 0, messageId);
      const resumed = await subscribe("source-failure-third");
      if (resumed.status === "error") throw resumed.error;
      try {
        await eventually(
          () => pendingIds(redis, streamKey, physicalGroup),
          (pending) => pending.length === 0,
        );
        expect(attempts).toEqual([1, 2]);
      } finally {
        await resumed.value.stop();
      }
    } finally {
      Reflect.set(redis, "duplicate", originalDuplicate);
      await first.value.stop().catch(() => undefined);
      if (keys) {
        await redis.del(streamKey, keys.state, keys.due, keys.lease, keys.terminal, keys.pelCursor);
      } else {
        await redis.del(streamKey);
      }
      await bus.close();
      await redis.quit();
    }
  });

  it("terminalizes an expired attempt 5 without invoking the handler a sixth time", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("expired-attempt-five")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const streamKey = `${keyPrefix}:v2:cmd.request`;
    const subscriptionId = randomId("expired-attempt-five-group");
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      evidenceBlobStore: testEvidenceBlobStore(),
    });
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, { deadLetter });
    const initializer = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId,
        consumerId: "attempt-five-initializer",
        batch: { maxWaitMs: 50 },
      },
      async () => Result.ok(undefined),
      () => "commit",
    );
    if (initializer.status === "error") throw initializer.error;
    let keys: ReturnType<typeof managedDeliveryKeys> | undefined;
    try {
      await initializer.value.stop();
      const messageId = await publishRequest(bus, randomId("attempt-five-request"));
      keys = managedDeliveryKeys(streamKey, physicalGroup, messageId);
      await redis.xreadgroup(
        "GROUP",
        physicalGroup,
        "attempt-five-seed",
        "COUNT",
        1,
        "STREAMS",
        streamKey,
        ">",
      );
      let manager = new RedisManagedDelivery(
        redis,
        streamKey,
        physicalGroup,
        "attempt-five-seed",
        randomId("attempt-five-owner"),
      );
      const fresh = await manager.beginFresh(messageId);
      if (fresh.status !== "claimed") throw new Error("Attempt 1 was not claimed");
      const firstInvocation = await manager.beginInvocation(messageId, fresh.claim);
      if (firstInvocation.status !== "invoke") throw new Error("Attempt 1 was not invoked");
      let invocation = firstInvocation.lease;
      for (const nextAttempt of [2, 3, 4, 5] as const) {
        const scheduled = await manager.scheduleRetry(messageId, invocation, {
          kind: "handler-error",
          errorTag: `Attempt${invocation.attempt}`,
          errorMessage: "retry",
        });
        if (scheduled.status !== "scheduled") throw new Error("Attempt retry was not scheduled");
        await redis.hset(keys.state, "due_at", "0");
        await redis.zadd(keys.due, 0, messageId);
        manager = new RedisManagedDelivery(
          redis,
          streamKey,
          physicalGroup,
          `attempt-five-seed-${nextAttempt}`,
          randomId(`attempt-five-owner-${nextAttempt}`),
        );
        const recovered = await manager.claimRecoverable();
        if (recovered.status !== "claimed") throw new Error("Attempt retry was not claimed");
        const begun = await manager.beginInvocation(messageId, recovered.claim);
        if (begun.status !== "invoke") throw new Error("Attempt retry was not invoked");
        invocation = begun.lease;
      }
      await redis.hset(keys.state, "lease_deadline", "0");
      await redis.zadd(keys.lease, 0, messageId);

      let handlerCalls = 0;
      const recovery = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId,
          consumerId: "attempt-five-recovery",
          batch: { maxWaitMs: 50 },
        },
        async () => {
          handlerCalls += 1;
          return Result.ok(undefined);
        },
        () => "commit",
      );
      if (recovery.status === "error") throw recovery.error;
      try {
        const terminal = await eventually(
          async () => ({
            pending: await pendingIds(redis, streamKey, physicalGroup),
            records: await deadLetterIndexEntries(redis, `${deadLetterPrefix}:v3:records`),
          }),
          (value) => value.pending.length === 0 && value.records.length === 1,
        );
        expect(handlerCalls).toBe(0);
        const fields = terminal.records[0]?.fields;
        if (!fields) throw new Error("Attempt exhaustion index is missing");
        expect(redisFields(fields)).toMatchObject({
          attempt: "5",
          reason: "attempts-exhausted",
        });
      } finally {
        await recovery.value.stop();
      }
    } finally {
      await initializer.value.stop().catch(() => undefined);
      if (keys) {
        await redis.del(streamKey, keys.state, keys.due, keys.lease, keys.terminal, keys.pelCursor);
      } else {
        await redis.del(streamKey);
      }
      await removeDeadLetters(redis, deadLetterPrefix);
      await bus.close();
      await redis.quit();
    }
  });

  it("aborts an active managed handler on stop and preserves its recoverable source", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("active-stop")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const streamKey = `${keyPrefix}:v2:cmd.request`;
    const subscriptionId = randomId("active-stop-group");
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
    });
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, { deadLetter });
    const handlerStarted = Promise.withResolvers<AbortSignal>();
    const handlerAborted = Promise.withResolvers<void>();
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId,
        consumerId: randomId("active-stop-consumer"),
        batch: { maxWaitMs: 50 },
      },
      async (_message, context) => {
        if (context.mode === "tail") throw new Error("Expected managed delivery context");
        handlerStarted.resolve(context.signal);
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              handlerAborted.resolve();
              resolve();
            },
            { once: true },
          );
        });
        return Result.ok(undefined);
      },
      () => "commit",
    );
    if (started.status === "error") throw started.error;

    let keys: ReturnType<typeof managedDeliveryKeys> | undefined;
    try {
      const messageId = await publishRequest(bus, randomId("active-stop-request"));
      keys = managedDeliveryKeys(streamKey, physicalGroup, messageId);
      const signal = await handlerStarted.promise;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      await eventually(
        () => pendingIds(redis, streamKey, physicalGroup),
        (pending) => pending.length === 1 && pending[0] === messageId,
      );

      const stopped = await started.value.stop();
      expect(stopped.status).toBe("ok");
      await handlerAborted.promise;
      expect(signal.aborted).toBe(true);
      expect(await pendingIds(redis, streamKey, physicalGroup)).toEqual([messageId]);
      expect(await redis.hget(keys.state, "state")).toBe("in-flight");
      expect(await redis.zscore(keys.lease, messageId)).not.toBeNull();
      expect(await redis.xrange(streamKey, messageId, messageId)).toHaveLength(1);
    } finally {
      await started.value.stop().catch(() => undefined);
      if (keys !== undefined) {
        await redis.del(streamKey, keys.state, keys.due, keys.lease, keys.terminal);
      } else {
        await redis.del(streamKey);
      }
      await removeDeadLetters(redis, deadLetterPrefix);
      await bus.close();
      await redis.quit();
    }
  });

  it("rejects durable output delivery before creating a consumer group", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("durable-output")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const requestId = randomId("durable-output-request");
    const topic = outReqTopic(requestId);
    const streamKey = `${keyPrefix}:v2:${topic}`;
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      evidenceBlobStore: testEvidenceBlobStore(),
    });
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, { deadLetter });

    try {
      const published = await bus.publish(
        lilacEventTypes.EvtAgentOutputDeltaText,
        { delta: "output", seq: 1 },
        { headers: { request_id: requestId } },
      );
      if (published.status === "error") throw published.error;
      expect(await redis.xinfo("GROUPS", streamKey)).toEqual([]);

      const durable = await bus.subscribeTopic(
        topic,
        {
          mode: "fanout",
          subscriptionId: randomId("durable-output-group"),
          consumerId: randomId("durable-output-consumer"),
          batch: { maxWaitMs: 50 },
        },
        async () => Result.ok(undefined),
        () => "commit",
      );
      expect(durable.status).toBe("error");
      if (durable.status === "error") {
        expect(durable.error.message).toBe(
          "Durable Redis delivery is not supported for output streams",
        );
      }
      expect(await redis.xinfo("GROUPS", streamKey)).toEqual([]);
    } finally {
      await redis.del(streamKey);
      await removeDeadLetters(redis, deadLetterPrefix);
      await bus.close();
      await redis.quit();
    }
  });

  it("keeps failed terminal preparation recoverable for another consumer without a handler call", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const originalXrange = redis.xrange.bind(redis);
    const preparationAttempted = Promise.withResolvers<void>();
    Reflect.set(redis, "xrange", async () => {
      preparationAttempted.resolve();
      return [["0-0", ["type", "unknown.event"]]];
    });

    const keyPrefix = `test:lilac-delivery:${randomId("dead-evidence-invalid")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const streamKey = `${keyPrefix}:v2:cmd.request`;
    const subscriptionId = "dead-evidence-invalid";
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      evidenceBlobStore: testEvidenceBlobStore(),
    });
    const raw = createRedisStreamsBus({ redis, keyPrefix, subscriberPool: { max: 1 } });
    const bus = createLilacBus(raw, { deadLetter });
    let handlerCalls = 0;
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId,
        consumerId: "consumer",
        batch: { maxWaitMs: 50 },
      },
      async () => {
        handlerCalls += 1;
        return Result.ok(undefined);
      },
      () => "commit",
    );
    if (started.status === "error") throw started.error;
    try {
      const messageId = await redis.xadd(
        streamKey,
        "*",
        "type",
        "unknown.event",
        "ts",
        "1",
        "data",
        "x".repeat(2_000),
      );
      if (typeof messageId !== "string") throw new Error("Redis did not return a message id");
      await preparationAttempted.promise;
      const firstDone = await started.value.done;
      expect(firstDone.status).toBe("error");
      if (firstDone.status === "error") {
        expect(firstDone.error._tag).toBe("EventDeliveryTransportFailed");
      }
      const pending = await eventually(
        () => pendingIds(redis, streamKey, physicalGroup),
        (entries) => entries.length === 1,
      );
      expect(pending).toEqual([messageId]);
      const keys = managedDeliveryKeys(streamKey, physicalGroup, messageId);
      const preparingState = await redis.hgetall(keys.state);
      expect(preparingState.state).toBe("terminal-preparing");
      expect(preparingState.terminal_reason).toBeDefined();
      expect(preparingState.terminal_record_value).toBeUndefined();
      expect(preparingState.terminal_evidence_value).toBeUndefined();
      expect(await redis.zcard(`${deadLetterPrefix}:v3:records`)).toBe(0);

      await started.value.stop();
      Reflect.set(redis, "xrange", originalXrange);
      await redis.hset(keys.state, "lease_deadline", "0");
      await redis.zadd(keys.terminal, 0, messageId);
      const resumed = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId,
          consumerId: "consumer-resumed",
          batch: { maxWaitMs: 50 },
        },
        async () => {
          handlerCalls += 1;
          return Result.ok(undefined);
        },
        () => "commit",
      );
      if (resumed.status === "error") throw resumed.error;
      try {
        await eventually(
          async () => ({
            pending: await pendingIds(redis, streamKey, physicalGroup),
            records: await redis.zcard(`${deadLetterPrefix}:v3:records`),
          }),
          (value) => value.pending.length === 0 && value.records === 1,
        );
        expect(handlerCalls).toBe(0);
      } finally {
        await resumed.value.stop();
      }
    } finally {
      await started.value.stop().catch(() => undefined);
      Reflect.set(redis, "xrange", originalXrange);
      await redis.del(streamKey);
      await removeDeadLetters(redis, deadLetterPrefix);
      await bus.close();
      await redis.quit();
    }
  });

  it("applies every disposition in tail mode", async () => {
    for (const disposition of ["commit", "park-pending", "stop", "dead-letter"] as const) {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId(`tail-${disposition}`)}`;
      const deadLetterPrefix = `${keyPrefix}:dead`;
      const deadLetter = new RedisEventDeadLetter({
        redis,
        encryptionKey: TEST_DEAD_LETTER_KEY,
        keyPrefix: deadLetterPrefix,
      });
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, { deadLetter });
      const firstId = await publishRequest(bus, randomId("request"));
      const secondId = await publishRequest(bus, randomId("request"));
      const seen: string[] = [];
      const advanced = Promise.withResolvers<void>();
      const started = await bus.subscribeTopic(
        "cmd.request",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
        async (message) => {
          seen.push(message.id);
          if (seen.length === 2) advanced.resolve();
          return Result.err(new HandlerFailure({ message: "policy fixture" }));
        },
        (): DeliveryDisposition => disposition,
      );
      if (started.status === "error") throw started.error;

      try {
        if (disposition === "commit" || disposition === "dead-letter") {
          await advanced.promise;
          expect(seen).toEqual([firstId, secondId]);
          if (disposition === "dead-letter") {
            const records = await eventually(
              () => deadLetterIndexEntries(redis, `${deadLetterPrefix}:v3:records`),
              (entries) => entries.length === 2,
            );
            expect(records).toHaveLength(2);
            for (const { fields } of records) {
              expect(redisFields(fields).reason).toBe("handler-error");
            }
          } else {
            expect(await redis.zcard(`${deadLetterPrefix}:v3:records`)).toBe(0);
          }
        } else {
          const done = await started.value.done;
          expect(done.status).toBe("error");
          if (done.status === "error" && done.error._tag === "EventDeliveryStopped") {
            expect(done.error.reason).toBe(
              disposition === "park-pending" ? "tail-cannot-park" : "requested",
            );
          }
          expect(seen).toEqual([firstId]);
        }
      } finally {
        await started.value.stop();
        await redis.del(`${keyPrefix}:v2:cmd.request`);
        await removeDeadLetters(redis, deadLetterPrefix);
        await bus.close();
        await redis.quit();
      }
    }
  });

  it("stops tail delivery on dead-letter failure without advancing its cursor", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("tail-stop")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const streamKey = `${keyPrefix}:v2:cmd.request`;
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
    });
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, { deadLetter });
    await redis.set(`${deadLetterPrefix}:v3:records`, "wrong-type");
    const firstId = await publishRequest(bus, randomId("request"));

    const seen: string[] = [];
    const subscribe = () =>
      bus.subscribeTopic(
        "cmd.request",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
        async (message) => {
          seen.push(message.id);
          return Result.err(new HandlerFailure({ message: "reject" }));
        },
        () => "dead-letter",
      );

    const first = await subscribe();
    if (first.status === "error") throw first.error;
    const firstDone = await first.value.done;
    expect(firstDone.status).toBe("error");
    if (firstDone.status === "error" && firstDone.error._tag === "EventDeliveryStopped") {
      expect(firstDone.error.reason).toBe("dead-letter-failed");
    }

    const second = await subscribe();
    if (second.status === "error") throw second.error;
    const secondDone = await second.value.done;
    expect(secondDone.status).toBe("error");
    expect(seen).toEqual([firstId, firstId]);

    await first.value.stop();
    await second.value.stop();
    await redis.del(streamKey);
    await removeDeadLetters(redis, deadLetterPrefix);
    await bus.close();
    await redis.quit();
  });

  it("reports rejected handlers and Panic as defects while stopping the loop", async () => {
    for (const cause of [new Error("rejected handler"), new Panic({ message: "handler panic" })]) {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId("defect")}`;
      const reported: unknown[] = [];
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, {
        reportFatal: {
          report: (fatal) => {
            reported.push(fatal);
          },
        },
      });
      const started = await bus.subscribeTopic(
        "cmd.request",
        { mode: "tail", offset: { type: "begin" }, batch: { maxWaitMs: 50 } },
        async () => {
          throw cause;
        },
        () => "commit",
      );
      if (started.status === "error") throw started.error;
      try {
        await publishRequest(bus, randomId("request"));
        await expect(started.value.done).rejects.toBe(cause);
        expect(reported).toEqual([cause]);
      } finally {
        await started.value.stop().catch(() => undefined);
        await redis.del(`${keyPrefix}:v2:cmd.request`);
        await bus.close();
        await redis.quit();
      }
    }
  });

  const panicErrCause = new Panic({ message: "not an expected handler error" });
  const malformedResults: ReadonlyArray<[string, () => ResultType<void, HandlerFailure>, Panic?]> =
    [
      [
        "forged prototype",
        () => {
          const result = Result.ok(undefined);
          Object.setPrototypeOf(result, Object.prototype);
          return result;
        },
      ],
      [
        "missing Ok value",
        () => {
          const result = Result.ok(undefined);
          Reflect.deleteProperty(result, "value");
          return result;
        },
      ],
      [
        "non-undefined Ok value",
        () => {
          const result = Result.ok(undefined);
          Reflect.set(result, "value", "forged");
          return result;
        },
      ],
      [
        "missing Err error",
        () => {
          const result = Result.err(new HandlerFailure({ message: "missing" }));
          Reflect.deleteProperty(result, "error");
          return result;
        },
      ],
      [
        "invalid Err status",
        () => {
          const result = Result.err(new HandlerFailure({ message: "invalid status" }));
          Reflect.set(result, "status", "ok");
          return result;
        },
      ],
      [
        "non-tagged Err error",
        () => {
          const result = Result.err(new HandlerFailure({ message: "replaced" }));
          Reflect.set(result, "error", new Error("not owned"));
          return result;
        },
      ],
      [
        "incomplete tagged Err error",
        () => {
          const result = Result.err(new HandlerFailure({ message: "incomplete" }));
          Reflect.deleteProperty(result.error, "message");
          return result;
        },
      ],
      [
        "Panic Err error",
        () => {
          const result = Result.err(new HandlerFailure({ message: "replaced" }));
          Reflect.set(result, "error", panicErrCause);
          return result;
        },
        panicErrCause,
      ],
      [
        "revoked Result",
        () => {
          const { proxy, revoke } = Proxy.revocable(Result.ok(undefined), {});
          revoke();
          return proxy;
        },
      ],
    ];

  for (const [label, malformedResult, expectedPanic] of malformedResults) {
    it(`reports ${label} handler Result and preserves its pending entry`, async () => {
      const redis = new Redis(TEST_REDIS_URL);
      const keyPrefix = `test:lilac-delivery:${randomId(`handler-${label}`)}`;
      const streamKey = `${keyPrefix}:v2:cmd.request`;
      const subscriptionId = "malformed-handler";
      const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
      const reported = Promise.withResolvers<unknown>();
      const raw = createRedisStreamsBus({ redis, keyPrefix });
      const bus = createLilacBus(raw, {
        reportFatal: { report: (cause) => reported.resolve(cause) },
      });
      const started = await bus.subscribeTopic(
        "cmd.request",
        {
          mode: "work",
          subscriptionId,
          consumerId: "consumer",
          batch: { maxWaitMs: 50 },
        },
        async () => malformedResult(),
        () => "commit",
      );
      if (started.status === "error") throw started.error;
      try {
        const id = await publishRequest(bus, randomId("request"));
        const reportedCause = await reported.promise;
        if (expectedPanic) {
          expect(reportedCause).toBe(expectedPanic);
          await expect(started.value.done).rejects.toBe(expectedPanic);
        } else {
          await expect(started.value.done).rejects.toBeDefined();
        }
        expect(await pendingIds(redis, streamKey, physicalGroup)).toEqual([id]);
      } finally {
        await started.value.stop().catch(() => undefined);
        await redis.del(streamKey);
        await bus.close();
        await redis.quit();
      }
    });
  }

  it("atomically acknowledges one source with a deterministic encrypted v3 dead letter", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const keyPrefix = `test:lilac-delivery:${randomId("redis-dead-letter")}`;
    const deadLetterPrefix = `${keyPrefix}:dead`;
    const streamKey = `${keyPrefix}:v2:cmd.request`;
    const subscriptionId = "invalid-contract";
    const physicalGroup = managedRedisPhysicalGroup("work", subscriptionId);
    const evidenceBlobs = new Map<string, Uint8Array>();
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    const bus = createLilacBus(raw, {
      deadLetter: new RedisEventDeadLetter({
        redis,
        encryptionKey: TEST_DEAD_LETTER_KEY,
        keyPrefix: deadLetterPrefix,
        recordTtlSeconds: 60,
        indexMaxLen: 2,
        evidenceBlobStore: testEvidenceBlobStore(evidenceBlobs),
      }),
    });
    const started = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "work",
        subscriptionId,
        batch: { maxWaitMs: 50 },
      },
      async () => Result.ok(undefined),
      () => "commit",
    );
    if (started.status === "error") throw started.error;
    try {
      const secretSentinel = `dead-letter-secret-${randomId("sentinel")}`;
      const base64Sentinel = `dead-letter-base64-${randomId("sentinel")}`;
      const dataUrlSentinel = `dead-letter-data-url-${randomId("sentinel")}`;
      const sourcePayload = `{"dataBase64":"${base64Sentinel}","url":"data:text/plain;base64,${dataUrlSentinel}","opaque":"${secretSentinel.repeat(100)}"`;
      const id = await redis.xadd(
        streamKey,
        "*",
        "type",
        "unknown.event",
        "ts",
        "1",
        "data",
        sourcePayload,
      );
      if (typeof id !== "string") throw new Error("Redis did not return an entry id");
      const finalized = await eventually(
        async () => ({
          pending: await pendingIds(redis, streamKey, physicalGroup),
          records: await deadLetterIndexEntries(redis, `${deadLetterPrefix}:v3:records`),
        }),
        ({ pending, records }) => pending.length === 0 && records.length === 1,
      );
      const records = finalized.records;
      expect(await redis.xlen(streamKey)).toBe(1);
      const indexFields = records[0]?.fields;
      if (!indexFields) throw new Error("Dead-letter index metadata is missing");
      const index = redisFields(indexFields);
      expect(index.reason).toBe("contract-invalid");
      expect(index.physicalGroup).toBe(physicalGroup);
      expect(index.attempt).toBe("1");
      expect(index.recordKey?.startsWith(`${deadLetterPrefix}:v3:record:`)).toBe(true);
      expect(JSON.stringify(indexFields)).not.toContain(secretSentinel);
      expect(JSON.stringify(indexFields)).not.toContain(base64Sentinel);
      expect(JSON.stringify(indexFields)).not.toContain(dataUrlSentinel);
      expect(indexFields).not.toContain("record");
      const recordKey = index.recordKey;
      if (!recordKey) throw new Error("Dead-letter record locator is missing");
      const deadLetterId = index.deadLetterId;
      if (!deadLetterId) throw new Error("Dead-letter identity is missing");
      const recordTtl = await redis.ttl(recordKey);
      expect(recordTtl).toBeGreaterThan(0);
      expect(recordTtl).toBeLessThanOrEqual(60);
      const encodedRecord = await redis.get(recordKey);
      if (encodedRecord === null) throw new Error("Dead-letter record is missing");
      expect(encodedRecord).not.toContain(secretSentinel);
      expect(encodedRecord).not.toContain(base64Sentinel);
      expect(encodedRecord).not.toContain(dataUrlSentinel);
      const recovered = decryptRedisEventDeadLetterRecord({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        expectedIdentity: { deadLetterId, storageKey: recordKey },
        ciphertextEnvelope: encodedRecord,
      });
      if (recovered.status === "error") throw recovered.error;
      expect(recovered.value.version).toBe(3);
      expect(recovered.value.source.messageId).toBe(id);
      expect(recovered.value.delivery).toEqual({
        kind: "managed-v2",
        physicalGroup,
        attempt: 1,
        maxAttempts: 5,
      });
      const sameSourceIdentity = createManagedEventDeadLetterRecord({
        topic: recovered.value.source.topic,
        cursor: recovered.value.source.cursor,
        mode: "work",
        physicalGroup,
        attempt: 1,
        recordedAt: recovered.value.recordedAt + 1,
        reason: recovered.value.reason,
        evidence: recovered.value.evidence,
      });
      expect(sameSourceIdentity.deadLetterId).toBe(deadLetterId);
      expect(recovered.value.evidence.wire.kind).toBe("controlled-reference");
      const wire = recovered.value.evidence.wire;
      if (wire.kind === "controlled-reference" && wire.locator.kind === "blob-ref") {
        expect(wire.preview.fields[5]).toEqual({
          kind: "string",
          path: "fields[5]",
          role: "field-value",
          field: "data",
          valueKind: "data-url",
          charLength: sourcePayload.length,
        });
        const preview = JSON.stringify(wire.preview);
        expect(preview).not.toContain(secretSentinel);
        expect(preview).not.toContain(base64Sentinel);
        expect(preview).not.toContain(dataUrlSentinel);
        expect(preview).not.toContain("data:text/plain;base64");
        const encryptedEvidence = evidenceBlobs.get(wire.locator.blob.objectId);
        expect(encryptedEvidence).toBeDefined();
        expect(Buffer.from(encryptedEvidence ?? []).toString("utf8")).not.toContain(secretSentinel);
        expect(await redis.keys(`${deadLetterPrefix}:v3:evidence:*`)).toEqual([]);
      }
      await redis.del(recordKey);
    } finally {
      await started.value.stop();
      await redis.del(streamKey);
      await removeDeadLetters(redis, deadLetterPrefix);
      await bus.close();
      await redis.quit();
    }
  });

  it("bounds the payload-free dead-letter index while retaining complete records by TTL", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const deadLetterPrefix = `test:lilac-delivery:${randomId("bounded-dead-index")}`;
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      recordTtlSeconds: 60,
      indexMaxLen: 2,
    });
    const recordKeys: string[] = [];
    const sourceRecords: EventDeadLetterRecord[] = [];
    const physicalGroup = managedRedisPhysicalGroup("work", "bounded-index");
    try {
      for (let index = 0; index < 5; index += 1) {
        const messageId = `${index}-0`;
        const evidence: EventDeadLetterRecord["evidence"] = {
          source: {
            transport: "redis-streams",
            streamKey: "private-source-stream",
            topic: "test.topic",
            messageId,
          },
          wire: {
            kind: "bounded-complete",
            fields: [],
          },
        };
        const record = createManagedEventDeadLetterRecord({
          topic: "test.topic",
          cursor: messageId,
          mode: "work",
          physicalGroup,
          attempt: 1,
          recordedAt: Date.now(),
          reason: {
            kind: "handler-error",
            errorTag: "HandlerFailure",
            errorMessage: `private-error-${index}`,
          },
          evidence,
        });
        const recordKey = `${deadLetterPrefix}:v3:record:${record.deadLetterId}`;
        recordKeys.push(recordKey);
        sourceRecords.push(record);
        const accepted = await deadLetter.accept(record);
        expect(accepted.status).toBe("ok");
      }

      const indexEntries = await deadLetterIndexEntries(redis, `${deadLetterPrefix}:v3:records`);
      expect(indexEntries).toHaveLength(2);
      expect(JSON.stringify(indexEntries)).not.toContain("private-payload");
      expect(JSON.stringify(indexEntries)).not.toContain("private-error");
      for (const recordKey of recordKeys) {
        expect(recordKey.startsWith(`${deadLetterPrefix}:v3:record:`)).toBe(true);
        expect(await redis.exists(recordKey)).toBe(1);
        const ttl = await redis.ttl(recordKey);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60);
      }
      for (const [index, recordKey] of recordKeys.entries()) {
        const encrypted = await redis.get(recordKey);
        if (encrypted === null) throw new Error("Encrypted dead-letter record is missing");
        expect(encrypted).not.toContain("private-payload");
        expect(encrypted).not.toContain("private-error");
        const recovered = decryptRedisEventDeadLetterRecord({
          encryptionKey: TEST_DEAD_LETTER_KEY,
          expectedIdentity: {
            deadLetterId: sourceRecords[index]!.deadLetterId,
            storageKey: recordKey,
          },
          ciphertextEnvelope: encrypted,
        });
        expect(recovered).toEqual(Result.ok(sourceRecords[index]!));
      }

      const repeated = await deadLetter.accept(sourceRecords[4]!);
      expect(repeated).toEqual(Result.ok({ id: sourceRecords[4]!.deadLetterId }));
      expect(await deadLetterIndexEntries(redis, `${deadLetterPrefix}:v3:records`)).toEqual(
        indexEntries,
      );
    } finally {
      await redis.del(`${deadLetterPrefix}:v3:records`, ...recordKeys);
      await redis.quit();
    }
  });

  it("returns typed record-invalid errors for recovered inconsistent v3 records", () => {
    for (const record of inconsistentDeadLetterRecordFixtures()) {
      const storageKey = `dead-letter:v3:record:${record.deadLetterId}`;
      const encrypted = encryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        kind: "record",
        identity: { deadLetterId: record.deadLetterId, storageKey },
        plaintext: SuperJSON.stringify(record),
      });
      if (encrypted.status === "error") throw encrypted.error;

      const recovered = decryptRedisEventDeadLetterRecord({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        expectedIdentity: { deadLetterId: record.deadLetterId, storageKey },
        ciphertextEnvelope: encrypted.value,
      });
      expect(recovered.status).toBe("error");
      if (recovered.status === "error") {
        expect(recovered.error).toBeInstanceOf(RedisEventDeadLetterRecordInvalid);
      }
    }
  });

  it("returns typed recovery errors for a wrong key and authentication corruption", async () => {
    const redis = new Redis(TEST_REDIS_URL);
    const deadLetterPrefix = `test:lilac-delivery:${randomId("dead-recovery-errors")}`;
    const deadLetter = new RedisEventDeadLetter({
      redis,
      encryptionKey: TEST_DEAD_LETTER_KEY,
      keyPrefix: deadLetterPrefix,
      recordTtlSeconds: 60,
    });
    try {
      const sourceRecord = createManagedEventDeadLetterRecord({
        topic: "test.topic",
        cursor: "1-0",
        mode: "work",
        physicalGroup: managedRedisPhysicalGroup("work", "recovery-errors"),
        attempt: 1,
        recordedAt: 42,
        reason: { kind: "handler-error", errorTag: "Denied", errorMessage: "secret" },
        evidence: {
          source: {
            transport: "redis-streams",
            streamKey: "source",
            topic: "test.topic",
            messageId: "1-0",
          },
          wire: { kind: "bounded-complete", fields: [] },
        },
      });
      const recordKey = `${deadLetterPrefix}:v3:record:${sourceRecord.deadLetterId}`;
      const accepted = await deadLetter.accept(sourceRecord);
      if (accepted.status === "error") throw accepted.error;
      const encrypted = await redis.get(recordKey);
      if (encrypted === null) throw new Error("Encrypted dead-letter record is missing");

      const wrongKey = decryptRedisEventDeadLetterRecord({
        encryptionKey: randomBytes(32),
        expectedIdentity: { deadLetterId: sourceRecord.deadLetterId, storageKey: recordKey },
        ciphertextEnvelope: encrypted,
      });
      expect(wrongKey.status).toBe("error");
      if (wrongKey.status === "error") {
        expect(wrongKey.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
      }

      const envelope = JSON.parse(encrypted);
      if (typeof envelope !== "object" || envelope === null) throw new Error("Envelope is invalid");
      Reflect.set(envelope, "authTag", Buffer.alloc(16, 0).toString("base64"));
      const corrupted = decryptRedisEventDeadLetterRecord({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        expectedIdentity: { deadLetterId: sourceRecord.deadLetterId, storageKey: recordKey },
        ciphertextEnvelope: JSON.stringify(envelope),
      });
      expect(corrupted.status).toBe("error");
      if (corrupted.status === "error") {
        expect(corrupted.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
      }

      const malformed = decryptRedisEventDeadLetterRecord({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        expectedIdentity: { deadLetterId: sourceRecord.deadLetterId, storageKey: recordKey },
        ciphertextEnvelope: "{}",
      });
      expect(malformed.status).toBe("error");
      if (malformed.status === "error") {
        expect(malformed.error).toBeInstanceOf(RedisEventDeadLetterCiphertextInvalid);
      }
    } finally {
      await removeDeadLetters(redis, deadLetterPrefix);
      await redis.quit();
    }
  });

  it("rejects ciphertext substitution between record storage identities", () => {
    const firstIdentity = {
      deadLetterId: "record-a",
      storageKey: "dead-letter:v3:record:record-a",
    };
    const secondIdentity = {
      deadLetterId: "record-b",
      storageKey: "dead-letter:v3:record:record-b",
    };
    const encrypted = encryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "record",
      identity: firstIdentity,
      plaintext: "record-a-secret",
    });
    if (encrypted.status === "error") throw encrypted.error;

    expect(
      decryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        kind: "record",
        expectedIdentity: firstIdentity,
        ciphertextEnvelope: encrypted.value,
      }),
    ).toEqual(Result.ok("record-a-secret"));
    const substituted = decryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "record",
      expectedIdentity: secondIdentity,
      ciphertextEnvelope: encrypted.value,
    });
    expect(substituted.status).toBe("error");
    if (substituted.status === "error") {
      expect(substituted.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
    }
  });

  it("rejects cross-evidence substitution and record/evidence swaps", () => {
    const firstIdentity = {
      deadLetterId: "evidence-a",
      storageKey: "dead-letter:v3:evidence:evidence-a",
    };
    const secondIdentity = {
      deadLetterId: "evidence-b",
      storageKey: "dead-letter:v3:evidence:evidence-b",
    };
    const encryptedEvidence = encryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "evidence",
      identity: firstIdentity,
      plaintext: "evidence-a-secret",
    });
    if (encryptedEvidence.status === "error") throw encryptedEvidence.error;
    const encryptedRecord = encryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "record",
      identity: firstIdentity,
      plaintext: "record-a-secret",
    });
    if (encryptedRecord.status === "error") throw encryptedRecord.error;

    const substituted = decryptRedisEventDeadLetterRecoveryValue({
      encryptionKey: TEST_DEAD_LETTER_KEY,
      kind: "evidence",
      expectedIdentity: secondIdentity,
      ciphertextEnvelope: encryptedEvidence.value,
    });
    expect(substituted.status).toBe("error");
    if (substituted.status === "error") {
      expect(substituted.error).toBeInstanceOf(RedisEventDeadLetterAuthenticationFailed);
    }

    for (const swapped of [
      decryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        kind: "record",
        expectedIdentity: firstIdentity,
        ciphertextEnvelope: encryptedEvidence.value,
      }),
      decryptRedisEventDeadLetterRecoveryValue({
        encryptionKey: TEST_DEAD_LETTER_KEY,
        kind: "evidence",
        expectedIdentity: firstIdentity,
        ciphertextEnvelope: encryptedRecord.value,
      }),
    ]) {
      expect(swapped.status).toBe("error");
      if (swapped.status === "error") {
        expect(swapped.error).toBeInstanceOf(RedisEventDeadLetterContextMismatch);
      }
    }
  });
});
