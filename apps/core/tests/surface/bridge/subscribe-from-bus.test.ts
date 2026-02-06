import { describe, expect, it } from "bun:test";

import { bridgeBusToAdapter } from "../../../src/surface/bridge/subscribe-from-bus";
import type {
  SurfaceAdapter,
  SurfaceOutputPart,
  SurfaceOutputResult,
  StartOutputOpts,
} from "../../../src/surface/adapter";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  SendOpts,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";
import type { MsgRef, SessionRef } from "../../../src/surface/types";

import {
  createLilacBus,
  type RawBus,
  lilacEventTypes,
  type Message,
  type SubscriptionOptions,
  type HandleContext,
  type FetchOptions,
  type PublishOptions,
} from "@stanley2058/lilac-event-bus";

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
        if (s.opts.mode === "tail" && s.opts.offset?.type === "now") {
          // For our tests we always use begin/now explicitly; ignore edge.
        }
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

      if (opts.mode === "tail" && opts.offset?.type === "begin") {
        const existing = topics.get(topic) ?? [];
        for (const m of existing) {
          await handler(m as unknown as Message<TData>, { cursor: m.id, commit: async () => {} });
        }
      }

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

class FakeOutputStream {
  public readonly parts: SurfaceOutputPart[] = [];
  public finished = false;
  public aborted: string | undefined;

  async push(part: SurfaceOutputPart): Promise<void> {
    this.parts.push(part);
  }

  async finish(): Promise<SurfaceOutputResult> {
    this.finished = true;
    const last: MsgRef = { platform: "discord", channelId: "chan", messageId: "m_out" };
    return { created: [last], last };
  }

  async abort(reason?: string): Promise<void> {
    this.aborted = reason;
  }
}

class FakeAdapter implements SurfaceAdapter {
  public lastStart: { sessionRef: SessionRef; opts?: StartOutputOpts } | null = null;
  public stream: FakeOutputStream | null = null;
  public typingStarts: SessionRef[] = [];
  public typingStops = 0;

  async connect(): Promise<void> {
    throw new Error("not implemented");
  }
  async disconnect(): Promise<void> {
    throw new Error("not implemented");
  }
  async getSelf(): Promise<SurfaceSelf> {
    throw new Error("not implemented");
  }
  async getCapabilities(): Promise<AdapterCapabilities> {
    throw new Error("not implemented");
  }
  async listSessions(): Promise<SurfaceSession[]> {
    throw new Error("not implemented");
  }

  async startOutput(sessionRef: SessionRef, opts?: StartOutputOpts) {
    this.lastStart = { sessionRef, opts };
    this.stream = new FakeOutputStream();
    return this.stream;
  }

  async startTyping(sessionRef: SessionRef): Promise<{ stop(): Promise<void> }> {
    this.typingStarts.push(sessionRef);
    return {
      stop: async () => {
        this.typingStops += 1;
      },
    };
  }

  async sendMsg(_sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    throw new Error("not implemented");
  }
  async readMsg(_msgRef: MsgRef): Promise<SurfaceMessage | null> {
    throw new Error("not implemented");
  }
  async listMsg(_sessionRef: SessionRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
    throw new Error("not implemented");
  }
  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<void> {
    throw new Error("not implemented");
  }
  async deleteMsg(_msgRef: MsgRef): Promise<void> {
    throw new Error("not implemented");
  }
  async getReplyContext(_msgRef: MsgRef, _opts?: LimitOpts): Promise<SurfaceMessage[]> {
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
  async markRead(_sessionRef: SessionRef, _upToMsgRef?: MsgRef): Promise<void> {
    throw new Error("not implemented");
  }
}

describe("bridgeBusToAdapter", () => {
  it("starts an output relay on evt.request.reply and streams output parts", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_1";

    // Pre-publish output before the reply event to ensure offset: begin catches it.
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "hello" },
      { headers: { request_id: requestId } },
    );

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "call-1",
        status: "start",
        display: "[bash] echo hi",
      },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "final" },
      { headers: { request_id: requestId } },
    );

    // Relay is async; wait one tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.lastStart?.sessionRef).toEqual({ platform: "discord", channelId: "chan" });
    expect(adapter.lastStart?.opts?.requestId).toBe(requestId);
    expect(adapter.lastStart?.opts?.replyTo).toEqual({
      platform: "discord",
      channelId: "chan",
      messageId: "msg_1",
    });

    expect(adapter.stream?.parts).toEqual([
      { type: "text.delta", delta: "hello" },
      {
        type: "tool.status",
        update: {
          toolCallId: "call-1",
          status: "start",
          display: "[bash] echo hi",
        },
      },
      { type: "text.set", text: "final" },
    ]);

    expect(adapter.stream?.finished).toBe(true);

    expect(adapter.typingStarts).toEqual([{ platform: "discord", channelId: "chan" }]);
    expect(adapter.typingStops).toBe(1);

    await bridge.stop();
  });

  it("does not start a relay twice for duplicate reply events", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_2";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "done" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.lastStart).not.toBeNull();
    expect(adapter.stream?.finished).toBe(true);

    expect(adapter.typingStarts).toEqual([{ platform: "discord", channelId: "chan" }]);
    expect(adapter.typingStops).toBe(1);

    await bridge.stop();
  });
});
