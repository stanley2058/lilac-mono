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

import type { TranscriptStore } from "../../../src/transcript/transcript-store";
import type { ModelMessage } from "ai";

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
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    const key = `${msgRef.channelId}:${msgRef.messageId}`;
    const base = this.messages[key];
    if (!base) return [];

    const limit = opts?.limit ?? 20;
    const half = Math.max(1, Math.floor(limit / 2));

    const all = Object.values(this.messages)
      .filter((m) => m.session.channelId === msgRef.channelId)
      .slice()
      .sort((a, b) => a.ts - b.ts);

    const beforeAll = all.filter((m) => m.ts <= base.ts);
    const before = beforeAll.slice(Math.max(0, beforeAll.length - half));

    const after = all.filter((m) => m.ts > base.ts).slice(0, half);

    return before.concat(after);
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error("not implemented");
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {
    throw new Error("not implemented");
  }

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    return [];
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
  it("includes reply-thread root when mention is part of a mergeable reply burst (active channel)", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";

    const messages: Record<string, SurfaceMessage> = {};

    const add = (m: SurfaceMessage) => {
      messages[`${m.session.channelId}:${m.ref.messageId}`] = m;
    };

    add({
      ref: { platform: "discord", channelId: sessionId, messageId: "root" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u0",
      userName: "rooter",
      text: "Root",
      ts: 0,
      raw: { reference: {} },
    });

    for (let i = 1; i <= 7; i++) {
      add({
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: `f${i}`,
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "ux",
        userName: "other",
        text: `filler ${i}`,
        ts: i * 100,
        raw: { reference: {} },
      });
    }

    add({
      ref: { platform: "discord", channelId: sessionId, messageId: "m1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 1",
      ts: 1000,
      raw: { reference: { messageId: "root", channelId: sessionId } },
    });

    add({
      ref: { platform: "discord", channelId: sessionId, messageId: "m2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "user msg 2",
      ts: 1100,
      raw: { reference: {} },
    });

    add({
      ref: { platform: "discord", channelId: sessionId, messageId: "m3" },
      session: { platform: "discord", channelId: sessionId },
      userId: "u1",
      userName: "user1",
      text: "<@bot> user msg 3",
      ts: 1200,
      raw: { reference: {} },
    });

    const adapter = new FakeAdapter(messages);

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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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
      messageId: "m3",
      userId: "u1",
      userName: "user1",
      text: "<@bot> user msg 3",
      ts: Date.now(),
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(1);
    const evt = received[0];
    expect(evt.data.queue).toBe("prompt");

    // Should include the replied-to root plus the merged user burst.
    expect(evt.data.messages.length).toBe(2);

    const rootText = evt.data.messages[0].content;
    const mergedText = evt.data.messages[1].content;

    expect(typeof rootText).toBe("string");
    expect(typeof mergedText).toBe("string");

    expect(rootText).toContain("Root");
    expect(mergedText).toContain("user msg 1");
    expect(mergedText).toContain("user msg 2");
    expect(mergedText).toContain("user msg 3");
    expect(mergedText).not.toContain("<@bot>");

    expect(evt.data.raw?.chainMessageIds).toContain("root");
    expect(evt.data.raw?.chainMessageIds).toContain("m1");
    expect(evt.data.raw?.chainMessageIds).toContain("m2");
    expect(evt.data.raw?.chainMessageIds).toContain("m3");

    await sub.stop();
    await router.stop();
  });
  it("forks from a stored transcript when replying to a linked bot message", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const replyToMessageId = "bot-1";
    const msgId = "m2";

    const adapter = new FakeAdapter({
      [`${sessionId}:${replyToMessageId}`]: {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: replyToMessageId,
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "(bot message)",
        ts: Date.now() - 10_000,
        raw: { reference: {} },
      },
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "replying",
        ts: Date.now(),
        raw: {
          reference: { messageId: replyToMessageId },
          discord: { attachments: [] },
        },
      },
    });

    const baseTranscript: ModelMessage[] = [
      { role: "assistant", content: "stored assistant context" },
    ];

    const transcriptStore: TranscriptStore = {
      saveRequestTranscript: () => {},
      linkSurfaceMessagesToRequest: () => {},
      getTranscriptBySurfaceMessage: ({ messageId }) => {
        if (messageId !== replyToMessageId) return null;
        return {
          requestId: "r1",
          sessionId,
          requestClient: "discord",
          createdTs: Date.now(),
          updatedTs: Date.now(),
          messages: baseTranscript,
        };
      },
      close: () => {},
    };

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      transcriptStore,
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            mentionNotifications: { enabled: false, maxUsers: 5 },
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
      text: "replying",
      ts: Date.now(),
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
        },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${msgId}`);
    expect(received[0].data.messages.length).toBe(2);
    expect(received[0].data.messages[0].role).toBe("assistant");
    expect(received[0].data.messages[1].role).toBe("user");

    await sub.stop();
    await router.stop();
  });

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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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

  it("suppresses routing when shouldSuppressAdapterEvent returns suppress=true", async () => {
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
      shouldSuppressAdapterEvent: async () => ({
        suppress: true,
        reason: "test",
      }),
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            mentionNotifications: { enabled: false, maxUsers: 5 },
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

    // Would normally trigger (mentionsBot=true), but should be suppressed.
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

    expect(received.length).toBe(0);

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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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

  it("forwards active channel batch when gate is disabled", async () => {
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
      routerGate: async () => {
        throw new Error("routerGate should not be called when gate is disabled");
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            mentionNotifications: { enabled: false, maxUsers: 5 },
          },
          router: {
            defaultMode: "active",
            sessionModes: {},
            activeDebounceMs: 5,
            activeGate: { enabled: false, timeoutMs: 2500 },
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

  it("forwards active channel batch when gate is disabled per session", async () => {
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
      routerGate: async () => {
        throw new Error(
          "routerGate should not be called when gate is disabled per session",
        );
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            mentionNotifications: { enabled: false, maxUsers: 5 },
          },
          router: {
            defaultMode: "active",
            sessionModes: {
              [sessionId]: { mode: "active", gate: false },
            },
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

    await sub.stop();
    await router.stop();
  });

  it("skips active channel batch when gate is enabled per session", async () => {
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

    let called = 0;
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => {
        called += 1;
        return { forward: false, reason: "no" };
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            mentionNotifications: { enabled: false, maxUsers: 5 },
          },
          router: {
            defaultMode: "active",
            sessionModes: {
              [sessionId]: { mode: "active", gate: true },
            },
            activeDebounceMs: 5,
            activeGate: { enabled: false, timeoutMs: 2500 },
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

    expect(called).toBe(1);
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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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

  it("routes DM in-flight messages as followUp", async () => {
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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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
    expect(received[0].data.queue).toBe("followUp");
    expect(received[0].headers?.request_id).toBe(requestId);

    await sub.stop();
    await router.stop();
  });

  it("routes in-flight active channel replies as queued prompts; other messages remain followUps", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const replyMsgId = "m-reply";
    const followMsgId = "m-follow";
    const requestId = `discord:${sessionId}:anchor`;

    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${replyMsgId}`]: {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: replyMsgId,
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "replying",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${followMsgId}`]: {
        ref: {
          platform: "discord",
          channelId: sessionId,
          messageId: followMsgId,
        },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "follow up",
        ts: now + 1,
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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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
    const surfaceCmd: any[] = [];
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

    const subSurface = await bus.subscribeTopic(
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
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

    // Reply forks into a queued-behind prompt.
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: replyMsgId,
      userId: "u1",
      userName: "user1",
      text: "replying",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: true },
      },
    });

    // Non-reply messages remain followUps into the running request.
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgId,
      userId: "u2",
      userName: "user2",
      text: "follow up",
      ts: now + 1,
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(2);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${replyMsgId}`);
    expect(received[1].data.queue).toBe("steer");
    expect(received[1].headers?.request_id).toBe(requestId);

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(requestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(true);

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("treats replies to active output as followUp, and reply+mention as steer", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const requestId = `discord:${sessionId}:anchor`;

    const replyToActiveId = "a2";
    const followMsgId = "m-follow";
    const steerMsgId = "m-steer";

    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${followMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: followMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "@lilac replying (no mention)",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${steerMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: steerMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "<@bot> replying (mention)",
        ts: now + 1,
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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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
    const surfaceCmd: any[] = [];

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

    const subSurface = await bus.subscribeTopic(
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
        offset: { type: "begin" },
      },
      async (m, ctx) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        await ctx.commit();
      },
    );

    // Mark request running.
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

    // Tell router which bot message is currently active output.
    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      {
        msgRef: {
          platform: "discord",
          channelId: sessionId,
          messageId: replyToActiveId,
        },
      },
      {
        headers: {
          request_id: requestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    // Reply to the active output -> followUp.
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgId,
      userId: "u1",
      userName: "user1",
      text: "replying (no mention)",
      ts: now,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: replyToActiveId,
        },
      },
    });

    // Reply+mention to the active output -> steer + reanchor.
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: steerMsgId,
      userId: "u2",
      userName: "user2",
      text: "<@bot> replying (mention)",
      ts: now + 1,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: true,
          replyToMessageId: replyToActiveId,
        },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(2);
    expect(received[0].data.queue).toBe("followUp");
    expect(received[0].headers?.request_id).toBe(requestId);
    expect(received[1].data.queue).toBe("steer");
    expect(received[1].headers?.request_id).toBe(requestId);

    // Leading bot mentions should be stripped consistently for followUp/steer.
    const followUpText = received[0].data.messages?.[0]?.content;
    const steerText = received[1].data.messages?.[0]?.content;
    expect(typeof followUpText).toBe("string");
    expect(typeof steerText).toBe("string");
    expect(followUpText as string).toContain("replying (no mention)");
    expect(followUpText as string).not.toContain("@lilac");
    expect(steerText as string).toContain("replying (mention)");
    expect(steerText as string).not.toContain("<@bot>");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(requestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(false);
    expect(surfaceCmd[0].data.replyTo?.messageId).toBe(steerMsgId);

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("ignores non-triggers in mention-only channels, and queues triggers behind active requests", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const requestId = `discord:${sessionId}:anchor`;
    const msgMention = "m-mention";
    const msgOther = "m-other";

    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgMention}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgMention },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> hi",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${msgOther}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgOther },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "hello everyone",
        ts: now + 1,
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
            mentionNotifications: { enabled: false, maxUsers: 5 },
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

    // Mark request running.
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

    // Non-trigger ignored.
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgOther,
      userId: "u2",
      userName: "user2",
      text: "hello everyone",
      ts: now + 1,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    // Trigger queues behind active request.
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgMention,
      userId: "u1",
      userName: "user1",
      text: "<@bot> hi",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    await new Promise((r) => setTimeout(r, 0));

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${msgMention}`);
    expect(received[0].data.raw?.triggerType).toBe("mention");

    await sub.stop();
    await router.stop();
  });
});
