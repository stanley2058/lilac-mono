import { describe, expect, it } from "bun:test";
import {
  createLilacBus,
  lilacEventTypes,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { subagentTools } from "../../src/tools/subagent";

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

async function resolveExecuteResult<T>(
  value: T | PromiseLike<T> | AsyncIterable<T>,
): Promise<T> {
  if (isAsyncIterable(value)) {
    let last: T | undefined;
    for await (const chunk of value) {
      last = chunk;
    }
    if (last === undefined) {
      throw new Error("AsyncIterable tool execute produced no values");
    }
    return last;
  }

  return await value;
}

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(
      msg: Omit<Message<TData>, "id" | "ts">,
      opts: PublishOptions,
    ) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
        handler: handler as unknown as (
          msg: Message<unknown>,
          ctx: HandleContext,
        ) => Promise<void>,
      };
      subs.add(entry);

      if (opts.offset?.type === "begin") {
        const existing = topics.get(topic) ?? [];
        for (const m of existing) {
          await handler(m as unknown as Message<TData>, {
            cursor: m.id,
            commit: async () => {},
          });
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
        },
      };
    },

    fetch: async <TData>(topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next:
          existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
      };
    },

    close: async () => {},
  };
}

describe("subagent_delegate tool", () => {
  it("delegates to child request and returns child final text", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
    });

    await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "subagent-test-worker-1",
        consumerId: "subagent-test-worker-1",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.CmdRequestMessage) {
          await ctx.commit();
          return;
        }

        const requestId = msg.headers?.request_id;
        const sessionId = msg.headers?.session_id;
        const requestClient = msg.headers?.request_client;
        if (!requestId || !sessionId || !requestClient) {
          await ctx.commit();
          return;
        }

        if (msg.data.queue !== "prompt") {
          await ctx.commit();
          return;
        }

        await bus.publish(lilacEventTypes.EvtRequestLifecycleChanged, {
          state: "running",
        }, {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: requestClient,
          },
        });

        await bus.publish(lilacEventTypes.EvtAgentOutputDeltaText, {
          delta: "hello ",
        }, {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: requestClient,
          },
        });

        await bus.publish(lilacEventTypes.EvtAgentOutputResponseText, {
          finalText: "hello world",
        }, {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: requestClient,
          },
        });

        await bus.publish(lilacEventTypes.EvtRequestLifecycleChanged, {
          state: "resolved",
        }, {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: requestClient,
          },
        });

        await ctx.commit();
      },
    );

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow" },
        {
          toolCallId: "tool-1",
          messages: [],
          experimental_context: {
            requestId: "r:1",
            sessionId: "s:1",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.ok).toBe(true);
    expect(res.status).toBe("resolved");
    expect(res.profile).toBe("explore");
    expect(res.finalText).toBe("hello world");
    expect(res.childRequestId.startsWith("sub:r:1:")).toBe(true);
    expect(res.childSessionId.startsWith("sub:s:1:")).toBe(true);
  });

  it("rejects delegation when depth limit is reached", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
    });

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow" },
        {
          toolCallId: "tool-2",
          messages: [],
          experimental_context: {
            requestId: "r:2",
            sessionId: "s:2",
            requestClient: "discord",
            subagentDepth: 1,
          },
        },
      ),
    ).rejects.toThrow(/depth limit reached/i);
  });

  it("clamps timeoutMs to configured max", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
    });

    await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "subagent-test-worker-2",
        consumerId: "subagent-test-worker-2",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.CmdRequestMessage) {
          await ctx.commit();
          return;
        }

        const requestId = msg.headers?.request_id;
        const sessionId = msg.headers?.session_id;
        const requestClient = msg.headers?.request_client;
        if (!requestId || !sessionId || !requestClient) {
          await ctx.commit();
          return;
        }

        if (msg.data.queue !== "prompt") {
          await ctx.commit();
          return;
        }

        await bus.publish(lilacEventTypes.EvtAgentOutputResponseText, {
          finalText: "done",
        }, {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: requestClient,
          },
        });

        await bus.publish(lilacEventTypes.EvtRequestLifecycleChanged, {
          state: "resolved",
        }, {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: requestClient,
          },
        });

        await ctx.commit();
      },
    );

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow", timeoutMs: 999_999 },
        {
          toolCallId: "tool-3",
          messages: [],
          experimental_context: {
            requestId: "r:3",
            sessionId: "s:3",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.timeoutMs).toBe(4_000);
    expect(res.status).toBe("resolved");
  });
});
