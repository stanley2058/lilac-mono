import type Redis from "ioredis";
import type { Logger } from "@stanley2058/simple-module-logger";

export type RedisPoolExhaustedPolicy = "fallback_to_shared_with_warn";

export type RedisConnectionPoolAutoscaleOptions = {
  /** Enable autoscaling of the pool size. Default: false. */
  enabled?: boolean;
  /** Minimum pool size (lower bound for shrink). Default: initial max. */
  min?: number;
  /** Upper bound for growth. Default: initial max. */
  cap?: number;
  /** Multiply pool max by this factor when exhausted. Default: 2. */
  growFactor?: number;
  /** Shrink when `inUse <= max / shrinkDivisor`. Default: 3. */
  shrinkDivisor?: number;
  /** Divide pool max by this factor when shrinking. Default: 2. */
  shrinkFactor?: number;
  /** Minimum time between scale-down decisions (also prevents immediate shrink after a grow). Default: 30s. */
  cooldownMs?: number;
};

export type RedisConnectionPoolOptions = {
  /** Base client used to duplicate new connections. Must remain connected. */
  base: Redis;
  /** Initial maximum number of pooled (duplicated) connections. */
  max: number;
  /** Optional number of connections to pre-create in the background. */
  warm?: number;
  /** Max time to wait for a lease (not used for current policy; reserved). */
  acquireTimeoutMs?: number;
  /** Behavior when all pooled connections are already leased. */
  onExhausted?: RedisPoolExhaustedPolicy;
  /** Optional autoscaling config for the pool size. */
  autoscale?: RedisConnectionPoolAutoscaleOptions;
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
  private max: number;
  private readonly initialMax: number;
  private readonly warm: number;
  private readonly logger?: Logger;
  private readonly label: string;
  private readonly onExhausted: RedisPoolExhaustedPolicy;

  private readonly autoscale: Required<
    Pick<
      RedisConnectionPoolAutoscaleOptions,
      "enabled" | "min" | "cap" | "growFactor" | "shrinkDivisor" | "shrinkFactor" | "cooldownMs"
    >
  >;

  private lastResizeAt = 0;
  private lastExhaustedWarnAt = 0;
  private exhaustedWarnSuppressed = 0;

  private closed = false;

  private readonly available: Redis[] = [];
  private readonly inUse = new Set<Redis>();
  /** Number of currently-live pooled (duplicated) clients. */
  private created = 0;

  constructor(opts: RedisConnectionPoolOptions) {
    this.base = opts.base;
    this.max = clampInt(opts.max, 1, 1024);
    this.initialMax = this.max;

    const as = opts.autoscale ?? {};
    const enabled = as.enabled ?? false;
    const cap = clampInt(as.cap ?? this.initialMax, this.initialMax, 1024);
    const min = clampInt(as.min ?? this.initialMax, 1, cap);
    const growFactor = clampInt(as.growFactor ?? 2, 2, 16);
    const shrinkDivisor = clampInt(as.shrinkDivisor ?? 3, 2, 32);
    const shrinkFactor = clampInt(as.shrinkFactor ?? 2, 2, 16);
    const cooldownMs = clampInt(as.cooldownMs ?? 30_000, 0, 10 * 60_000);

    this.autoscale = {
      enabled,
      min,
      cap,
      growFactor,
      shrinkDivisor,
      shrinkFactor,
      cooldownMs,
    };

    // If the caller configured a min above the initial max, honor it.
    if (this.autoscale.enabled && this.max < this.autoscale.min) {
      this.max = this.autoscale.min;
    }

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

  private canScaleDown(now = Date.now()): boolean {
    if (!this.autoscale.enabled) return false;
    if (this.autoscale.cooldownMs <= 0) return true;
    return now - this.lastResizeAt >= this.autoscale.cooldownMs;
  }

  private maybeScaleUpOnExhausted(): boolean {
    const now = Date.now();
    if (!this.autoscale.enabled) return false;
    if (this.max >= this.autoscale.cap) return false;

    const fromMax = this.max;
    const proposed = Math.max(fromMax + 1, fromMax * this.autoscale.growFactor);
    const toMax = Math.min(this.autoscale.cap, proposed);
    if (toMax <= fromMax) return false;

    this.max = toMax;
    this.lastResizeAt = now;

    const s = this.stats();
    this.logger?.info("redis connection pool scaled up", {
      label: this.label,
      fromMax,
      toMax,
      created: s.created,
      available: s.available,
      inUse: s.inUse,
      reason: "exhausted",
    });

    return true;
  }

  private maybeScaleDownOnRelease(): void {
    const now = Date.now();
    if (!this.autoscale.enabled) return;
    if (this.max <= this.autoscale.min) return;
    if (!this.canScaleDown(now)) return;

    const inUse = this.inUse.size;
    if (inUse > this.max / this.autoscale.shrinkDivisor) return;

    const fromMax = this.max;
    const proposed = Math.floor(fromMax / this.autoscale.shrinkFactor);
    const toMax = Math.max(this.autoscale.min, Math.max(inUse, proposed));
    if (toMax >= fromMax) return;

    this.max = toMax;
    this.lastResizeAt = now;

    let trimmedIdle = 0;
    while (this.created > this.max && this.available.length > 0) {
      const c = this.available.pop();
      if (!c) break;
      trimmedIdle += 1;
      this.created = Math.max(0, this.created - 1);
      c.disconnect();
    }

    const s = this.stats();
    this.logger?.debug("redis connection pool scaled down", {
      label: this.label,
      fromMax,
      toMax,
      created: s.created,
      available: s.available,
      inUse: s.inUse,
      trimmedIdle,
      reason: "underutilized",
    });
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

    // Pool exhausted; try to scale up instead of falling back to the shared client.
    if (this.maybeScaleUpOnExhausted() && this.created < this.max) {
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
      const nowMs = Date.now();
      const warnCooldownMs = 30_000;
      if (nowMs - this.lastExhaustedWarnAt >= warnCooldownMs) {
        this.logger?.warn("redis connection pool exhausted; falling back to shared client", {
          label: this.label,
          max: s.max,
          created: s.created,
          available: s.available,
          inUse: s.inUse,
          autoscale: this.autoscale.enabled
            ? {
                min: this.autoscale.min,
                cap: this.autoscale.cap,
              }
            : undefined,
          suppressedCount: this.exhaustedWarnSuppressed,
          warnCooldownMs,
        });
        this.lastExhaustedWarnAt = nowMs;
        this.exhaustedWarnSuppressed = 0;
      } else {
        this.exhaustedWarnSuppressed += 1;
      }
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

      // Best-effort autoscale decision after releasing capacity.
      this.maybeScaleDownOnRelease();
      return;
    }

    this.available.push(redis);

    // Best-effort autoscale decision (no await).
    this.maybeScaleDownOnRelease();
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
