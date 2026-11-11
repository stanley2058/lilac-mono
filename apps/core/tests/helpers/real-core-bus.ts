import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { Result, type Result as ResultType } from "better-result";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import {
  createLilacBus,
  createRedisStreamsBus,
  managedRedisGroupId,
  RedisEventDeadLetter,
  type DecodedLilacMessage,
} from "@stanley2058/lilac-event-bus";
import { env } from "@stanley2058/lilac-utils";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
  createDurableCoreRequestBus,
  createLilacBusRequestDeliveryPublisher,
  createRequestDeliveryPostCommitObserver,
} from "../../src/surface/bridge/request-delivery";

export function requireBusOk<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

export async function withBusDeadline<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const page = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = page[0];
    keys.push(...page[1]);
  } while (cursor !== "0");
  return keys;
}

async function removeFixtureKeys(redis: Redis, keyPrefix: string): Promise<void> {
  const owned = await scanKeys(redis, `${keyPrefix}:*`);
  for (const key of owned) {
    if ((await redis.type(key)) !== "stream") continue;
    const groups = await redis.xinfo("GROUPS", key);
    if (!Array.isArray(groups)) throw new Error("Invalid Redis consumer group listing");
    for (const group of groups) {
      if (!Array.isArray(group)) throw new Error("Invalid Redis consumer group");
      const name = group[group.indexOf("name") + 1];
      if (typeof name !== "string") throw new Error("Missing Redis consumer group name");
      const metadata = await scanKeys(
        redis,
        `lilac:event-bus:managed-delivery:v2:${managedRedisGroupId(key, name)}:*`,
      );
      if (metadata.length) await redis.del(...metadata);
    }
  }
  if (owned.length) await redis.del(...owned);
}

export async function createRealCoreBusFixture() {
  const keyPrefix = `test:core-real-bus:${crypto.randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "lilac-real-bus-"));
  const setupCleanups: Array<() => void | Promise<void>> = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  try {
    const redis = new Redis(env.redisUrl || "redis://127.0.0.1:6379", {
      lazyConnect: true,
      connectTimeout: 2_000,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    setupCleanups.push(() => redis.disconnect());
    await redis.connect();
    await redis.ping();
    const blobs = requireBusOk(await createMemoryBlobStore());
    setupCleanups.push(async () => {
      requireBusOk(await blobs.close({ deadlineAtMs: Date.now() + 1_000 }));
    });
    const store = new SqliteRequestDeliveryStore({
      dbPath: join(directory, "request-delivery.sqlite"),
      codecs: coreRequestDeliveryCodecs,
    });
    setupCleanups.push(() => store.close());
    const coordinator = new RequestDeliveryCoordinator({
      store,
      blobStore: blobs,
      admission: createCoreRequestDeliveryAdmission(blobs),
    });
    const raw = createRedisStreamsBus({ redis, keyPrefix });
    setupCleanups.push(() => raw.close());
    const deadLetterPrefix = `${keyPrefix}:dead-letter`;
    const deadLetter = new RedisEventDeadLetter({
      redis,
      keyPrefix: deadLetterPrefix,
      encryptionKey: randomBytes(32),
      evidenceBlobStore: blobs,
    });
    const failures: unknown[] = [];
    const subscriptionCompletions: Promise<void>[] = [];
    const subscribe = raw.subscribe.bind(raw);
    raw.subscribe = async (...args) => {
      const started = await subscribe(...args);
      if (started.status === "error") return started;
      subscriptionCompletions.push(
        started.value.done.then(
          (result) => {
            if (result.status === "error") failures.push(result.error);
          },
          (error: unknown) => {
            failures.push(error);
          },
        ),
      );
      return started;
    };
    const commits: Array<{ message: DecodedLilacMessage; cursor: string }> = [];
    const commitWaiters = new Map<string, Array<() => void>>();
    const requestCommitObserver = createRequestDeliveryPostCommitObserver({
      observeTransportCommit: (requestDeliveryId, streamId) =>
        coordinator.observeTransportCommit(requestDeliveryId, streamId),
    });
    const transportBus = createLilacBus(raw, {
      deadLetter,
      reportFatal: {
        report(error) {
          failures.push(error);
        },
      },
      logger: {
        warn(event, context) {
          if (event === "event_bus.contract_invalid") failures.push({ event, context });
        },
        error: (event, context) => failures.push({ event, context }),
      },
      postCommitObserver: {
        async observe(message, context) {
          const recorded = await requestCommitObserver.observe(message, context);
          if (recorded.status === "error") return recorded;
          commits.push({ message, cursor: context.cursor });
          for (const key of [context.cursor, `${message.topic}:${context.cursor}`]) {
            for (const resolve of commitWaiters.get(key) ?? []) resolve();
            commitWaiters.delete(key);
          }
          return Result.ok(undefined);
        },
      },
    });
    const publisher = createLilacBusRequestDeliveryPublisher(transportBus);
    const bus = createDurableCoreRequestBus({ transportBus, coordinator, publisher });
    let closed = false;
    return {
      bus,
      transportBus,
      raw,
      redis,
      store,
      blobs,
      coordinator,
      publisher,
      keyPrefix,
      directory,
      commits,
      async waitForCommit(cursor: string, topic?: string): Promise<void> {
        if (
          commits.some(
            (commit) => commit.cursor === cursor && (!topic || commit.message.topic === topic),
          )
        )
          return;
        const key = topic ? `${topic}:${cursor}` : cursor;
        const committed = Promise.withResolvers<void>();
        const waiters = commitWaiters.get(key) ?? [];
        waiters.push(committed.resolve);
        commitWaiters.set(key, waiters);
        await withBusDeadline(committed.promise, `delivery commit ${cursor}`);
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        const cleanupFailures: unknown[] = [];
        const attempt = async (operation: () => void | Promise<void>) => {
          try {
            await operation();
          } catch (error) {
            cleanupFailures.push(error);
          }
        };
        await attempt(async () => requireBusOk(await bus.close()));
        await attempt(async () => {
          await Promise.all(subscriptionCompletions);
        });
        await attempt(async () => {
          const deadLetters = await redis.zcard(`${deadLetterPrefix}:v3:records`);
          if (deadLetters > 0) failures.push(new Error(`Unexpected dead letters: ${deadLetters}`));
        });
        await attempt(() => removeFixtureKeys(redis, keyPrefix));
        await attempt(() => store.close());
        await attempt(async () => {
          requireBusOk(await blobs.close({ deadlineAtMs: Date.now() + 1_000 }));
        });
        await attempt(async () => {
          await redis.quit();
        });
        redis.disconnect();
        await attempt(() => rm(directory, { recursive: true, force: true }));
        if (failures.length || cleanupFailures.length) {
          throw new AggregateError([...failures, ...cleanupFailures], "Real bus fixture failed");
        }
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const cleanup of setupCleanups.reverse()) {
      try {
        await cleanup();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, "Real bus fixture setup failed");
    throw error;
  }
}
