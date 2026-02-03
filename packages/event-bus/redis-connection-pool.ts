import type Redis from "ioredis";
import type { Logger } from "@stanley2058/simple-module-logger";

export type RedisPoolExhaustedPolicy = "fallback_to_shared_with_warn";

export type RedisConnectionPoolOptions = {
  /** Base client used to duplicate new connections. Must remain connected. */
  base: Redis;
  /** Maximum number of pooled (duplicated) connections. */
  max: number;
  /** Optional number of connections to pre-create in the background. */
  warm?: number;
  /** Max time to wait for a lease (not used for current policy; reserved). */
  acquireTimeoutMs?: number;
  /** Behavior when all pooled connections are already leased. */
  onExhausted?: RedisPoolExhaustedPolicy;
  logger?: Logger;
  label?: string;
};

export type RedisLease = {
  redis: Redis;
  /** True when falling back to the shared base connection. */
  shared: boolean;
  /** Release the lease back to the pool. */
  release(opts?: { unhealthy?: boolean }): Promise<void>;
};

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export class RedisConnectionPool {
  private readonly base: Redis;
  private readonly max: number;
  private readonly warm: number;
  private readonly logger?: Logger;
  private readonly label: string;
  private readonly onExhausted: RedisPoolExhaustedPolicy;

  private closed = false;

  private readonly available: Redis[] = [];
  private readonly inUse = new Set<Redis>();
  /** Number of currently-live pooled (duplicated) clients. */
  private created = 0;

  constructor(opts: RedisConnectionPoolOptions) {
    this.base = opts.base;
    this.max = clampInt(opts.max, 1, 1024);
    this.warm = clampInt(opts.warm ?? 0, 0, this.max);
    this.logger = opts.logger;
    this.label = opts.label ?? "redis";
    this.onExhausted = opts.onExhausted ?? "fallback_to_shared_with_warn";

    // Best-effort warm-up in the background.
    if (this.warm > 0) {
      void this.warmUp().catch(() => {
        // ignore
      });
    }
  }

  stats(): { max: number; created: number; available: number; inUse: number } {
    return {
      max: this.max,
      created: this.created,
      available: this.available.length,
      inUse: this.inUse.size,
    };
  }

  private async warmUp(): Promise<void> {
    const target = this.warm;

    while (!this.closed && this.created < target) {
      const c = this.base.duplicate();
      this.created += 1;
      this.available.push(c);
      // Let the connection establish asynchronously (no await).
      // The first command on this client will trigger the connect.
      await Promise.resolve();
    }
  }

  async acquire(): Promise<RedisLease> {
    if (this.closed) {
      throw new Error(`RedisConnectionPool(${this.label}) is closed`);
    }

    const existing = this.available.pop();
    if (existing) {
      this.inUse.add(existing);
      return {
        redis: existing,
        shared: false,
        release: async (opts) => {
          await this.release(existing, opts);
        },
      };
    }

    if (this.created < this.max) {
      const c = this.base.duplicate();
      this.created += 1;
      this.inUse.add(c);
      return {
        redis: c,
        shared: false,
        release: async (opts) => {
          await this.release(c, opts);
        },
      };
    }

    // Pool exhausted.
    if (this.onExhausted === "fallback_to_shared_with_warn") {
      const s = this.stats();
      this.logger?.warn("redis connection pool exhausted; falling back to shared client", {
        label: this.label,
        max: s.max,
        created: s.created,
        available: s.available,
        inUse: s.inUse,
      });
      return {
        redis: this.base,
        shared: true,
        release: async () => {},
      };
    }

    const _exhaustive: never = this.onExhausted;
    throw new Error(`Unhandled onExhausted policy: ${String(_exhaustive)}`);
  }

  private async release(redis: Redis, opts?: { unhealthy?: boolean }): Promise<void> {
    if (!this.inUse.has(redis)) {
      // Shared clients are not tracked, and double-release is a no-op.
      return;
    }

    this.inUse.delete(redis);

    if (this.closed) {
      // Pool is shutting down; close the client.
      this.created = Math.max(0, this.created - 1);
      redis.disconnect();
      return;
    }

    if (opts?.unhealthy) {
      // Do not reuse a client that we forcibly disconnected to break a BLOCK.
      this.created = Math.max(0, this.created - 1);
      redis.disconnect();
      return;
    }

    this.available.push(redis);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const c of this.available) {
      c.disconnect();
    }
    this.available.length = 0;

    for (const c of this.inUse) {
      c.disconnect();
    }
    this.inUse.clear();

    this.created = 0;
  }
}
