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
  it("returns an accepted handle by default in deferred mode", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const launches: Array<{
      sessionName: string;
      childRequestId: string;
      childSessionId: string;
      task: string;
    }> = [];

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
      onDeferredDelegate: async (registration) => {
        launches.push({
          sessionName: registration.sessionName,
          childRequestId: registration.childRequestId,
          childSessionId: registration.childSessionId,
          task: registration.task,
        });
      },
    });

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        { profile: "explore", task: "Map auth flow", mode: "deferred" },
        {
          toolCallId: "tool-deferred-1",
          messages: [],
          context: {
            requestId: "r:deferred-1",
            sessionId: "s:deferred-1",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res).toEqual({
      ok: true,
      mode: "deferred",
      status: "accepted",
      profile: "explore",
      sessionName: expect.stringMatching(/^explore-[0-9a-f]{8}$/u),
    });
    expect(launches).toEqual([
      {
        sessionName: res.sessionName,
        childRequestId: expect.stringMatching(/^sub:r:deferred-1:/u),
        childSessionId: `sub:s:deferred-1:named:${res.sessionName}`,
        task: "Map auth flow",
      },
    ]);
  });

  it("ignores legacy raw sessionId input and creates a named child session", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const launches: Array<{ sessionName: string; childRequestId: string; childSessionId: string }> =
      [];

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
      onDeferredDelegate: async (registration) => {
        launches.push({
          sessionName: registration.sessionName,
          childRequestId: registration.childRequestId,
          childSessionId: registration.childSessionId,
        });
      },
    });

    const inputWithLegacySessionId = {
      profile: "explore" as const,
      task: "Map auth flow",
      mode: "deferred" as const,
      sessionId: "sub:dummy",
    };

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(inputWithLegacySessionId, {
        toolCallId: "tool-legacy-session-id",
        messages: [],
        context: {
          requestId: "r:legacy-session-id",
          sessionId: "s:legacy-session-id",
          requestClient: "discord",
          subagentDepth: 0,
        },
      }),
    );

    expect(res.status).toBe("accepted");
    expect(res.sessionName).toMatch(/^explore-[0-9a-f]{8}$/u);
    expect(launches).toEqual([
      {
        sessionName: res.sessionName,
        childRequestId: expect.stringMatching(/^sub:r:legacy-session-id:/u),
        childSessionId: `sub:s:legacy-session-id:named:${res.sessionName}`,
      },
    ]);
  });

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
        {
          profile: "explore",
          task: "Map auth flow",
          mode: "sync",
        },
        {
          toolCallId: "tool-1",
          messages: [],
          context: {
            requestId: "r:1",
            sessionId: "s:1",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.mode).toBe("sync");
    if (res.mode !== "sync") throw new Error("expected sync subagent result");
    expect(res.ok).toBe(true);
    expect(res.status).toBe("resolved");
    expect(res.profile).toBe("explore");
    expect(res.sessionName).toMatch(/^explore-[0-9a-f]{8}$/u);
    expect(res.finalText).toBe("hello world");
    expect(res).not.toHaveProperty("childRequestId");
    expect(res).not.toHaveProperty("childSessionId");
    expect(res).not.toHaveProperty("timeoutMs");
    expect(res).not.toHaveProperty("durationMs");
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
          {
            profile,
            task: "Do delegated work",
            mode: "sync",
          },
          {
            toolCallId: `tool-${profile}`,
            messages: [],
            context: {
              requestId: `r:${profile}`,
              sessionId: `s:${profile}`,
              requestClient: "discord",
              subagentDepth: 0,
            },
          },
        ),
      );

      expect(res.mode).toBe("sync");
      if (res.mode !== "sync") throw new Error("expected sync subagent result");
      expect(res.ok).toBe(true);
      expect(res.status).toBe("resolved");
      expect(res.profile).toBe(profile);
      expect(res.finalText).toBe(`done:${profile}`);
    }

    expect(seenProfiles).toEqual(["general", "self"]);
  });

  it("derives child session id from sessionName for continuation", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
    });

    const sessionName = "session-1";
    const expectedSessionId = `sub:s:parent:named:${sessionName}`;
    let seenChildSessionId: string | null = null;

    await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "subagent-test-worker-continued-session",
        consumerId: "subagent-test-worker-continued-session",
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

        seenChildSessionId = sessionId;

        await bus.publish(
          lilacEventTypes.EvtAgentOutputResponseText,
          {
            finalText: "continued",
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
        {
          profile: "explore",
          task: "Continue prior work",
          mode: "sync",
          sessionName,
        },
        {
          toolCallId: "tool-continued-session",
          messages: [],
          context: {
            requestId: "r:continued-session",
            sessionId: "s:parent",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(res.status).toBe("resolved");
    expect(res.sessionName).toBe(sessionName);
    expect(seenChildSessionId === expectedSessionId).toBe(true);
  });

  it("rejects invalid continuation session names", async () => {
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
        {
          profile: "explore",
          task: "Continue prior work",
          mode: "deferred",
          sessionName: "../someone-else",
        },
        {
          toolCallId: "tool-invalid-continued-session",
          messages: [],
          context: {
            requestId: "r:invalid-continued-session",
            sessionId: "s:parent",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    ).rejects.toThrow(/sessionName must be a short slug/i);
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
        { profile: "explore", task: "Map auth flow", mode: "deferred" },
        {
          toolCallId: "tool-2",
          messages: [],
          context: {
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
        { profile: "explore", task: "Map auth flow", mode: "deferred" },
        {
          toolCallId: "tool-no-nest-explore",
          messages: [],
          context: {
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
        { profile: "general", task: "Fix lint", mode: "deferred" },
        {
          toolCallId: "tool-no-nest-general",
          messages: [],
          context: {
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
        { profile: "self", task: "Spawn self again", mode: "deferred" },
        {
          toolCallId: "tool-self-self",
          messages: [],
          context: {
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
        {
          profile: "explore",
          task: "Map auth flow",
          mode: "sync",
        },
        {
          toolCallId: "tool-self-explore",
          messages: [],
          context: {
            requestId: "r:self-explore",
            sessionId: "s:self-explore",
            requestClient: "discord",
            subagentDepth: 1,
            subagentProfile: "self",
          },
        },
      ),
    );

    expect(res.mode).toBe("sync");
    if (res.mode !== "sync") throw new Error("expected sync subagent result");
    expect(res.status).toBe("resolved");
    expect(res.finalText).toBe("self->explore ok");
    expect(res.profile).toBe("explore");
  });

  it("clamps timeoutMs to configured max", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    let capturedTimeoutMs: number | undefined;

    const tools = subagentTools({
      bus,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 4_000,
      maxDepth: 1,
      onDeferredDelegate: async (registration) => {
        capturedTimeoutMs = registration.timeoutMs;
      },
    });

    const res = await resolveExecuteResult(
      tools.subagent_delegate.execute!(
        {
          profile: "explore",
          task: "Map auth flow",
          mode: "deferred",
          timeoutMs: 999_999,
        },
        {
          toolCallId: "tool-3",
          messages: [],
          context: {
            requestId: "r:3",
            sessionId: "s:3",
            requestClient: "discord",
            subagentDepth: 0,
          },
        },
      ),
    );

    expect(capturedTimeoutMs).toBe(4_000);
    expect(res.status).toBe("accepted");
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
    const parentUpdates: Array<{ status: "start" | "update" | "end"; display: string }> = [];

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
        {
          profile: "explore",
          task: "Map auth flow",
          mode: "sync",
        },
        {
          toolCallId: parentToolCallId,
          messages: [],
          context: {
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
