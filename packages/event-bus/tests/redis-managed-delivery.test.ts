import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";

import { env } from "@stanley2058/lilac-utils";
import { Panic } from "better-result";
import Redis from "ioredis";

import {
  MANAGED_REDIS_DELIVERY_VERSION,
  MANAGED_REDIS_INITIAL_RETRY_DELAY_MS,
  MANAGED_REDIS_MAX_RETRY_DELAY_MS,
  MANAGED_REDIS_RETRY_MULTIPLIER,
  RedisManagedDelivery,
  managedRedisDeliveryId,
  managedRedisPhysicalGroup,
  managedRedisRetryDelayMs,
  type ManagedLease,
  type ManagedTerminalMaterial,
} from "../redis-managed-delivery";
import {
  CLAIM_RECOVERABLE_SCRIPT,
  BEGIN_TERMINAL_SCRIPT,
  FINALIZE_TERMINAL_SCRIPT,
  STAGE_TERMINAL_SCRIPT,
} from "../redis-managed-delivery/lua";

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";

type ManagedKeys = {
  readonly state: string;
  readonly due: string;
  readonly lease: string;
  readonly terminal: string;
  readonly pelCursor: string;
};

type Fixture = {
  readonly redis: Redis;
  readonly streamKey: string;
  readonly physicalGroup: string;
  readonly consumerId: string;
  readonly delivery: RedisManagedDelivery;
  readonly externalKeys: Set<string>;
};

type TerminalMaterialWithEvidence = ManagedTerminalMaterial & {
  readonly evidence: NonNullable<ManagedTerminalMaterial["evidence"]>;
};

function randomId(label: string): string {
  return `${label}:${Date.now()}:${randomUUID()}`;
}

function privateString(target: object, name: string): string {
  const value = Reflect.get(target, name);
  if (typeof value !== "string") throw new Error(`Managed delivery ${name} is unavailable`);
  return value;
}

function managedKeys(delivery: RedisManagedDelivery, id: string): ManagedKeys {
  return {
    state: `${privateString(delivery, "statePrefix")}${id}`,
    due: privateString(delivery, "dueKey"),
    lease: privateString(delivery, "leaseKey"),
    terminal: privateString(delivery, "terminalKey"),
    pelCursor: privateString(delivery, "pelCursorKey"),
  };
}

async function createFixture(label: string, ephemeral = false): Promise<Fixture> {
  const redis = new Redis(TEST_REDIS_URL);
  const prefix = `test:lilac-managed-delivery:${randomId(label)}`;
  const streamKey = `${prefix}:stream`;
  const subscriptionId = randomId(`${label}:group`);
  const physicalGroup = ephemeral
    ? managedRedisPhysicalGroup("work", subscriptionId, true, randomId(`${label}:incarnation`))
    : managedRedisPhysicalGroup("work", subscriptionId);
  const consumerId = randomId(`${label}:consumer`);
  await redis.xadd(streamKey, "*", "fixture", "seed");
  await redis.xgroup("CREATE", streamKey, physicalGroup, "$");
  return {
    redis,
    streamKey,
    physicalGroup,
    consumerId,
    delivery: new RedisManagedDelivery(
      redis,
      streamKey,
      physicalGroup,
      consumerId,
      randomId(`${label}:owner`),
    ),
    externalKeys: new Set<string>(),
  };
}

async function addSource(fixture: Fixture): Promise<string> {
  const id = await fixture.redis.xadd(fixture.streamKey, "*", "event", randomUUID());
  if (typeof id !== "string") throw new Error("Redis did not return a stream entry id");
  return id;
}

async function makePending(fixture: Fixture, consumerId = fixture.consumerId): Promise<string> {
  const id = await addSource(fixture);
  const response = await fixture.redis.xreadgroup(
    "GROUP",
    fixture.physicalGroup,
    consumerId,
    "COUNT",
    1,
    "STREAMS",
    fixture.streamKey,
    ">",
  );
  if (!Array.isArray(response) || response.length !== 1) {
    throw new Error("Redis did not create the expected pending entry");
  }
  return id;
}

async function pendingCount(fixture: Fixture): Promise<number> {
  const pending = (await fixture.redis.xpending(
    fixture.streamKey,
    fixture.physicalGroup,
  )) as unknown;
  if (!Array.isArray(pending) || typeof pending[0] !== "number") {
    throw new Error("Redis returned an invalid pending summary");
  }
  return pending[0];
}

async function pendingOwner(fixture: Fixture, id: string): Promise<string | undefined> {
  const pending = (await fixture.redis.xpending(
    fixture.streamKey,
    fixture.physicalGroup,
    id,
    id,
    1,
  )) as unknown;
  if (!Array.isArray(pending) || pending.length === 0) return undefined;
  const entry = pending[0];
  if (!Array.isArray(entry) || typeof entry[1] !== "string") {
    throw new Error("Redis returned invalid pending ownership");
  }
  return entry[1];
}

async function pendingDeliveryCount(fixture: Fixture, id: string): Promise<number> {
  const pending = (await fixture.redis.xpending(
    fixture.streamKey,
    fixture.physicalGroup,
    id,
    id,
    1,
  )) as unknown;
  if (!Array.isArray(pending) || pending.length !== 1) {
    throw new Error("Redis did not return the expected pending entry");
  }
  const entry = pending[0];
  if (!Array.isArray(entry) || typeof entry[3] !== "number") {
    throw new Error("Redis returned an invalid pending delivery count");
  }
  return entry[3];
}

function terminalMaterial(fixture: Fixture, label: string): TerminalMaterialWithEvidence {
  const prefix = `${fixture.streamKey}:${label}`;
  const material: TerminalMaterialWithEvidence = {
    id: randomId(`${label}:terminal`),
    record: { key: `${prefix}:record`, value: `record-${randomUUID()}` },
    evidence: { key: `${prefix}:evidence`, value: `evidence-${randomUUID()}` },
    index: {
      key: `${prefix}:index`,
      fields: ["kind", "handler-error", "label", label],
      score: Date.now(),
      maxLen: 10,
    },
    ttlSeconds: 60,
  };
  fixture.externalKeys.add(material.record.key);
  fixture.externalKeys.add(material.evidence.key);
  fixture.externalKeys.add(material.index.key);
  return material;
}

async function forceDue(redis: Redis, keys: ManagedKeys, id: string, score: number): Promise<void> {
  await redis.hset(keys.state, "due_at", String(score));
  await redis.zadd(keys.due, score, id);
}

async function forceExpired(
  redis: Redis,
  keys: ManagedKeys,
  id: string,
  index: "lease" | "terminal",
): Promise<void> {
  await redis.hset(keys.state, "lease_deadline", "0");
  await redis.zadd(keys[index], 0, id);
}

function loseNextEvalReply(redis: Redis, targetScript: string, error: Error): void {
  const evaluate = redis.eval.bind(redis);
  let lost = false;
  Reflect.set(redis, "eval", async (script: string, ...args: unknown[]) => {
    const response = await Reflect.apply(evaluate, redis, [script, ...args]);
    if (!lost && script === targetScript) {
      lost = true;
      throw error;
    }
    return response;
  });
}

async function beginFreshInvocation(fixture: Fixture, id: string): Promise<ManagedLease> {
  const claimed = await fixture.delivery.beginFresh(id);
  if (claimed.status !== "claimed") throw new Error("Fresh delivery was not claimed");
  const begun = await fixture.delivery.beginInvocation(id, claimed.claim);
  if (begun.status !== "invoke") throw new Error("Fresh delivery was not invoked");
  return begun.lease;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  try {
    await fixture.delivery.clearAllState();
    await fixture.redis.del(fixture.streamKey, ...fixture.externalKeys);
  } finally {
    await fixture.redis.quit();
  }
}

describe("RedisManagedDelivery identities", () => {
  it("uses versioned physical group names, including ephemeral groups", () => {
    expect(MANAGED_REDIS_DELIVERY_VERSION).toBe(2);
    expect(managedRedisPhysicalGroup("work", "orders")).toBe("__lilac_managed_v2__:work:orders");
    expect(managedRedisPhysicalGroup("fanout", "audit", true, "instance-1")).toBe(
      "__lilac_ephemeral__:__lilac_managed_v2__:fanout:audit:instance-1",
    );
  });

  it("uses deterministic retry jitter bounded to twenty percent of the capped base", () => {
    const deliveryId = managedRedisDeliveryId(
      "test:managed:stream",
      managedRedisPhysicalGroup("work", "retry-jitter"),
      "1-0",
    );

    for (const attempt of [2, 3, 4, 5] as const) {
      const base = Math.min(
        MANAGED_REDIS_MAX_RETRY_DELAY_MS,
        MANAGED_REDIS_INITIAL_RETRY_DELAY_MS * MANAGED_REDIS_RETRY_MULTIPLIER ** (attempt - 2),
      );
      const jitterBound = Math.floor(base / 5);
      const first = managedRedisRetryDelayMs(deliveryId, attempt);
      const second = managedRedisRetryDelayMs(deliveryId, attempt);
      expect(first).toBe(second);
      expect(first).toBeGreaterThanOrEqual(base - jitterBound);
      expect(first).toBeLessThanOrEqual(
        Math.min(MANAGED_REDIS_MAX_RETRY_DELAY_MS, base + jitterBound),
      );
    }
  });

  it("fails closed for malformed state cleanup command responses", async () => {
    const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const delivery = new RedisManagedDelivery(
      redis,
      "test:managed:cleanup:stream",
      managedRedisPhysicalGroup("work", "cleanup-responses"),
      "cleanup-consumer",
      "cleanup-owner",
    );
    const statePrefix = privateString(delivery, "statePrefix");
    let deleteResponse: unknown = 0;
    let scanResponse: unknown = ["0", []];
    let deleteCalls = 0;
    Reflect.set(redis, "scan", async () => scanResponse);
    Reflect.set(redis, "del", async () => {
      deleteCalls += 1;
      return deleteResponse;
    });

    try {
      scanResponse = ["invalid-cursor", []];
      await expect(delivery.clearAllState()).rejects.toBeInstanceOf(Panic);
      expect(deleteCalls).toBe(0);

      scanResponse = ["0", ["unrelated:key"]];
      await expect(delivery.clearAllState()).rejects.toBeInstanceOf(Panic);
      expect(deleteCalls).toBe(0);

      scanResponse = ["0", [`${statePrefix}1-0`]];
      deleteResponse = 2;
      await expect(delivery.clearAllState()).rejects.toBeInstanceOf(Panic);
      expect(deleteCalls).toBe(1);

      scanResponse = ["0", []];
      deleteResponse = "0";
      await expect(delivery.clearAllState()).rejects.toBeInstanceOf(Panic);
      expect(deleteCalls).toBe(2);
    } finally {
      redis.disconnect();
    }
  });
});

describe("RedisManagedDelivery Lua transitions", () => {
  it("requires a pending source before beginning attempt 1", async () => {
    const fixture = await createFixture("begin-fresh");
    try {
      const id = await addSource(fixture);
      await expect(fixture.delivery.beginFresh(id)).rejects.toBeInstanceOf(Panic);
      expect(await fixture.redis.exists(managedKeys(fixture.delivery, id).state)).toBe(0);

      await fixture.redis.xreadgroup(
        "GROUP",
        fixture.physicalGroup,
        fixture.consumerId,
        "COUNT",
        1,
        "STREAMS",
        fixture.streamKey,
        ">",
      );
      const claimed = await fixture.delivery.beginFresh(id);
      expect(claimed.status).toBe("claimed");
      if (claimed.status !== "claimed") throw new Error("Fresh delivery was not claimed");
      expect(claimed.claim.completedAttempts).toBe(0);
      expect(await fixture.redis.hget(managedKeys(fixture.delivery, id).state, "state")).toBe(
        "claimed",
      );
      const begun = await fixture.delivery.beginInvocation(id, claimed.claim);
      if (begun.status !== "invoke") throw new Error("Fresh delivery was not invoked");
      expect(begun.lease.attempt).toBe(1);
      expect(begun.lease.deliveryId).toBe(
        managedRedisDeliveryId(fixture.streamKey, fixture.physicalGroup, id),
      );
      expect(await fixture.redis.hgetall(managedKeys(fixture.delivery, id).state)).toMatchObject({
        version: "2",
        id,
        state: "in-flight",
        attempt: "1",
        consumer_id: fixture.consumerId,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("ignores an elevated Redis PEL delivery count when beginning attempt 1", async () => {
    const fixture = await createFixture("pel-delivery-count");
    try {
      const id = await makePending(fixture);
      await fixture.redis.xclaim(
        fixture.streamKey,
        fixture.physicalGroup,
        fixture.consumerId,
        0,
        id,
      );
      await fixture.redis.xclaim(
        fixture.streamKey,
        fixture.physicalGroup,
        fixture.consumerId,
        0,
        id,
      );
      expect(await pendingDeliveryCount(fixture, id)).toBeGreaterThan(1);

      const claimed = await fixture.delivery.beginFresh(id);
      if (claimed.status !== "claimed") throw new Error("Fresh delivery was not claimed");
      expect(claimed.claim.completedAttempts).toBe(0);
      const begun = await fixture.delivery.beginInvocation(id, claimed.claim);
      if (begun.status !== "invoke") throw new Error("Fresh delivery was not invoked");
      expect(begun.lease.attempt).toBe(1);
      expect(await fixture.redis.hget(managedKeys(fixture.delivery, id).state, "attempt")).toBe(
        "1",
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("extends heartbeats and fences every mutation made with a stale token", async () => {
    const fixture = await createFixture("heartbeat-fence");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const keys = managedKeys(fixture.delivery, id);
      const shortenedDeadline = lease.leaseDeadline - 1_000;
      await fixture.redis.hset(keys.state, "lease_deadline", String(shortenedDeadline));
      await fixture.redis.zadd(keys.lease, shortenedDeadline, id);

      const heartbeat = await fixture.delivery.heartbeat(id, lease);
      expect(heartbeat.status).toBe("extended");
      if (heartbeat.status !== "extended") throw new Error("Heartbeat was not extended");
      expect(heartbeat.lease.leaseDeadline).toBeGreaterThan(shortenedDeadline);
      expect(await fixture.redis.zscore(keys.lease, id)).toBe(
        String(heartbeat.lease.leaseDeadline),
      );

      const stale: ManagedLease = { ...heartbeat.lease, token: randomUUID() };
      const material = terminalMaterial(fixture, "stale-token");
      expect(await fixture.delivery.heartbeat(id, stale)).toEqual({ status: "stale" });
      expect(await fixture.delivery.commit(id, stale)).toEqual({ status: "stale" });
      expect(
        await fixture.delivery.scheduleRetry(id, stale, {
          kind: "handler-error",
          errorTag: "Stale",
          errorMessage: "must not retry",
        }),
      ).toEqual({ status: "stale" });
      expect(await fixture.delivery.park(id, stale)).toEqual({ status: "stale" });
      expect(
        await fixture.delivery.beginTerminal(id, stale, {
          kind: "handler-error",
          errorTag: "Stale",
          errorMessage: "must not terminalize",
        }),
      ).toEqual({ status: "stale" });
      expect(await fixture.delivery.stageTerminal(id, stale, material)).toEqual({
        status: "stale",
      });
      expect(await fixture.redis.get(material.record.key)).toBeNull();
      expect(await fixture.delivery.commit(id, heartbeat.lease)).toEqual({ status: "committed" });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("fences terminal finalization with a stale token", async () => {
    const fixture = await createFixture("stale-terminal-finalize");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const material = terminalMaterial(fixture, "stale-terminal-finalize");
      const preparing = await fixture.delivery.beginTerminal(id, lease, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "fence finalization",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      expect(await fixture.delivery.stageTerminal(id, preparing.lease, material)).toEqual({
        status: "staged",
      });
      const stale = { ...preparing.lease, token: randomUUID() };

      expect(await fixture.delivery.finalizeTerminal(id, stale)).toEqual({ status: "stale" });
      expect(await pendingCount(fixture)).toBe(1);
      expect(await fixture.redis.get(material.record.key)).toBeNull();
      expect(await fixture.delivery.finalizeTerminal(id, preparing.lease)).toEqual({
        status: "finalized",
        id: material.id,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("atomically acknowledges commits and removes message state and indexes", async () => {
    const fixture = await createFixture("commit");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const keys = managedKeys(fixture.delivery, id);
      expect(await pendingCount(fixture)).toBe(1);
      expect(await fixture.redis.exists(keys.state)).toBe(1);

      expect(await fixture.delivery.commit(id, lease)).toEqual({ status: "committed" });
      expect(await pendingCount(fixture)).toBe(0);
      expect(await fixture.redis.exists(keys.state)).toBe(0);
      expect(await fixture.redis.zscore(keys.due, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.lease, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.terminal, id)).toBeNull();
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("persists retry due state across instances and claims it as attempt 2 only when due", async () => {
    const fixture = await createFixture("persisted-retry");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const scheduled = await fixture.delivery.scheduleRetry(id, lease, {
        kind: "handler-error",
        errorTag: "Retryable",
        errorMessage: "try again",
      });
      expect(scheduled.status).toBe("scheduled");
      const keys = managedKeys(fixture.delivery, id);
      await forceDue(fixture.redis, keys, id, 9_999_999_999_999);

      const nextConsumer = randomId("persisted-retry:next-consumer");
      const recoveredByNewInstance = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        nextConsumer,
        randomId("persisted-retry:next-owner"),
      );
      expect(await recoveredByNewInstance.claimRecoverable()).toEqual({ status: "none" });
      expect(await fixture.redis.hget(keys.state, "state")).toBe("retry-scheduled");

      await forceDue(fixture.redis, keys, id, 0);
      const recovered = await recoveredByNewInstance.claimRecoverable();
      expect(recovered.status).toBe("claimed");
      if (recovered.status !== "claimed") throw new Error("Due retry was not recovered");
      expect(recovered.id).toBe(id);
      expect(recovered.claim.completedAttempts).toBe(1);
      const invoked = await recoveredByNewInstance.beginInvocation(id, recovered.claim);
      if (invoked.status !== "invoke") throw new Error("Due retry was not invoked");
      expect(invoked.lease.attempt).toBe(2);
      expect(await pendingOwner(fixture, id)).toBe(nextConsumer);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("gives exactly one owner an expired attempt under claim contention", async () => {
    const fixture = await createFixture("claim-contention");
    const firstRedis = fixture.redis.duplicate();
    const secondRedis = fixture.redis.duplicate();
    try {
      const id = await makePending(fixture);
      await beginFreshInvocation(fixture, id);
      await forceExpired(fixture.redis, managedKeys(fixture.delivery, id), id, "lease");

      const firstConsumer = randomId("claim-contention:first");
      const secondConsumer = randomId("claim-contention:second");
      const first = new RedisManagedDelivery(
        firstRedis,
        fixture.streamKey,
        fixture.physicalGroup,
        firstConsumer,
        randomId("claim-contention:first-owner"),
      );
      const second = new RedisManagedDelivery(
        secondRedis,
        fixture.streamKey,
        fixture.physicalGroup,
        secondConsumer,
        randomId("claim-contention:second-owner"),
      );
      const claims = await Promise.all([first.claimRecoverable(), second.claimRecoverable()]);
      const claimed = claims.filter((claim) => claim.status === "claimed");
      expect(claimed).toHaveLength(1);
      expect(claims.filter((claim) => claim.status === "none")).toHaveLength(1);
      const winner = claimed[0];
      if (winner?.status !== "claimed") throw new Error("Expired attempt had no winner");
      expect(winner.id).toBe(id);
      expect(winner.claim.completedAttempts).toBe(1);
      const owner = await pendingOwner(fixture, id);
      if (owner === undefined) throw new Error("Winning claim did not own the pending entry");
      expect([firstConsumer, secondConsumer]).toContain(owner);
    } finally {
      firstRedis.disconnect();
      secondRedis.disconnect();
      await cleanupFixture(fixture);
    }
  });

  it("skips an orphan committed between discovery and resolution", async () => {
    const fixture = await createFixture("orphan-commit-race");
    try {
      const id = await makePending(fixture);
      const evaluate = fixture.redis.eval.bind(fixture.redis);
      let intercepted = false;
      Reflect.set(fixture.redis, "eval", async (...args: Parameters<typeof fixture.redis.eval>) => {
        const result = await evaluate(...args);
        if (args[0] === CLAIM_RECOVERABLE_SCRIPT && !intercepted) {
          intercepted = true;
          const lease = await beginFreshInvocation(fixture, id);
          expect(await fixture.delivery.commit(id, lease)).toEqual({ status: "committed" });
        }
        return result;
      });
      expect(await fixture.delivery.claimRecoverable()).toEqual({ status: "none" });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("claims a metadata-free PEL orphan as attempt 1", async () => {
    const fixture = await createFixture("pel-orphan");
    try {
      const id = await makePending(fixture);
      const nextConsumer = randomId("pel-orphan:consumer");
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        nextConsumer,
        randomId("pel-orphan:owner"),
      );
      expect(await fixture.redis.exists(managedKeys(fixture.delivery, id).state)).toBe(0);

      const claimed = await recovery.claimRecoverable();
      expect(claimed.status).toBe("claimed");
      if (claimed.status !== "claimed") throw new Error("PEL orphan was not claimed");
      expect(claimed.id).toBe(id);
      expect(claimed.claim.completedAttempts).toBe(0);
      expect(claimed.claim.deliveryId).toBe(
        managedRedisDeliveryId(fixture.streamKey, fixture.physicalGroup, id),
      );
      expect(await pendingOwner(fixture, id)).toBe(nextConsumer);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("fails closed when a metadata-free PEL orphan has no source body", async () => {
    const fixture = await createFixture("pel-orphan-source-missing");
    try {
      const id = await makePending(fixture);
      const keys = managedKeys(fixture.delivery, id);
      expect(await fixture.redis.xdel(fixture.streamKey, id)).toBe(1);

      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("pel-orphan-source-missing:consumer"),
        randomId("pel-orphan-source-missing:owner"),
      );
      await expect(recovery.claimRecoverable()).rejects.toBeInstanceOf(Panic);
      expect(await pendingCount(fixture)).toBe(1);
      expect(await fixture.redis.exists(keys.state)).toBe(0);
      expect(await fixture.redis.zscore(keys.due, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.lease, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.terminal, id)).toBeNull();
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("advances the durable PEL cursor past 64 parked rows to claim an orphan", async () => {
    const fixture = await createFixture("pel-orphan-cursor");
    try {
      for (let index = 0; index < 64; index += 1) {
        const parkedId = await makePending(fixture);
        const lease = await beginFreshInvocation(fixture, parkedId);
        expect(await fixture.delivery.park(parkedId, lease)).toEqual({ status: "parked" });
      }
      const orphanId = await makePending(fixture);
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("pel-orphan-cursor:consumer"),
        randomId("pel-orphan-cursor:owner"),
      );

      expect(await recovery.claimRecoverable()).toEqual({ status: "none" });
      const claimed = await recovery.claimRecoverable();
      if (claimed.status !== "claimed") throw new Error("PEL cursor did not reach the orphan");
      expect(claimed.id).toBe(orphanId);
      expect(claimed.claim.completedAttempts).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("advances the orphan cursor while terminal and due recovery remain available", async () => {
    const fixture = await createFixture("pel-orphan-index-fairness");
    try {
      const terminalId = await makePending(fixture);
      const terminalLease = await beginFreshInvocation(fixture, terminalId);
      const material = terminalMaterial(fixture, "pel-orphan-index-fairness");
      const preparing = await fixture.delivery.beginTerminal(terminalId, terminalLease, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "recover first",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal fixture was not prepared");
      expect(await fixture.delivery.stageTerminal(terminalId, preparing.lease, material)).toEqual({
        status: "staged",
      });
      await forceExpired(
        fixture.redis,
        managedKeys(fixture.delivery, terminalId),
        terminalId,
        "terminal",
      );

      const dueId = await makePending(fixture);
      const dueLease = await beginFreshInvocation(fixture, dueId);
      const scheduled = await fixture.delivery.scheduleRetry(dueId, dueLease, {
        kind: "handler-error",
        errorTag: "Retry",
        errorMessage: "recover second",
      });
      if (scheduled.status !== "scheduled") throw new Error("Due fixture was not scheduled");
      await forceDue(fixture.redis, managedKeys(fixture.delivery, dueId), dueId, 0);

      for (let index = 0; index < 128; index += 1) {
        const parkedId = await makePending(fixture);
        const lease = await beginFreshInvocation(fixture, parkedId);
        expect(await fixture.delivery.park(parkedId, lease)).toEqual({ status: "parked" });
      }
      const orphanId = await makePending(fixture);
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("pel-orphan-index-fairness:consumer"),
        randomId("pel-orphan-index-fairness:owner"),
      );
      const keys = managedKeys(fixture.delivery, orphanId);

      const terminal = await recovery.claimRecoverable();
      expect(terminal.status).toBe("terminal");
      const firstCursor = await fixture.redis.get(keys.pelCursor);
      expect(firstCursor).not.toBeNull();
      expect(firstCursor).not.toBe("-");

      const due = await recovery.claimRecoverable();
      expect(due.status).toBe("claimed");
      if (due.status !== "claimed") throw new Error("Due fixture was not recovered");
      expect(due.id).toBe(dueId);
      const secondCursor = await fixture.redis.get(keys.pelCursor);
      expect(secondCursor).not.toBe(firstCursor);
      expect(secondCursor).not.toBe("-");

      const orphan = await recovery.claimRecoverable();
      if (orphan.status !== "claimed") throw new Error("PEL orphan was not recovered fairly");
      expect(orphan.id).toBe(orphanId);
      expect(orphan.claim.completedAttempts).toBe(0);
      expect(await fixture.redis.get(keys.pelCursor)).toBe("-");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("rejects a malformed durable PEL cursor type and removes it during cleanup", async () => {
    const fixture = await createFixture("pel-cursor-type");
    try {
      const keys = managedKeys(fixture.delivery, "1-0");
      await fixture.redis.lpush(keys.pelCursor, "invalid");
      await expect(fixture.delivery.claimRecoverable()).rejects.toBeInstanceOf(Panic);
      await fixture.delivery.clearAllState();
      expect(await fixture.redis.exists(keys.pelCursor)).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("never reclaims a manually parked delivery", async () => {
    const fixture = await createFixture("parked");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      expect(await fixture.delivery.park(id, lease)).toEqual({ status: "parked" });
      const keys = managedKeys(fixture.delivery, id);
      expect(await fixture.redis.hget(keys.state, "state")).toBe("parked-manual");
      expect(await fixture.redis.zscore(keys.due, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.lease, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.terminal, id)).toBeNull();

      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("parked:consumer"),
        randomId("parked:owner"),
      );
      expect(await recovery.claimRecoverable()).toEqual({ status: "none" });
      expect(await pendingCount(fixture)).toBe(1);
      expect(await fixture.redis.hget(keys.state, "state")).toBe("parked-manual");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("exhausts attempt 5 and atomically finalizes one terminal record and index", async () => {
    const fixture = await createFixture("attempt-exhaustion");
    try {
      const id = await makePending(fixture);
      const begun = await beginFreshInvocation(fixture, id);
      const keys = managedKeys(fixture.delivery, id);
      let manager = fixture.delivery;
      let lease: ManagedLease = begun;

      for (const nextAttempt of [2, 3, 4, 5] as const) {
        const scheduled = await manager.scheduleRetry(id, lease, {
          kind: "handler-error",
          errorTag: `Attempt${lease.attempt}`,
          errorMessage: `failed attempt ${lease.attempt}`,
        });
        if (scheduled.status !== "scheduled") throw new Error("Retry was not scheduled");
        await forceDue(fixture.redis, keys, id, 0);
        manager = new RedisManagedDelivery(
          fixture.redis,
          fixture.streamKey,
          fixture.physicalGroup,
          randomId(`attempt-${nextAttempt}:consumer`),
          randomId(`attempt-${nextAttempt}:owner`),
        );
        const claimed = await manager.claimRecoverable();
        if (claimed.status !== "claimed") throw new Error("Scheduled retry was not claimed");
        expect(claimed.id).toBe(id);
        expect(claimed.claim.completedAttempts).toBe((nextAttempt - 1) as 1 | 2 | 3 | 4);
        const invoked = await manager.beginInvocation(id, claimed.claim);
        if (invoked.status !== "invoke") throw new Error("Scheduled retry was not invoked");
        expect(invoked.lease.attempt).toBe(nextAttempt);
        lease = invoked.lease;
      }

      const exhausted = await manager.scheduleRetry(id, lease, {
        kind: "handler-error",
        errorTag: "FinalFailure",
        errorMessage: "attempt five failed",
      });
      expect(exhausted.status).toBe("exhausted");
      if (exhausted.status !== "exhausted") throw new Error("Attempt five did not exhaust");
      expect(exhausted.lease.attempt).toBe(5);
      expect(exhausted.finalFailure).toEqual({
        kind: "handler-error",
        errorTag: "FinalFailure",
        errorMessage: "attempt five failed",
      });

      const material = terminalMaterial(fixture, "attempt-exhaustion");
      const preparing = await manager.beginTerminal(id, exhausted.lease, {
        kind: "attempts-exhausted",
        finalFailure: exhausted.finalFailure,
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      expect(await manager.stageTerminal(id, preparing.lease, material)).toEqual({
        status: "staged",
      });
      expect(await fixture.redis.get(material.record.key)).toBeNull();
      expect(await fixture.redis.zcard(material.index.key)).toBe(0);

      const finalized = await manager.finalizeTerminal(id, preparing.lease);
      expect(finalized.status).toBe("finalized");
      expect(await fixture.redis.get(material.record.key)).toBe(material.record.value);
      expect(await fixture.redis.get(material.evidence.key)).toBe(material.evidence.value);
      expect(await fixture.redis.zcard(material.index.key)).toBe(1);
      expect(await fixture.redis.zrange(material.index.key, 0, -1, "WITHSCORES")).toEqual([
        JSON.stringify(material.index.fields),
        String(material.index.score),
      ]);
      expect(await pendingCount(fixture)).toBe(0);
      expect(await fixture.redis.exists(keys.state)).toBe(0);
      expect(await fixture.redis.zscore(keys.due, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.lease, id)).toBeNull();
      expect(await fixture.redis.zscore(keys.terminal, id)).toBeNull();
      expect(await manager.finalizeTerminal(id, preparing.lease)).toEqual({ status: "stale" });
      expect(await fixture.redis.zcard(material.index.key)).toBe(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("returns exhaustion when attempt 5 expires instead of beginning a sixth invocation", async () => {
    const fixture = await createFixture("expired-attempt-five");
    try {
      const id = await makePending(fixture);
      const keys = managedKeys(fixture.delivery, id);
      let manager = fixture.delivery;
      let lease = await beginFreshInvocation(fixture, id);
      for (const nextAttempt of [2, 3, 4, 5] as const) {
        const scheduled = await manager.scheduleRetry(id, lease, {
          kind: "handler-error",
          errorTag: `Attempt${lease.attempt}`,
          errorMessage: "retry",
        });
        if (scheduled.status !== "scheduled") throw new Error("Retry was not scheduled");
        await forceDue(fixture.redis, keys, id, 0);
        manager = new RedisManagedDelivery(
          fixture.redis,
          fixture.streamKey,
          fixture.physicalGroup,
          randomId(`expired-attempt-five:${nextAttempt}:consumer`),
          randomId(`expired-attempt-five:${nextAttempt}:owner`),
        );
        const claimed = await manager.claimRecoverable();
        if (claimed.status !== "claimed") throw new Error("Retry was not claimed");
        const invoked = await manager.beginInvocation(id, claimed.claim);
        if (invoked.status !== "invoke") throw new Error("Retry was not invoked");
        lease = invoked.lease;
      }

      await forceExpired(fixture.redis, keys, id, "lease");
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("expired-attempt-five:final-consumer"),
        randomId("expired-attempt-five:final-owner"),
      );
      const exhausted = await recovery.claimRecoverable();
      if (exhausted.status !== "exhausted") throw new Error("Attempt 5 was not exhausted");
      expect(exhausted.lease.attempt).toBe(5);
      expect(exhausted.finalFailure).toEqual({ kind: "lease-expired" });
      expect(await fixture.redis.hget(keys.state, "state")).toBe("claimed");
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("recovers staged terminal material on another consumer and finalizes without invocation", async () => {
    const fixture = await createFixture("terminal-recovery");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const material = terminalMaterial(fixture, "terminal-recovery");
      const preparing = await fixture.delivery.beginTerminal(id, lease, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "recover material",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      expect(await fixture.delivery.stageTerminal(id, preparing.lease, material)).toEqual({
        status: "staged",
      });
      await forceExpired(fixture.redis, managedKeys(fixture.delivery, id), id, "terminal");

      const nextConsumer = randomId("terminal-recovery:consumer");
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        nextConsumer,
        randomId("terminal-recovery:owner"),
      );
      const claimed = await recovery.claimRecoverable();
      expect(claimed.status).toBe("terminal");
      if (claimed.status !== "terminal") throw new Error("Terminal material was not recovered");
      expect(claimed.id).toBe(id);
      expect(claimed.lease.attempt).toBe(1);
      expect(claimed.material).toEqual(material);
      expect(await pendingOwner(fixture, id)).toBe(nextConsumer);
      expect(await recovery.finalizeTerminal(id, claimed.lease)).toMatchObject({
        status: "finalized",
      });
      expect(await fixture.redis.get(material.record.key)).toBe(material.record.value);
      expect(await fixture.redis.zcard(material.index.key)).toBe(1);
      expect(await pendingCount(fixture)).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("recovers pending terminal material after the stage reply is lost", async () => {
    const fixture = await createFixture("terminal-stage-lost-reply");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const keys = managedKeys(fixture.delivery, id);
      const material = terminalMaterial(fixture, "terminal-stage-lost-reply");
      const preparing = await fixture.delivery.beginTerminal(id, lease, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "lose stage reply",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      const lostReply = new Error("stageTerminal reply lost");
      loseNextEvalReply(fixture.redis, STAGE_TERMINAL_SCRIPT, lostReply);

      await expect(fixture.delivery.stageTerminal(id, preparing.lease, material)).rejects.toBe(
        lostReply,
      );
      expect(await pendingCount(fixture)).toBe(1);
      expect(await fixture.redis.hget(keys.state, "state")).toBe("dead-letter-pending");
      expect(await fixture.redis.get(material.record.key)).toBeNull();
      expect(await fixture.redis.zcard(material.index.key)).toBe(0);

      await forceExpired(fixture.redis, keys, id, "terminal");
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("terminal-stage-lost-reply:consumer"),
        randomId("terminal-stage-lost-reply:owner"),
      );
      const recovered = await recovery.claimRecoverable();
      if (recovered.status !== "terminal") throw new Error("Terminal material was not recovered");
      expect(recovered.material).toEqual(material);
      expect(await recovery.finalizeTerminal(id, recovered.lease)).toEqual({
        status: "finalized",
        id: material.id,
      });
      expect(await fixture.redis.get(material.record.key)).toBe(material.record.value);
      expect(await fixture.redis.zcard(material.index.key)).toBe(1);
      expect(await pendingCount(fixture)).toBe(0);
      expect(await fixture.redis.exists(keys.state)).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("recovers terminal preparation after the begin reply is lost", async () => {
    const fixture = await createFixture("terminal-begin-lost-reply");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const keys = managedKeys(fixture.delivery, id);
      const reason = {
        kind: "handler-error" as const,
        errorTag: "Terminal",
        errorMessage: "lose begin reply",
      };
      const lostReply = new Error("beginTerminal reply lost");
      loseNextEvalReply(fixture.redis, BEGIN_TERMINAL_SCRIPT, lostReply);

      await expect(fixture.delivery.beginTerminal(id, lease, reason)).rejects.toBe(lostReply);
      expect(await pendingCount(fixture)).toBe(1);
      expect(await fixture.redis.hget(keys.state, "state")).toBe("terminal-preparing");

      await forceExpired(fixture.redis, keys, id, "terminal");
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("terminal-begin-lost-reply:consumer"),
        randomId("terminal-begin-lost-reply:owner"),
      );
      const recovered = await recovery.claimRecoverable();
      if (recovered.status !== "prepare-terminal") {
        throw new Error("Terminal preparation was not recovered");
      }
      expect(recovered.reason).toEqual(reason);
      const material = terminalMaterial(fixture, "terminal-begin-lost-reply");
      expect(await recovery.stageTerminal(id, recovered.lease, material)).toEqual({
        status: "staged",
      });
      expect(await recovery.finalizeTerminal(id, recovered.lease)).toEqual({
        status: "finalized",
        id: material.id,
      });
      expect(await pendingCount(fixture)).toBe(0);
      expect(await fixture.redis.get(material.record.key)).toBe(material.record.value);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("persists one terminal record and acknowledges the source when the finalize reply is lost", async () => {
    const fixture = await createFixture("terminal-finalize-lost-reply");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const keys = managedKeys(fixture.delivery, id);
      const material = terminalMaterial(fixture, "terminal-finalize-lost-reply");
      const preparing = await fixture.delivery.beginTerminal(id, lease, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "lose finalize reply",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      expect(await fixture.delivery.stageTerminal(id, preparing.lease, material)).toEqual({
        status: "staged",
      });
      const lostReply = new Error("finalizeTerminal reply lost");
      loseNextEvalReply(fixture.redis, FINALIZE_TERMINAL_SCRIPT, lostReply);

      await expect(fixture.delivery.finalizeTerminal(id, preparing.lease)).rejects.toBe(lostReply);
      expect(await fixture.redis.get(material.record.key)).toBe(material.record.value);
      expect(await fixture.redis.get(material.evidence.key)).toBe(material.evidence.value);
      expect(await fixture.redis.zcard(material.index.key)).toBe(1);
      expect(await pendingCount(fixture)).toBe(0);
      expect(await fixture.redis.exists(keys.state)).toBe(0);

      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("terminal-finalize-lost-reply:consumer"),
        randomId("terminal-finalize-lost-reply:owner"),
      );
      expect(await recovery.claimRecoverable()).toEqual({ status: "none" });
      expect(await fixture.delivery.finalizeTerminal(id, preparing.lease)).toEqual({
        status: "stale",
      });
      expect(await fixture.redis.zcard(material.index.key)).toBe(1);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("bounds multibyte terminal reasons by UTF-8 bytes through recovery and finalization", async () => {
    const fixture = await createFixture("multibyte-terminal-reason");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const oversized = "🙂".repeat(200);
      const bounded = "🙂".repeat(128);
      const preparing = await fixture.delivery.beginTerminal(id, lease, {
        kind: "handler-error",
        errorTag: oversized,
        errorMessage: oversized,
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      expect(preparing.reason).toEqual({
        kind: "handler-error",
        errorTag: bounded,
        errorMessage: bounded,
      });
      if (preparing.reason.kind !== "handler-error") throw new Error("Unexpected terminal reason");
      expect(Buffer.byteLength(preparing.reason.errorTag, "utf8")).toBe(512);
      expect(Buffer.byteLength(preparing.reason.errorMessage, "utf8")).toBe(512);

      await forceExpired(fixture.redis, managedKeys(fixture.delivery, id), id, "terminal");
      const stagingConsumer = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("multibyte-terminal-reason:staging-consumer"),
        randomId("multibyte-terminal-reason:staging-owner"),
      );
      const recoveredReason = await stagingConsumer.claimRecoverable();
      if (recoveredReason.status !== "prepare-terminal") {
        throw new Error("Terminal reason was not recovered");
      }
      expect(recoveredReason.reason).toEqual(preparing.reason);

      const material = terminalMaterial(fixture, "multibyte-terminal-reason");
      expect(await stagingConsumer.stageTerminal(id, recoveredReason.lease, material)).toEqual({
        status: "staged",
      });
      await forceExpired(fixture.redis, managedKeys(fixture.delivery, id), id, "terminal");

      const finalizingConsumer = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("multibyte-terminal-reason:finalizing-consumer"),
        randomId("multibyte-terminal-reason:finalizing-owner"),
      );
      const recoveredMaterial = await finalizingConsumer.claimRecoverable();
      if (recoveredMaterial.status !== "terminal") {
        throw new Error("Terminal material was not recovered");
      }
      expect(recoveredMaterial.material).toEqual(material);
      expect(await finalizingConsumer.finalizeTerminal(id, recoveredMaterial.lease)).toEqual({
        status: "finalized",
        id: material.id,
      });
      expect(await pendingCount(fixture)).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("accepts multibyte terminal index values at the exact UTF-8 byte bound", async () => {
    const fixture = await createFixture("multibyte-terminal-index");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const preparing = await fixture.delivery.beginTerminal(id, lease, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "multibyte index",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      const baseMaterial = terminalMaterial(fixture, "multibyte-terminal-index");
      const fields = ["é".repeat(512), "🙂".repeat(256)] as const;
      const material: TerminalMaterialWithEvidence = {
        ...baseMaterial,
        index: { ...baseMaterial.index, fields },
      };
      expect(fields.map((value) => Buffer.byteLength(value, "utf8"))).toEqual([1024, 1024]);
      expect(await fixture.delivery.stageTerminal(id, preparing.lease, material)).toEqual({
        status: "staged",
      });

      await forceExpired(fixture.redis, managedKeys(fixture.delivery, id), id, "terminal");
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("multibyte-terminal-index:consumer"),
        randomId("multibyte-terminal-index:owner"),
      );
      const recovered = await recovery.claimRecoverable();
      if (recovered.status !== "terminal") throw new Error("Terminal material was not recovered");
      expect(recovered.material.index.fields).toEqual(fields);
      expect(await recovery.finalizeTerminal(id, recovered.lease)).toEqual({
        status: "finalized",
        id: material.id,
      });
      expect(await fixture.redis.zrange(material.index.key, 0, -1)).toEqual([
        JSON.stringify(fields),
      ]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("retries partial terminal material without adding another logical index member", async () => {
    const fixture = await createFixture("terminal-finalize-resume");
    try {
      const id = await makePending(fixture);
      const lease = await beginFreshInvocation(fixture, id);
      const preparing = await fixture.delivery.beginTerminal(id, lease, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "resume finalization",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      const material = terminalMaterial(fixture, "terminal-finalize-resume");
      const staged = await fixture.delivery.stageTerminal(id, preparing.lease, material);
      if (staged.status !== "staged") throw new Error("Terminal material was not staged");

      await fixture.redis.set(material.evidence.key, material.evidence.value);
      await fixture.redis.set(material.record.key, material.record.value);
      await fixture.redis.zadd(
        material.index.key,
        material.index.score,
        JSON.stringify(material.index.fields),
      );
      await forceExpired(fixture.redis, managedKeys(fixture.delivery, id), id, "terminal");
      const recovery = new RedisManagedDelivery(
        fixture.redis,
        fixture.streamKey,
        fixture.physicalGroup,
        randomId("terminal-finalize-resume:consumer"),
        randomId("terminal-finalize-resume:owner"),
      );
      const recovered = await recovery.claimRecoverable();
      if (recovered.status !== "terminal")
        throw new Error("Terminal finalization was not recovered");

      expect(await recovery.finalizeTerminal(id, recovered.lease)).toEqual({
        status: "finalized",
        id: material.id,
      });
      expect(await fixture.redis.zrange(material.index.key, 0, -1, "WITHSCORES")).toEqual([
        JSON.stringify(material.index.fields),
        String(material.index.score),
      ]);
      expect(await fixture.redis.ttl(material.record.key)).toBeGreaterThan(0);
      expect(await fixture.redis.ttl(material.evidence.key)).toBeGreaterThan(0);
      expect(await pendingCount(fixture)).toBe(0);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it("clears ephemeral parked metadata and every managed index", async () => {
    const fixture = await createFixture("ephemeral-clear", true);
    try {
      expect(fixture.physicalGroup).toStartWith("__lilac_ephemeral__:__lilac_managed_v2__:work:");
      const parkedId = await makePending(fixture);
      const parked = await beginFreshInvocation(fixture, parkedId);
      expect(await fixture.delivery.park(parkedId, parked)).toEqual({ status: "parked" });

      const dueId = await makePending(fixture);
      const due = await beginFreshInvocation(fixture, dueId);
      const scheduled = await fixture.delivery.scheduleRetry(dueId, due, {
        kind: "handler-error",
        errorTag: "Retry",
        errorMessage: "scheduled",
      });
      if (scheduled.status !== "scheduled") throw new Error("Due fixture was not scheduled");

      const leaseId = await makePending(fixture);
      await beginFreshInvocation(fixture, leaseId);

      const terminalId = await makePending(fixture);
      const terminal = await beginFreshInvocation(fixture, terminalId);
      const material = terminalMaterial(fixture, "ephemeral-clear");
      const preparing = await fixture.delivery.beginTerminal(terminalId, terminal, {
        kind: "handler-error",
        errorTag: "Terminal",
        errorMessage: "clear",
      });
      if (preparing.status !== "preparing") throw new Error("Terminal state was not prepared");
      expect(await fixture.delivery.stageTerminal(terminalId, preparing.lease, material)).toEqual({
        status: "staged",
      });

      const ids = [parkedId, dueId, leaseId, terminalId];
      const keys = ids.map((id) => managedKeys(fixture.delivery, id));
      expect(await fixture.redis.hget(keys[0]!.state, "state")).toBe("parked-manual");
      expect(await fixture.redis.zcard(keys[0]!.due)).toBe(1);
      expect(await fixture.redis.zcard(keys[0]!.lease)).toBe(1);
      expect(await fixture.redis.zcard(keys[0]!.terminal)).toBe(1);

      await fixture.delivery.clearAllState();
      for (const key of keys) expect(await fixture.redis.exists(key.state)).toBe(0);
      expect(await fixture.redis.exists(keys[0]!.due)).toBe(0);
      expect(await fixture.redis.exists(keys[0]!.lease)).toBe(0);
      expect(await fixture.redis.exists(keys[0]!.terminal)).toBe(0);
      expect(await pendingCount(fixture)).toBe(4);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
