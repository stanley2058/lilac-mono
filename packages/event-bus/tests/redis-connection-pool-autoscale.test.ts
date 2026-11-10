import { describe, expect, it } from "bun:test";
import type { Result as ResultType } from "better-result";
import Redis from "ioredis";
import { env } from "@stanley2058/lilac-utils";

import { RedisConnectionPool } from "../redis-connection-pool";

function requireOk<TValue, TError>(result: ResultType<TValue, TError>): TValue {
  if (result.status === "error") throw result.error;
  return result.value;
}

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";

describe("RedisConnectionPool autoscale", () => {
  it("reserves max=1 capacity before concurrent connection creation yields", async () => {
    const base = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const duplicate = base.duplicate.bind(base);
    let duplicateCalls = 0;
    Reflect.set(base, "duplicate", () => {
      duplicateCalls += 1;
      return duplicate();
    });
    const pool = new RedisConnectionPool({ base, max: 1 });

    const leases = await Promise.all([pool.acquire(), pool.acquire()]);
    const first = requireOk(leases[0]!);
    const second = leases[1]!;
    expect(duplicateCalls).toBe(1);
    expect(first.shared).toBe(false);
    expect(second.status).toBe("error");
    expect(pool.stats()).toEqual({ max: 1, created: 1, available: 0, inUse: 1 });

    await first.release();
    await pool.close();
    base.disconnect();
  });

  it("releases reserved capacity when connection creation fails", async () => {
    const base = new Redis(TEST_REDIS_URL, { lazyConnect: true });
    const duplicate = base.duplicate.bind(base);
    let duplicateCalls = 0;
    Reflect.set(base, "duplicate", () => {
      duplicateCalls += 1;
      if (duplicateCalls === 1) throw new Error("duplicate failed");
      return duplicate();
    });
    const pool = new RedisConnectionPool({ base, max: 1 });

    const failed = await pool.acquire();
    expect(failed.status).toBe("error");
    const acquired = requireOk(await pool.acquire());
    expect(acquired.shared).toBe(false);
    expect(pool.stats().created).toBe(1);

    await acquired.release();
    await pool.close();
    base.disconnect();
  });

  it("returns an owned error when acquired after close", async () => {
    const base = new Redis(TEST_REDIS_URL);
    const pool = new RedisConnectionPool({ base, max: 1 });
    await pool.close();
    const acquired = await pool.acquire();
    expect(acquired.status).toBe("error");
    if (acquired.status === "error") expect(acquired.error._tag).toBe("RedisConnectionPoolClosed");
    base.disconnect();
  });

  it("scales up on exhaustion (2x)", async () => {
    const base = new Redis(TEST_REDIS_URL);
    await base.ping();

    const pool = new RedisConnectionPool({
      base,
      max: 2,
      warm: 0,
      autoscale: {
        enabled: true,
        min: 2,
        cap: 8,
        growFactor: 2,
        cooldownMs: 0,
      },
    });

    const a = requireOk(await pool.acquire());
    const b = requireOk(await pool.acquire());

    // Third acquire forces a grow (2 -> 4) and returns a dedicated client.
    const c = requireOk(await pool.acquire());
    expect(c.shared).toBe(false);

    const s = pool.stats();
    expect(s.max).toBe(4);
    expect(s.created).toBe(3);
    expect(s.inUse).toBe(3);

    await Promise.all([a.release(), b.release()]);
    await pool.close();
    await base.quit();
  });

  it("returns an acquisition failure at cap without leasing the publisher", async () => {
    const base = new Redis(TEST_REDIS_URL);
    await base.ping();

    const pool = new RedisConnectionPool({
      base,
      max: 2,
      warm: 0,
      autoscale: {
        enabled: true,
        min: 2,
        cap: 2,
        growFactor: 2,
        cooldownMs: 0,
      },
    });

    const a = requireOk(await pool.acquire());
    const b = requireOk(await pool.acquire());
    const c = await pool.acquire();

    expect(c.status).toBe("error");
    expect(pool.stats().max).toBe(2);
    expect(pool.stats().inUse).toBe(2);

    await Promise.all([a.release(), b.release()]);
    await pool.close();
    await base.quit();
  });

  it("scales down and trims idle connections when underutilized", async () => {
    const base = new Redis(TEST_REDIS_URL);
    await base.ping();

    const pool = new RedisConnectionPool({
      base,
      max: 16,
      warm: 0,
      autoscale: {
        enabled: true,
        min: 4,
        cap: 256,
        cooldownMs: 0,
      },
    });

    const leases = await Promise.all(
      Array.from({ length: 16 }, async () => requireOk(await pool.acquire())),
    );

    expect(pool.stats().created).toBe(16);
    expect(pool.stats().inUse).toBe(16);

    // Releasing down to 0 should shrink max by halves until min=4,
    // and disconnect idle clients to keep created <= max.
    for (const l of leases) {
      await l.release();
    }

    const s = pool.stats();
    expect(s.inUse).toBe(0);
    expect(s.max).toBe(4);
    expect(s.created).toBe(4);
    expect(s.available).toBe(4);

    await pool.close();
    await base.quit();
  });
});
