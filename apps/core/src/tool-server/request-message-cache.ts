import {
  lilacEventTypes,
  type LilacBus,
  type LilacMessageForTopic,
} from "@stanley2058/lilac-event-bus";

type CacheEntry = {
  messages: readonly unknown[];
  expiresAt: number;
  updatedAt: number;
};

export type RequestMessageCacheOptions = {
  bus: LilacBus;
  /** Consumer group id for the subscription. */
  subscriptionId?: string;
  /** TTL for cached request messages. Default: 30 minutes. */
  ttlMs?: number;
  /** Max cached requests. Default: 256. */
  maxEntries?: number;
};

export type RequestMessageCache = {
  get(requestId: string): readonly unknown[] | undefined;
  stop(): Promise<void>;
};

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

export async function createRequestMessageCache(
  options: RequestMessageCacheOptions,
): Promise<RequestMessageCache> {
  const {
    bus,
    subscriptionId = "tool-server:request-cache",
    ttlMs = 30 * 60 * 1000,
    maxEntries = 256,
  } = options;

  // Prevent unbounded growth for a single requestId when follow-ups/steers
  // arrive as incremental message batches.
  const maxMessagesPerRequest = 512;

  const map = new Map<string, CacheEntry>();

  function pruneExpired(now = Date.now()) {
    for (const [k, v] of map) {
      if (v.expiresAt <= now) {
        map.delete(k);
      }
    }
  }

  function pruneMax() {
    while (map.size > maxEntries) {
      let oldestKey: string | null = null;
      let oldestUpdatedAt = Infinity;

      for (const [k, v] of map) {
        if (v.updatedAt < oldestUpdatedAt) {
          oldestUpdatedAt = v.updatedAt;
          oldestKey = k;
        }
      }

      if (!oldestKey) break;
      map.delete(oldestKey);
    }
  }

  function set(requestId: string, messages: readonly unknown[]) {
    const now = Date.now();
    pruneExpired(now);

    const prev = map.get(requestId);
    const merged = prev ? [...prev.messages, ...messages] : [...messages];

    const clamped =
      merged.length > maxMessagesPerRequest
        ? merged.slice(merged.length - maxMessagesPerRequest)
        : merged;

    map.set(requestId, {
      messages: clamped,
      expiresAt: now + ttlMs,
      updatedAt: now,
    });

    pruneMax();
  }

  const sub = await bus.subscribeTopic(
    "cmd.request",
    {
      mode: "fanout",
      subscriptionId,
      consumerId: consumerId(subscriptionId),
      offset: { type: "now" },
      batch: { maxWaitMs: 250 },
    },
    async (msg: LilacMessageForTopic<"cmd.request">, ctx) => {
      if (msg.type !== lilacEventTypes.CmdRequestMessage) return;

      const requestId = msg.headers?.request_id;
      if (!requestId) {
        // keep unacked to surface the bug
        throw new Error("cmd.request.message missing headers.request_id");
      }

      // Append new message batches for this request.
      // cmd.request messages are often incremental (e.g. follow-ups), so overwrite semantics
      // can hide earlier user attachments.
      set(requestId, msg.data.messages);

      await ctx.commit();
    },
  );

  return {
    get: (requestId: string) => {
      const now = Date.now();
      const entry = map.get(requestId);
      if (!entry) return undefined;
      if (entry.expiresAt <= now) {
        map.delete(requestId);
        return undefined;
      }
      return entry.messages;
    },
    stop: async () => {
      await sub.stop();
      map.clear();
    },
  };
}
