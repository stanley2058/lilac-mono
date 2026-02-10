import { describe, expect, it } from "bun:test";
import Redis from "ioredis";
import { env } from "@stanley2058/lilac-utils";

import { RedisConnectionPool } from "../redis-connection-pool";

const TEST_REDIS_URL = env.redisUrl || "redis://127.0.0.1:6379";

describe("RedisConnectionPool autoscale", () => {
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

    const a = await pool.acquire();
    const b = await pool.acquire();

    // Third acquire forces a grow (2 -> 4) and returns a dedicated client.
    const c = await pool.acquire();
    expect(c.shared).toBe(false);

    const s = pool.stats();
    expect(s.max).toBe(4);
    expect(s.created).toBe(3);
    expect(s.inUse).toBe(3);

    await Promise.all([a.release(), b.release(), c.release()]);
    await pool.close();
    await base.quit();
  });

  it("falls back to shared client once at cap", async () => {
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

    const a = await pool.acquire();
    const b = await pool.acquire();
    const c = await pool.acquire();

    expect(c.shared).toBe(true);
    expect(pool.stats().max).toBe(2);
    expect(pool.stats().inUse).toBe(2);

    await Promise.all([a.release(), b.release(), c.release()]);
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
      Array.from({ length: 16 }, async () => await pool.acquire()),
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
