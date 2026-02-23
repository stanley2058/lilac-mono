import { describe, expect, it } from "bun:test";

import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { createRequestMessageCache } from "../../src/tool-server/request-message-cache";

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-0`;
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data as unknown,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        await s.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        opts,
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async <TData>(topic: string, _opts: FetchOptions) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

describe("request-message-cache", () => {
  it("stores and appends cmd.request message batches per request id", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const cache = await createRequestMessageCache({ bus, ttlMs: 60_000, maxEntries: 32 });

    const requestId = "req:cache-1";

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "one" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "followUp",
        messages: [{ role: "user", content: "two" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    const cached = cache.get(requestId);
    expect(Array.isArray(cached)).toBe(true);
    expect(cached?.length).toBe(2);

    await cache.stop();
  });

  it("expires cached entries after ttl", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const cache = await createRequestMessageCache({ bus, ttlMs: 5, maxEntries: 32 });

    const requestId = "req:cache-expire";

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "prompt",
        messages: [{ role: "user", content: "one" }],
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    expect(cache.get(requestId)?.length).toBe(1);

    await new Promise((r) => setTimeout(r, 10));
    expect(cache.get(requestId)).toBeUndefined();

    await cache.stop();
  });

  it("clamps large per-request message history and evicts oldest request ids", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const cache = await createRequestMessageCache({ bus, ttlMs: 60_000, maxEntries: 2 });

    const hotRequest = "req:cache-hot";

    for (let i = 0; i < 520; i++) {
      await bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          queue: "followUp",
          messages: [{ role: "user", content: `m${i}` }],
        },
        {
          headers: {
            request_id: hotRequest,
            session_id: "chan",
            request_client: "discord",
          },
        },
      );
    }

    const hot = cache.get(hotRequest);
    expect(hot?.length).toBe(512);

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { queue: "prompt", messages: [{ role: "user", content: "a" }] },
      { headers: { request_id: "req:a", session_id: "chan", request_client: "discord" } },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { queue: "prompt", messages: [{ role: "user", content: "b" }] },
      { headers: { request_id: "req:b", session_id: "chan", request_client: "discord" } },
    );

    // maxEntries=2 should evict least recently updated request ids.
    expect(cache.get("req:a")).toBeDefined();
    expect(cache.get("req:b")).toBeDefined();
    expect(cache.get(hotRequest)).toBeUndefined();

    await cache.stop();
  });
});
