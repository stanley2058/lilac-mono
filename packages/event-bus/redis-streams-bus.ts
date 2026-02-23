import type Redis from "ioredis";
import SuperJSON from "superjson";
import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";

import type { RawBus } from "./raw-bus";
import {
  RedisConnectionPool,
  type RedisConnectionPoolOptions,
  type RedisConnectionPoolAutoscaleOptions,
} from "./redis-connection-pool";
import type {
  Cursor,
  FetchOptions,
  HandleContext,
  Message,
  PublishOptions,
  SubscriptionOptions,
  Topic,
  WorkOrFanoutSubscriptionOptions,
} from "./types";

const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_BLOCK_MS = 1000;

function randomConsumerId(): string {
  // Bun + modern Node both support this.
  return crypto.randomUUID();
}

function toRecord(fields: unknown): Record<string, string> {
  if (!Array.isArray(fields)) return {};

  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const k = fields[i];
    const v = fields[i + 1];
    if (typeof k === "string" && typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function superJsonParse(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return SuperJSON.parse(value);
  } catch {
    return undefined;
  }
}

function decodeMessage(topic: Topic, id: string, fields: unknown, logger?: Logger): Message {
  const record = toRecord(fields);

  const type = record["type"] ?? "";
  const tsRaw = record["ts"];
  const ts = typeof tsRaw === "string" ? Number(tsRaw) : NaN;

  if (!type) {
    logger?.warn("event_bus.decode_anomaly", {
      topic,
      messageId: id,
      decodeField: "type",
      reason: "missing_or_empty",
    });
  }

  if (!Number.isFinite(ts)) {
    logger?.warn("event_bus.decode_anomaly", {
      topic,
      messageId: id,
      decodeField: "ts",
      reason: "invalid_number",
      value: tsRaw,
    });
  }

  const rawHeaders = record["headers"];
  const headersParsed = superJsonParse(record["headers"]);
  const headers =
    headersParsed && typeof headersParsed === "object"
      ? (headersParsed as Record<string, string>)
      : undefined;

  if (rawHeaders && !headers) {
    logger?.warn("event_bus.decode_anomaly", {
      topic,
      messageId: id,
      decodeField: "headers",
      reason: "parse_failed",
    });
  }

  const rawData = record["data"];
  const parsedData = superJsonParse(record["data"]);

  if (rawData && typeof parsedData === "undefined") {
    logger?.warn("event_bus.decode_anomaly", {
      topic,
      messageId: id,
      decodeField: "data",
      reason: "parse_failed",
    });
  }

  return {
    topic,
    id,
    type,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    key: record["key"],
    headers,
    data: parsedData,
  };
}

async function ensureGroup(options: {
  redis: Redis;
  streamKey: string;
  group: string;
  startId: string;
  logger?: Logger;
}): Promise<void> {
  try {
    await options.redis.xgroup(
      "CREATE",
      options.streamKey,
      options.group,
      options.startId,
      "MKSTREAM",
    );

    options.logger?.info("created consumer group", {
      streamKey: options.streamKey,
      group: options.group,
      startId: options.startId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("BUSYGROUP")) {
      options.logger?.debug("consumer group exists", {
        streamKey: options.streamKey,
        group: options.group,
      });
      return;
    }
    throw e;
  }
}

/** Options for `RedisStreamsBus`. */
export type RedisStreamsBusOptions = {
  /** Connected ioredis instance. */
  redis: Redis;
  /**
   * Stream key prefix.
   *
   * Defaults to `lilac:event-bus`.
   */
  keyPrefix?: string;

  /**
   * If true, `close()` will call `redis.quit()`.
   *
   * Default: false (assume the caller owns the shared Redis client).
   */
  ownsRedis?: boolean;

  /**
   * Pool config for subscription connections.
   *
   * Subscriptions use blocking `XREAD`/`XREADGROUP`, which would otherwise block
   * publishes on a shared ioredis connection.
   */
  subscriberPool?: {
    /** Initial max duplicated clients used by subscriptions. Default: 16. */
    max?: number;
    /** Optional background warm-up count. Default: 0. */
    warm?: number;
    /** Optional autoscaling config (default disabled). */
    autoscale?: RedisConnectionPoolAutoscaleOptions;
  };
};

/** Redis Streams-backed implementation of `RawBus`. */
export class RedisStreamsBus implements RawBus {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ownsRedis: boolean;
  private readonly logger: Logger;
  private readonly subPool: RedisConnectionPool;

  /** Create a new bus using an existing ioredis client. */
  constructor(options: RedisStreamsBusOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? "lilac:event-bus";
    this.ownsRedis = options.ownsRedis ?? false;
    this.logger = new Logger({
      logLevel: resolveLogLevel(),
      module: "event-bus:redis-streams",
    });

    const poolCfg = options.subscriberPool;
    const max = poolCfg?.max ?? 16;
    const warm = poolCfg?.warm ?? 0;
    const poolOpts: RedisConnectionPoolOptions = {
      base: this.redis,
      max,
      warm,
      onExhausted: "fallback_to_shared_with_warn",
      autoscale: poolCfg?.autoscale,
      logger: this.logger,
      label: "event-bus:subscribe",
    };

    this.subPool = new RedisConnectionPool(poolOpts);
  }

  private streamKey(topic: Topic): string {
    return `${this.keyPrefix}:${topic}`;
  }

  /** Publish a message via `XADD`. */
  async publish<TData>(
    msg: Omit<Message<TData>, "id" | "ts">,
    opts: PublishOptions,
  ): Promise<{ id: string; cursor: Cursor }> {
    const streamKey = this.streamKey(opts.topic);
    const ts = Date.now();
    const startedAt = Date.now();

    const fields: string[] = [
      "type",
      opts.type,
      "ts",
      String(ts),
      "data",
      SuperJSON.stringify(msg.data ?? null),
    ];

    if (opts.key) {
      fields.push("key", opts.key);
    }

    if (opts.headers) {
      fields.push("headers", SuperJSON.stringify(opts.headers));
    }

    // If requested, apply approximate trimming.
    // TODO: decide retention policy and move to config.
    const id = opts.retention?.maxLenApprox
      ? await this.redis.xadd(
          streamKey,
          "MAXLEN",
          "~",
          String(opts.retention.maxLenApprox),
          "*",
          ...fields,
        )
      : await this.redis.xadd(streamKey, "*", ...fields);

    if (!id) throw new Error("Redis XADD returned null id");

    this.logger.debug("event_bus.publish", {
      topic: opts.topic,
      type: opts.type,
      key: opts.key,
      messageId: id,
      hasHeaders: Boolean(opts.headers),
      durationMs: Date.now() - startedAt,
    });

    return { id, cursor: id };
  }

  /** Fetch messages via `XREAD` (non-durable, no consumer group). */
  async fetch<TData>(topic: Topic, opts: FetchOptions) {
    const streamKey = this.streamKey(topic);
    const limit = opts.limit ?? DEFAULT_MAX_MESSAGES;

    const startId =
      opts.offset.type === "begin" ? "0-0" : opts.offset.type === "now" ? "$" : opts.offset.cursor;

    const res = (await this.redis.xread(
      "COUNT",
      String(limit),
      "STREAMS",
      streamKey,
      startId,
    )) as unknown;

    const messages: Array<{ msg: Message<TData>; cursor: Cursor }> = [];

    // Shape: [[streamKey, [[id, [k,v...]], ...]]]
    const streams = Array.isArray(res) ? res : [];
    for (const s of streams) {
      const entries = Array.isArray(s) ? s[1] : undefined;
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        const id = Array.isArray(entry) ? entry[0] : undefined;
        const fields = Array.isArray(entry) ? entry[1] : undefined;
        if (typeof id !== "string") continue;

        const decoded = decodeMessage(topic, id, fields, this.logger) as Message<TData>;
        messages.push({ msg: decoded, cursor: id });
      }
    }

    const next = messages.length > 0 ? messages[messages.length - 1]!.cursor : undefined;
    return { messages, next };
  }

  /**
   * Subscribe to a topic.
   *
   * - `work`/`fanout`: `XREADGROUP` + `XACK` on `ctx.commit()`.
   * - `tail`: `XREAD` starting from the requested offset.
   */
  async subscribe<TData>(
    topic: Topic,
    opts: SubscriptionOptions,
    handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
  ): Promise<{ stop(): Promise<void> }> {
    const streamKey = this.streamKey(topic);
    const abortController = new AbortController();

    const lease = await this.subPool.acquire();
    const subRedis = lease.redis;

    let disconnectOnStop = false;
    let releaseUnhealthy = false;

    // Avoid a race where callers publish immediately after subscribe() resolves.
    // For work/fanout (consumer group) modes, the group must exist before we return.
    let group: string | null = null;
    let consumerId: string | null = null;

    const maxMessages = opts.batch?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const blockMs = Math.min(Math.max(1, opts.batch?.maxWaitMs ?? DEFAULT_BLOCK_MS), 30_000);

    try {
      if (opts.mode === "work" || opts.mode === "fanout") {
        const workOpts = opts as WorkOrFanoutSubscriptionOptions;
        group = workOpts.subscriptionId;
        consumerId = workOpts.consumerId ?? randomConsumerId();

        const startId = workOpts.offset?.type === "begin" ? "0-0" : "$";
        await ensureGroup({
          redis: subRedis,
          streamKey,
          group,
          startId,
          logger: this.logger,
        });
      }
    } catch (e) {
      releaseUnhealthy = true;
      if (!lease.shared) {
        await lease.release({ unhealthy: true });
      }
      throw e;
    }

    this.logger.info("subscribe", {
      topic,
      mode: opts.mode,
      subscriptionId:
        opts.mode === "work" || opts.mode === "fanout"
          ? (opts as WorkOrFanoutSubscriptionOptions).subscriptionId
          : undefined,
      consumerId:
        opts.mode === "work" || opts.mode === "fanout"
          ? (opts as WorkOrFanoutSubscriptionOptions).consumerId
          : undefined,
      offset: (opts as any).offset,
      maxMessages,
      blockMs,
    });

    const running = (async () => {
      try {
        if (opts.mode === "tail") {
          let cursor: string =
            opts.offset?.type === "begin"
              ? "0-0"
              : opts.offset?.type === "now"
                ? "$"
                : opts.offset?.type === "cursor"
                  ? opts.offset.cursor
                  : "$";

          while (!abortController.signal.aborted) {
            const res = (await subRedis.xread(
              "COUNT",
              String(maxMessages),
              "BLOCK",
              String(blockMs),
              "STREAMS",
              streamKey,
              cursor,
            )) as unknown;

            const streams = Array.isArray(res) ? res : [];
            for (const s of streams) {
              const entries = Array.isArray(s) ? s[1] : undefined;
              if (!Array.isArray(entries)) continue;

              for (const entry of entries) {
                const id = Array.isArray(entry) ? entry[0] : undefined;
                const fields = Array.isArray(entry) ? entry[1] : undefined;
                if (typeof id !== "string") continue;

                cursor = id;
                const msg = decodeMessage(topic, id, fields, this.logger) as Message<TData>;
                const ctx: HandleContext = {
                  cursor: id,
                  commit: async () => {},
                };

                await handler(msg, ctx);
              }
            }
          }

          return;
        }

        if (!group || !consumerId) {
          throw new Error("event-bus internal error: missing group/consumerId");
        }

        while (!abortController.signal.aborted) {
          const res = (await subRedis.xreadgroup(
            "GROUP",
            group,
            consumerId,
            "COUNT",
            String(maxMessages),
            "BLOCK",
            String(blockMs),
            "STREAMS",
            streamKey,
            ">",
          )) as unknown;

          const streams = Array.isArray(res) ? res : [];
          for (const s of streams) {
            const entries = Array.isArray(s) ? s[1] : undefined;
            if (!Array.isArray(entries)) continue;

            for (const entry of entries) {
              const id = Array.isArray(entry) ? entry[0] : undefined;
              const fields = Array.isArray(entry) ? entry[1] : undefined;
              if (typeof id !== "string") continue;

              const msg = decodeMessage(topic, id, fields, this.logger) as Message<TData>;
              const ctx: HandleContext = {
                cursor: id,
                commit: async () => {
                  try {
                    await subRedis.xack(streamKey, group, id);
                  } catch (e) {
                    this.logger.error(
                      "event_bus.ack_failed",
                      {
                        topic,
                        group,
                        consumerId,
                        messageId: id,
                        type: msg.type,
                      },
                      e,
                    );
                    throw e;
                  }
                },
              };

              try {
                await handler(msg, ctx);
              } catch (e) {
                // Leave message pending for later analysis / recovery.
                // TODO: consider adding a configurable dead-letter flow.
                this.logger.error(
                  "event-bus handler error",
                  {
                    topic,
                    group,
                    consumerId,
                    messageId: id,
                    messageType: msg.type,
                  },
                  e,
                );
              }
            }
          }
        }
      } catch (e) {
        if (abortController.signal.aborted) {
          return;
        }
        releaseUnhealthy = true;
        this.logger.error("event-bus subscription loop crashed", { topic, mode: opts.mode }, e);
        throw e;
      } finally {
        if (!lease.shared) {
          await lease.release({ unhealthy: disconnectOnStop || releaseUnhealthy });
        }
      }
    })();

    return {
      stop: async () => {
        abortController.abort();

        // If this subscription owns a dedicated connection, disconnect it so any
        // blocking XREAD unblocks promptly.
        if (!lease.shared) {
          // We avoid disconnecting for short BLOCK intervals so the connection can be reused.
          // For long blocks, force-disconnect to avoid waiting on the server-side timeout.
          if (blockMs > 500) {
            disconnectOnStop = true;
            subRedis.disconnect();
          }
        }

        await running;
      },
    };
  }

  /** Close the bus (no-op unless `ownsRedis` was set). */
  async close(): Promise<void> {
    await this.subPool.close();
    if (!this.ownsRedis) return;

    // Do not `disconnect()` because it drops queued commands; `quit()` is clean.
    await this.redis.quit();
  }
}

/** Convenience factory for `RedisStreamsBus`. */
export function createRedisStreamsBus(options: RedisStreamsBusOptions): RedisStreamsBus {
  return new RedisStreamsBus(options);
}
