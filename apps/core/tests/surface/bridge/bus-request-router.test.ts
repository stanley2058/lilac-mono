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

import { startBusRequestRouter } from "../../../src/surface/bridge/bus-request-router";

import type {
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";

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
      const id = String(Date.now()) + "-0";
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

      if (opts.mode === "tail" && opts.offset?.type === "begin") {
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

    fetch: async <TData>(topic: string, _opts: any) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m as unknown as Message<TData>,
          cursor: m.id,
        })),
        next:
          existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

class FakeAdapter implements SurfaceAdapter {
  constructor(private readonly messages: Record<string, SurfaceMessage>) {}

  async connect(): Promise<void> {
    throw new Error("not implemented");
  }
  async disconnect(): Promise<void> {
    throw new Error("not implemented");
  }

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "discord", userId: "bot", userName: "lilac" };
  }
  async getCapabilities(): Promise<AdapterCapabilities> {
    throw new Error("not implemented");
  }

  async listSessions(): Promise<SurfaceSession[]> {
    throw new Error("not implemented");
  }

  async startOutput(_sessionRef: SessionRef): Promise<SurfaceOutputStream> {
    throw new Error("not implemented");
  }

  async sendMsg(
    _sessionRef: SessionRef,
    _content: ContentOpts,
    _opts?: SendOpts,
  ): Promise<MsgRef> {
    throw new Error("not implemented");
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    const key = `${msgRef.channelId}:${msgRef.messageId}`;
    return this.messages[key] ?? null;
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    const limit = opts?.limit ?? 50;

    const list = Object.values(this.messages)
      .filter((m) => m.session.channelId === sessionRef.channelId)
      .slice()
      .sort((a, b) => a.ts - b.ts);

    return list.slice(Math.max(0, list.length - limit));
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteMsg(_msgRef: MsgRef): Promise<void> {
    throw new Error("not implemented");
  }

  async getReplyContext(
    _msgRef: MsgRef,
    _opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error("not implemented");
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error("not implemented");
  }

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    throw new Error("not implemented");
  }

  async subscribe(): Promise<{ stop(): Promise<void> }> {
    throw new Error("not implemented");
  }

  async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }

  async markRead(_sessionRef: SessionRef): Promise<void> {
    throw new Error("not implemented");
  }
}

describe("startBusRequestRouter", () => {
  it("publishes cmd.request.message for mention-only mode trigger", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const msgId = "m1";

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> hi",
        ts: Date.now(),
        raw: { reference: {} },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
          },
          router: {
            defaultMode: "active",
            sessionModes: {},
            activeDebounceMs: 5,
            activeGate: { enabled: true, timeoutMs: 2500 },
          },
        },
        agent: { systemPrompt: "(unused in tests; compiled at runtime)" },
        models: {
          def: {},
          main: { model: "openrouter/openai/gpt-4o" },
          fast: { model: "openrouter/openai/gpt-4o-mini" },
        },
      },
    });

    // capture cmd.request.message
    const received: any[] = [];
    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        await ctx.commit();
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> hi",
      ts: Date.now(),
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.session_id).toBe(sessionId);

    await sub.stop();
    await router.stop();
  });

  it("skips active channel batch when gate returns forward=false", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const msgId = "m1";

    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "hello there",
        ts: now,
        raw: { reference: {} },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => ({ forward: false, reason: "no" }),
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
          },
          router: {
            defaultMode: "active",
            sessionModes: {},
            activeDebounceMs: 5,
            activeGate: { enabled: true, timeoutMs: 2500 },
          },
        },
        agent: { systemPrompt: "(unused in tests; compiled at runtime)" },
        models: {
          def: {},
          main: { model: "openrouter/openai/gpt-4o" },
          fast: { model: "openrouter/openai/gpt-4o-mini" },
        },
      },
    });

    const received: any[] = [];
    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        await ctx.commit();
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "hello there",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(received.length).toBe(0);

    await sub.stop();
    await router.stop();
  });

  it("forwards active channel batch when gate returns forward=true (prompt only)", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const msgId = "m1";

    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "hello there",
        ts: now,
        raw: { reference: {} },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => ({ forward: true, reason: "yes" }),
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
          },
          router: {
            defaultMode: "active",
            sessionModes: {},
            activeDebounceMs: 5,
            activeGate: { enabled: true, timeoutMs: 2500 },
          },
        },
        agent: { systemPrompt: "(unused in tests; compiled at runtime)" },
        models: {
          def: {},
          main: { model: "openrouter/openai/gpt-4o" },
          fast: { model: "openrouter/openai/gpt-4o-mini" },
        },
      },
    });

    const received: any[] = [];
    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        await ctx.commit();
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "hello there",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 30));

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(String(received[0].headers?.request_id).startsWith("discord:")).toBe(
      false,
    );

    await sub.stop();
    await router.stop();
  });

  it("routes in-flight active channel messages as followUp (same user)", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const msgId = "m1";

    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "follow up",
        ts: now,
        raw: { reference: {} },
      },
    });

    const requestId = `discord:${sessionId}:anchor`;

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
          },
          router: {
            defaultMode: "active",
            sessionModes: {},
            activeDebounceMs: 5,
            activeGate: { enabled: true, timeoutMs: 2500 },
          },
        },
        agent: { systemPrompt: "(unused in tests; compiled at runtime)" },
        models: {
          def: {},
          main: { model: "openrouter/openai/gpt-4o" },
          fast: { model: "openrouter/openai/gpt-4o-mini" },
        },
      },
    });

    const received: any[] = [];
    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        await ctx.commit();
      },
    );

    // Mark request running so router treats session as active.
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: requestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "follow up",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("followUp");
    expect(received[0].headers?.request_id).toBe(requestId);

    await sub.stop();
    await router.stop();
  });

  it("routes DM in-flight messages as steer", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "dm";
    const msgId = "m1";

    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "dm steer",
        ts: now,
        raw: { reference: {} },
      },
    });

    const requestId = `discord:${sessionId}:anchor`;

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {},
            activeDebounceMs: 5,
            activeGate: { enabled: true, timeoutMs: 2500 },
          },
        },
        agent: { systemPrompt: "(unused in tests; compiled at runtime)" },
        models: {
          def: {},
          main: { model: "openrouter/openai/gpt-4o" },
          fast: { model: "openrouter/openai/gpt-4o-mini" },
        },
      },
    });

    const received: any[] = [];
    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        await ctx.commit();
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: requestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "dm steer",
      ts: now,
      raw: {
        discord: { isDMBased: true, mentionsBot: false, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("steer");
    expect(received[0].headers?.request_id).toBe(requestId);

    await sub.stop();
    await router.stop();
  });
});
