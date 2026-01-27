import type Redis from "ioredis";
import SuperJSON from "superjson";
import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";

import type { RawBus } from "./raw-bus";
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

function decodeMessage(topic: Topic, id: string, fields: unknown): Message {
  const record = toRecord(fields);

  const type = record["type"] ?? "";
  const tsRaw = record["ts"];
  const ts = typeof tsRaw === "string" ? Number(tsRaw) : NaN;

  const headersParsed = superJsonParse(record["headers"]);
  const headers =
    headersParsed && typeof headersParsed === "object"
      ? (headersParsed as Record<string, string>)
      : undefined;

  return {
    topic,
    id,
    type,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    key: record["key"],
    headers,
    data: superJsonParse(record["data"]),
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
};

/** Redis Streams-backed implementation of `RawBus`. */
export class RedisStreamsBus implements RawBus {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ownsRedis: boolean;
  private readonly logger: Logger;

  /** Create a new bus using an existing ioredis client. */
  constructor(options: RedisStreamsBusOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? "lilac:event-bus";
    this.ownsRedis = options.ownsRedis ?? false;
    this.logger = new Logger({
      logLevel: resolveLogLevel(),
      module: "event-bus:redis-streams",
    });
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

    return { id, cursor: id };
  }

  /** Fetch messages via `XREAD` (non-durable, no consumer group). */
  async fetch<TData>(topic: Topic, opts: FetchOptions) {
    const streamKey = this.streamKey(topic);
    const limit = opts.limit ?? DEFAULT_MAX_MESSAGES;

    const startId =
      opts.offset.type === "begin"
        ? "0-0"
        : opts.offset.type === "now"
          ? "$"
          : opts.offset.cursor;

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

        const decoded = decodeMessage(topic, id, fields) as Message<TData>;
        messages.push({ msg: decoded, cursor: id });
      }
    }

    const next =
      messages.length > 0 ? messages[messages.length - 1]!.cursor : undefined;
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

    const maxMessages = opts.batch?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    const blockMs = Math.min(
      Math.max(1, opts.batch?.maxWaitMs ?? DEFAULT_BLOCK_MS),
      30_000,
    );

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
          const res = (await this.redis.xread(
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
              const msg = decodeMessage(topic, id, fields) as Message<TData>;
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

      const workOpts = opts as WorkOrFanoutSubscriptionOptions;
      const group = workOpts.subscriptionId;
      const consumerId = workOpts.consumerId ?? randomConsumerId();

      const startId = workOpts.offset?.type === "begin" ? "0-0" : "$";
      await ensureGroup({
        redis: this.redis,
        streamKey,
        group,
        startId,
        logger: this.logger,
      });

      while (!abortController.signal.aborted) {
        const res = (await this.redis.xreadgroup(
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

            const msg = decodeMessage(topic, id, fields) as Message<TData>;
            const ctx: HandleContext = {
              cursor: id,
              commit: async () => {
                await this.redis.xack(streamKey, group, id);
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
        this.logger.error(
          "event-bus subscription loop crashed",
          { topic, mode: opts.mode },
          e,
        );
        throw e;
      }
    })();

    return {
      stop: async () => {
        abortController.abort();
        await running;
      },
    };
  }

  /** Close the bus (no-op unless `ownsRedis` was set). */
  async close(): Promise<void> {
    if (!this.ownsRedis) return;

    // Do not `disconnect()` because it drops queued commands; `quit()` is clean.
    await this.redis.quit();
  }
}

/** Convenience factory for `RedisStreamsBus`. */
export function createRedisStreamsBus(
  options: RedisStreamsBusOptions,
): RedisStreamsBus {
  return new RedisStreamsBus(options);
}
