import { describe, expect, it } from "bun:test";
import {
  createLilacBus,
  lilacEventTypes,
  outReqTopic,
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
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

async function resolveExecuteResult<T>(value: T | PromiseLike<T> | AsyncIterable<T>): Promise<T> {
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
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
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
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
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
        next: existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
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

        await bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          {
            state: "running",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtAgentOutputDeltaText,
          {
            delta: "hello ",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          {
            finalText: "hello world",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          {
            state: "resolved",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

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

  it("supports general and self delegation profiles", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
    });

    const seenProfiles: string[] = [];

    await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "subagent-test-worker-profiles",
        consumerId: "subagent-test-worker-profiles",
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

        const profile = msg.headers?.subagent_profile;
        if (typeof profile === "string") {
          seenProfiles.push(profile);
        }

        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          {
            finalText: `done:${profile ?? "unknown"}`,
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          {
            state: "resolved",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await ctx.commit();
      },
    );

    const profiles = ["general", "self"] as const;

    for (const profile of profiles) {
      const res = await resolveExecuteResult(
        tools.subagent_delegate.execute!(
          { profile, task: "Do delegated work" },
          {
            toolCallId: `tool-${profile}`,
            messages: [],
            experimental_context: {
              requestId: `r:${profile}`,
              sessionId: `s:${profile}`,
              requestClient: "discord",
              subagentDepth: 0,
            },
          },
        ),
      );

      expect(res.ok).toBe(true);
      expect(res.status).toBe("resolved");
      expect(res.profile).toBe(profile);
      expect(res.finalText).toBe(`done:${profile}`);
    }

    expect(seenProfiles).toEqual(["general", "self"]);
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

  it("rejects delegation from explore and general runs", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 2,
    });

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow" },
        {
          toolCallId: "tool-no-nest-explore",
          messages: [],
          experimental_context: {
            requestId: "r:no-nest-explore",
            sessionId: "s:no-nest-explore",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "explore",
          },
        },
      ),
    ).rejects.toThrow(/disabled in explore subagent runs/i);

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "general", task: "Fix lint" },
        {
          toolCallId: "tool-no-nest-general",
          messages: [],
          experimental_context: {
            requestId: "r:no-nest-general",
            sessionId: "s:no-nest-general",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "general",
          },
        },
      ),
    ).rejects.toThrow(/disabled in general subagent runs/i);
  });

  it("rejects self->self recursion but allows self->explore at depth 1", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 2,
    });

    await expect(
      tools.subagent_delegate.execute!(
        { profile: "self", task: "Spawn self again" },
        {
          toolCallId: "tool-self-self",
          messages: [],
          experimental_context: {
            requestId: "r:self-self",
            sessionId: "s:self-self",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "self",
          },
        },
      ),
    ).rejects.toThrow(/cannot delegate to self profile/i);

    await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "subagent-test-worker-self-explore",
        consumerId: "subagent-test-worker-self-explore",
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

        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          {
            finalText: "self->explore ok",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          {
            state: "resolved",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await ctx.commit();
      },
    );

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow" },
        {
          toolCallId: "tool-self-explore",
          messages: [],
          experimental_context: {
            requestId: "r:self-explore",
            sessionId: "s:self-explore",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "self",
          },
        },
      ),
    );

    expect(res.status).toBe("resolved");
    expect(res.finalText).toBe("self->explore ok");
    expect(res.profile).toBe("explore");
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

        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          {
            finalText: "done",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          {
            state: "resolved",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

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

  it("surfaces child tool execution progress on the parent tool line", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
    });

    const parentRequestId = "r:4";
    const parentToolCallId = "tool-4";
    const parentUpdates: Array<{ status: "start" | "end"; display: string }> = [];

    await bus.subscribeTopic(
      outReqTopic(parentRequestId),
      {
        mode: "fanout",
        subscriptionId: "subagent-test-parent-out-1",
        consumerId: "subagent-test-parent-out-1",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        if (msg.type !== lilacEventTypes.EvtAgentOutputToolCall) {
          await ctx.commit();
          return;
        }

        if (msg.data.toolCallId !== parentToolCallId) {
          await ctx.commit();
          return;
        }

        parentUpdates.push({
          status: msg.data.status,
          display: msg.data.display,
        });
        await ctx.commit();
      },
    );

    await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "subagent-test-worker-3",
        consumerId: "subagent-test-worker-3",
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

        await bus.publish(
          lilacEventTypes.EvtAgentOutputToolCall,
          {
            toolCallId: "child-tool-1",
            status: "start",
            display: "grep auth src",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtAgentOutputToolCall,
          {
            toolCallId: "child-tool-1",
            status: "end",
            ok: true,
            display: "grep auth src",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          {
            finalText: "done",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          {
            state: "resolved",
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: requestClient,
            },
          },
        );

        await ctx.commit();
      },
    );

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow" },
        {
          toolCallId: parentToolCallId,
          messages: [],
          experimental_context: {
            requestId: parentRequestId,
            sessionId: "s:4",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.status).toBe("resolved");
    expect(parentUpdates.length).toBeGreaterThan(0);
    const latestDisplay = parentUpdates[parentUpdates.length - 1]?.display ?? "";
    expect(latestDisplay).toContain("subagent (explore;");
    expect(latestDisplay).toContain("grep auth src");
  });
});
