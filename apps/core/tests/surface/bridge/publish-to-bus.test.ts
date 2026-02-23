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

import type {
  AdapterSubscription,
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceOutputStream,
  TypingIndicatorSubscription,
} from "../../../src/surface/adapter";
import { bridgeAdapterToBus } from "../../../src/surface/bridge/publish-to-bus";
import type { AdapterEvent } from "../../../src/surface/events";
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
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  return {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const id = `${Date.now()}-${Math.random()}`;
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

      for (const sub of subs) {
        if (sub.topic !== opts.topic) continue;
        await sub.handler(stored, { cursor: id, commit: async () => {} });
      }

      return { id, cursor: id };
    },

    subscribe: async <TData>(
      topic: string,
      _opts: SubscriptionOptions,
      handler: (msg: Message<TData>, ctx: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
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

class FakeAdapter implements SurfaceAdapter {
  private readonly handlers = new Set<AdapterEventHandler>();

  emit(evt: AdapterEvent) {
    for (const handler of this.handlers) {
      void handler(evt);
    }
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "discord", userId: "bot", userName: "lilac" };
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      platform: "discord",
      send: true,
      edit: true,
      delete: true,
      reactions: true,
      readHistory: true,
      threads: true,
      markRead: true,
    };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    return [];
  }

  async startOutput(_sessionRef: SessionRef): Promise<SurfaceOutputStream> {
    throw new Error("unused");
  }

  async sendMsg(_sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    throw new Error("unused");
  }

  async readMsg(_msgRef: MsgRef): Promise<SurfaceMessage | null> {
    return null;
  }

  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
    return [];
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {}

  async deleteMsg(_msgRef: MsgRef): Promise<void> {}

  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
    return [];
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {}

  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<void> {}

  async listReactions(_msgRef: MsgRef): Promise<string[]> {
    return [];
  }

  async subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(_sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    return [];
  }

  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {}

  async startTyping(_sessionRef: SessionRef): Promise<TypingIndicatorSubscription> {
    return { stop: async () => {} };
  }
}

describe("bridgeAdapterToBus cancel mapping", () => {
  it("maps adapter message and reaction events to Lilac bus events", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();

    await bridgeAdapterToBus({ adapter, bus, subscriptionId: "test" });

    const published: Array<Message<unknown>> = [];
    const evtSub = await bus.subscribeTopic(
      "evt.adapter",
      {
        mode: "fanout",
        subscriptionId: "test:evt",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        published.push(msg as Message<unknown>);
        await ctx.commit();
      },
    );

    const session = { platform: "discord" as const, channelId: "chan" };
    const message = {
      ref: { platform: "discord" as const, channelId: "chan", messageId: "m1" },
      session,
      userId: "u1",
      userName: "alice",
      text: "hello",
      ts: Date.now(),
      raw: { discord: { mentionsBot: false } },
    };

    adapter.emit({
      type: "adapter.message.created",
      platform: "discord",
      ts: Date.now(),
      message,
    });

    adapter.emit({
      type: "adapter.message.updated",
      platform: "discord",
      ts: Date.now(),
      message: {
        ...message,
        text: "hello updated",
      },
    });

    adapter.emit({
      type: "adapter.message.deleted",
      platform: "discord",
      ts: Date.now(),
      messageRef: message.ref,
      session,
      raw: { reason: "deleted" },
    });

    adapter.emit({
      type: "adapter.reaction.added",
      platform: "discord",
      ts: Date.now(),
      messageRef: message.ref,
      session,
      reaction: "👍",
      userId: "u2",
      userName: "bob",
    });

    adapter.emit({
      type: "adapter.reaction.removed",
      platform: "discord",
      ts: Date.now(),
      messageRef: message.ref,
      session,
      reaction: "👍",
      userId: "u2",
      userName: "bob",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(published.map((m) => m.type)).toEqual([
      lilacEventTypes.EvtAdapterMessageCreated,
      lilacEventTypes.EvtAdapterMessageUpdated,
      lilacEventTypes.EvtAdapterMessageDeleted,
      lilacEventTypes.EvtAdapterReactionAdded,
      lilacEventTypes.EvtAdapterReactionRemoved,
    ]);

    const created = published[0]!;
    expect(created.data).toMatchObject({
      platform: "discord",
      channelId: "chan",
      messageId: "m1",
      userId: "u1",
      text: "hello",
    });

    const reactionAdded = published[3]!;
    expect(reactionAdded.data).toMatchObject({
      platform: "discord",
      channelId: "chan",
      messageId: "m1",
      reaction: "👍",
      userId: "u2",
    });

    await evtSub.stop();
  });

  it("keeps active-only behavior for cancel button events", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();

    await bridgeAdapterToBus({ adapter, bus, subscriptionId: "test" });

    const published: Array<Message<unknown>> = [];
    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test:cmd",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        published.push(msg as Message<unknown>);
        await ctx.commit();
      },
    );

    adapter.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: "discord:chan:m1",
      sessionId: "chan",
      source: "button",
      cancelScope: "active_only",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(published.length).toBe(1);
    const msg = published[0]!;
    expect(msg.type).toBe(lilacEventTypes.CmdRequestMessage);
    expect(msg.data).toEqual({
      queue: "interrupt",
      messages: [],
      raw: {
        cancel: true,
        cancelQueued: false,
        requiresActive: true,
        source: "button",
      },
    });

    await sub.stop();
  });

  it("marks context-menu cancels as queue-capable", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();

    await bridgeAdapterToBus({ adapter, bus, subscriptionId: "test" });

    const published: Array<Message<unknown>> = [];
    const sub = await bus.subscribeTopic(
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test:cmd",
        consumerId: "c1",
        offset: { type: "begin" },
      },
      async (msg, ctx) => {
        published.push(msg as Message<unknown>);
        await ctx.commit();
      },
    );

    adapter.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: "discord:chan:m2",
      sessionId: "chan",
      source: "context_menu",
      cancelScope: "active_or_queued",
      userId: "u1",
      messageId: "m2",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(published.length).toBe(1);
    const msg = published[0]!;
    expect(msg.type).toBe(lilacEventTypes.CmdRequestMessage);
    expect(msg.data).toEqual({
      queue: "interrupt",
      messages: [],
      raw: {
        cancel: true,
        cancelQueued: true,
        requiresActive: false,
        source: "context_menu",
        userId: "u1",
        messageId: "m2",
      },
    });

    await sub.stop();
  });
});
