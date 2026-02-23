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
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
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

      if (opts.mode === "tail") {
        const existing = topics.get(topic) ?? [];
        if (opts.offset?.type === "begin") {
          for (const m of existing) {
            await handler(m as unknown as Message<TData>, {
              cursor: m.id,
              commit: async () => {},
            });
          }
        } else if (opts.offset?.type === "cursor") {
          let seenCursor = false;
          for (const m of existing) {
            if (!seenCursor) {
              if (m.id === opts.offset.cursor) {
                seenCursor = true;
              }
              continue;
            }
            await handler(m as unknown as Message<TData>, {
              cursor: m.id,
              commit: async () => {},
            });
          }
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

function createInMemoryRawBusWithBlockingTailStop(): {
  raw: RawBus;
  releaseTailStops(): void;
} {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: (msg: Message<unknown>, ctx: HandleContext) => Promise<void>;
  }>();

  let tailStopGatePromise: Promise<void> | null = null;
  let tailStopGateResolve: (() => void) | null = null;

  const ensureTailStopGate = () => {
    if (tailStopGatePromise) return tailStopGatePromise;
    tailStopGatePromise = new Promise<void>((resolve) => {
      tailStopGateResolve = resolve;
    });
    return tailStopGatePromise;
  };

  const raw: RawBus = {
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
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
        handler: handler as unknown as (msg: Message<unknown>, ctx: HandleContext) => Promise<void>,
      };
      subs.add(entry);

      if (opts.mode === "tail") {
        const existing = topics.get(topic) ?? [];
        if (opts.offset?.type === "begin") {
          for (const m of existing) {
            await handler(m as unknown as Message<TData>, {
              cursor: m.id,
              commit: async () => {},
            });
          }
        } else if (opts.offset?.type === "cursor") {
          let seenCursor = false;
          for (const m of existing) {
            if (!seenCursor) {
              if (m.id === opts.offset.cursor) {
                seenCursor = true;
              }
              continue;
            }
            await handler(m as unknown as Message<TData>, {
              cursor: m.id,
              commit: async () => {},
            });
          }
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
          if (opts.mode === "tail") {
            await ensureTailStopGate();
          }
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

  return {
    raw,
    releaseTailStops: () => {
      tailStopGateResolve?.();
      tailStopGateResolve = null;
      tailStopGatePromise = null;
    },
  };
}

class FakeOutputStream {
  public readonly parts: SurfaceOutputPart[] = [];
  public finished = false;
  public aborted: string | undefined;
  private created = false;

  constructor(private readonly onFirstPush?: () => void) {}

  async push(part: SurfaceOutputPart): Promise<void> {
    if (!this.created) {
      this.created = true;
      this.onFirstPush?.();
    }
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
  public starts: Array<{ sessionRef: SessionRef; opts?: StartOutputOpts }> = [];
  public streams: FakeOutputStream[] = [];
  public typingStarts: SessionRef[] = [];
  public typingStops = 0;
  public deletedMsgs: MsgRef[] = [];
  private nextOutputMessageId = 1;

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
    this.starts.push({ sessionRef, opts });
    const outputMessageId = `m_out_${this.nextOutputMessageId++}`;
    const s = new FakeOutputStream(() => {
      if (sessionRef.platform !== "discord") return;
      opts?.onMessageCreated?.({
        platform: "discord",
        channelId: sessionRef.channelId,
        messageId: outputMessageId,
      });
    });
    this.stream = s;
    this.streams.push(s);
    return s;
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
  async deleteMsg(msgRef: MsgRef): Promise<void> {
    this.deletedMsgs.push(msgRef);
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
        display: "bash echo hi",
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
          display: "bash echo hi",
        },
      },
      { type: "text.set", text: "final" },
    ]);

    expect(adapter.stream?.finished).toBe(true);

    expect(adapter.typingStarts).toEqual([{ platform: "discord", channelId: "chan" }]);
    expect(adapter.typingStops).toBe(1);

    await bridge.stop();
  });

  it("forwards final stats metadata before final text", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_stats";

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

    const statsLine =
      "*[M]: gpt-5.2; [T]: ↑545,325 (NC: 196,269) ↓6,617 (R: 4,553); [TTFT]: 174.0s; [TPS]: 37.4*";

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      {
        finalText: "final",
        statsForNerdsLine: statsLine,
      },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts).toEqual([
      { type: "meta.stats", line: statsLine },
      { type: "text.set", text: "final" },
    ]);
    expect(adapter.stream?.finished).toBe(true);

    await bridge.stop();
  });

  it("forwards reasoning deltas into reasoning status updates", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_reasoning";

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
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "step 1\n" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "step 2" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "done" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const reasoningUpdates =
      adapter.stream?.parts.filter((p) => p.type === "reasoning.status").map((p) => p.update) ?? [];

    expect(reasoningUpdates.length).toBeGreaterThanOrEqual(1);
    expect(reasoningUpdates[0]?.detailText).toBe("step 1");
    expect(reasoningUpdates[reasoningUpdates.length - 1]?.detailText).toBe("step 1 step 2");
    expect(adapter.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "done" });

    await bridge.stop();
  });

  it("preserves readability when reasoning delta splits after punctuation", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_reasoning_punctuation";

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
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "Done.\n" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "Next" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "ok" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const reasoningUpdates =
      adapter.stream?.parts.filter((p) => p.type === "reasoning.status").map((p) => p.update) ?? [];
    expect(reasoningUpdates[reasoningUpdates.length - 1]?.detailText).toBe("Done. Next");

    await bridge.stop();
  });

  it("replaces reasoning detail when sequenced chunk updates arrive", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_reasoning_seq";

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

    // Start signal: starts timer with empty body.
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "**Chunk A**\nalpha", seq: 1 },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "**Chunk B**\nbeta", seq: 2 },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "done" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const reasoningUpdates =
      adapter.stream?.parts.filter((p) => p.type === "reasoning.status").map((p) => p.update) ?? [];

    expect(reasoningUpdates.length).toBeGreaterThanOrEqual(3);
    expect(reasoningUpdates[0]?.detailText).toBe("");
    expect(reasoningUpdates[reasoningUpdates.length - 1]?.detailText).toBe("**Chunk B**\nbeta");

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

  it("reanchors an active discord relay and continues streaming", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_3";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "a" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      { inheritReplyTo: true },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "b" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "ab" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.starts.length).toBe(2);
    expect(adapter.starts[0]?.opts?.replyTo?.messageId).toBe("msg_3");
    expect(adapter.starts[1]?.opts?.replyTo?.messageId).toBe("msg_3");

    expect(adapter.streams.length).toBe(2);
    expect(adapter.streams[0]?.aborted).toBe("reanchor");

    // First stream gets the first delta.
    expect(adapter.streams[0]?.parts).toEqual([{ type: "text.delta", delta: "a" }]);

    // Second stream starts fresh and only shows post-reanchor text.
    expect(adapter.streams[1]?.parts).toEqual([
      { type: "text.delta", delta: "b" },
      { type: "text.set", text: "b" },
    ]);

    expect(adapter.streams[1]?.finished).toBe(true);

    await bridge.stop();
  });

  it("uses interrupt reanchor abort reason for interrupt-mode reanchors", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_interrupt_reanchor";

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
      lilacEventTypes.CmdSurfaceOutputReanchor,
      { inheritReplyTo: true, mode: "interrupt" },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.streams.length).toBe(2);
    expect(adapter.streams[0]?.aborted).toBe("reanchor_interrupt");

    await bridge.stop();
  });

  it("reanchors with reasoning/tool replay but without prior text replay", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_reanchor_reasoning_tools";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "a" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "tool-1",
        status: "start",
        display: "bash ls",
      },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "thinking", seq: 1 },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      { inheritReplyTo: true },
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
      { finalText: "a" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.streams).toHaveLength(2);
    expect(adapter.streams[0]?.aborted).toBe("reanchor");

    const stream2 = adapter.streams[1]!;
    expect(stream2.parts[0]?.type).toBe("reasoning.status");
    if (stream2.parts[0]?.type === "reasoning.status") {
      expect(stream2.parts[0].update.detailText).toBe("thinking");
    }
    expect(stream2.parts[1]).toEqual({
      type: "tool.status",
      update: {
        toolCallId: "tool-1",
        status: "start",
        display: "bash ls",
        ok: undefined,
        error: undefined,
      },
    });
    expect(stream2.parts.at(-1)).toEqual({ type: "text.set", text: "" });
    expect(stream2.parts.some((p) => p.type === "text.set" && p.text === "a")).toBe(false);

    await bridge.stop();
  });

  it("skips empty post-reanchor stream when no new content exists", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_reanchor_empty_noop";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "a" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      { inheritReplyTo: true },
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
      { finalText: "a" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.streams).toHaveLength(2);
    expect(adapter.streams[0]?.aborted).toBe("reanchor");
    expect(adapter.streams[1]?.aborted).toBe("skip");
    expect(adapter.streams[1]?.finished).toBe(false);
    expect(adapter.streams[1]?.parts).toEqual([]);

    await bridge.stop();
  });

  it("cancels an active relay on cmd.request cancel and clears typing", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_cancel";

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

    expect(adapter.typingStarts).toEqual([{ platform: "discord", channelId: "chan" }]);

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: "interrupt",
        messages: [],
        raw: { cancel: true, requiresActive: true },
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.aborted).toBe("cancel");
    expect(adapter.typingStops).toBe(1);

    await bridge.stop();
  });

  it("stops typing on failed lifecycle and still delivers final output", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_failed_lifecycle";

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

    expect(adapter.typingStarts).toEqual([{ platform: "discord", channelId: "chan" }]);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "failed", detail: "boom" },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.typingStops).toBe(1);
    expect(adapter.stream?.finished).toBe(false);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "Error: boom" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts).toEqual([{ type: "text.set", text: "Error: boom" }]);
    expect(adapter.stream?.finished).toBe(true);
    // Ensure lifecycle-triggered typing stop is idempotent with relay stop.
    expect(adapter.typingStops).toBe(1);

    await bridge.stop();
  });

  it("skips final reply and deletes streamed discord messages", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_skip";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "working" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "NO_REPLY" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.aborted).toBe("skip");
    expect(adapter.stream?.finished).toBe(false);
    expect(adapter.deletedMsgs).toHaveLength(1);
    expect(adapter.deletedMsgs[0]).toEqual({
      platform: "discord",
      channelId: "chan",
      messageId: "m_out_1",
    });
    expect(adapter.stream?.parts).toEqual([{ type: "text.delta", delta: "working" }]);

    await bridge.stop();
  });

  it("buffers NO_REPLY deltas so sentinel text is never shown", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_skip_buffered";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "NO_" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "REPLY  " },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "NO_REPLY" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.aborted).toBe("skip");
    expect(adapter.stream?.parts).toEqual([]);
    expect(adapter.deletedMsgs).toHaveLength(0);

    await bridge.stop();
  });

  it("flushes buffered NO_REPLY prefix when reply becomes visible", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_visible_after_prefix";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "NO_RE" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "PLY because ..." },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "NO_REPLY because ..." },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts).toEqual([
      { type: "text.delta", delta: "NO_REPLY because ..." },
      { type: "text.set", text: "NO_REPLY because ..." },
    ]);
    expect(adapter.stream?.finished).toBe(true);

    await bridge.stop();
  });

  it("snapshots active relay state for graceful restart", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_snapshot";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "hello" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "tool-1",
        status: "start",
        display: "bash ls",
      },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const snapshots = bridge.snapshotRelays();
    expect(snapshots).toHaveLength(1);

    const snapshot = snapshots[0]!;
    expect(snapshot.requestId).toBe(requestId);
    expect(snapshot.visibleText).toBe("hello");
    expect(snapshot.reasoning).toBeUndefined();
    expect(snapshot.createdOutputRefs).toEqual([
      {
        platform: "discord",
        channelId: "chan",
        messageId: "m_out_1",
      },
    ]);
    expect(snapshot.toolStatus).toEqual([
      {
        toolCallId: "tool-1",
        status: "start",
        display: "bash ls",
        ok: undefined,
        error: undefined,
      },
    ]);
    expect(typeof snapshot.outCursor).toBe("string");

    await bridge.stop();
  });

  it("snapshots reasoning frozen timestamp after text starts", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_snapshot_reasoning_frozen";

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
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "", seq: 1 },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "hello" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const snapshot = bridge.snapshotRelays()[0]!;
    expect(snapshot.reasoning?.startedAtMs).toBeTypeOf("number");
    expect(snapshot.reasoning?.frozenAtMs).toBeTypeOf("number");
    expect((snapshot.reasoning?.frozenAtMs ?? 0) >= (snapshot.reasoning?.startedAtMs ?? 0)).toBe(
      true,
    );

    await bridge.stop();
  });

  it("restores frozen reasoning timestamp from snapshot", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_restore_reasoning_frozen";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        createdOutputRefs: [],
        visibleText: "already visible",
        reasoning: {
          startedAtMs: 10_000,
          frozenAtMs: 10_250,
          detailText: "**Summary**\nitem",
        },
        toolStatus: [],
      },
    ]);

    const reasoningUpdates =
      adapter.stream?.parts.filter((p) => p.type === "reasoning.status").map((p) => p.update) ?? [];
    expect(reasoningUpdates).toHaveLength(1);
    expect(reasoningUpdates[0]).toEqual({
      startedAtMs: 10_000,
      frozenAtMs: 10_250,
      detailText: "**Summary**\nitem",
    });

    await bridge.stop();
  });

  it("restores relay from snapshot with cursor resume and primed output", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapterA = new FakeAdapter();

    const requestId = "discord:chan:msg_restore";

    const bridgeA = await bridgeBusToAdapter({
      adapter: adapterA,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter-a",
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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "a" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "tool-2",
        status: "start",
        display: "grep x",
      },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const snapshot = bridgeA.snapshotRelays()[0]!;
    await bridgeA.stop();

    const adapterB = new FakeAdapter();
    const bridgeB = await bridgeBusToAdapter({
      adapter: adapterB,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter-b",
      idleTimeoutMs: 10_000,
    });

    await bridgeB.restoreRelays([snapshot]);

    expect(adapterB.starts).toHaveLength(1);
    expect(adapterB.starts[0]?.opts?.resume?.created).toEqual(snapshot.createdOutputRefs);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "b" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "ab" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapterB.stream?.parts[0]).toEqual({ type: "text.set", text: "a" });
    expect(
      adapterB.stream?.parts.some(
        (p) =>
          p.type === "tool.status" &&
          p.update.toolCallId === "tool-2" &&
          p.update.status === "start",
      ),
    ).toBe(true);
    expect(adapterB.stream?.parts.some((p) => p.type === "text.delta" && p.delta === "b")).toBe(
      true,
    );
    expect(adapterB.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "ab" });

    await bridgeB.stop();
  });

  it("keeps pre-restart visible text when resumed finalText is continuation-only", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_resume_suffix_only";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        createdOutputRefs: [
          {
            platform: "discord",
            channelId: "chan",
            messageId: "m_out_1",
          },
        ],
        visibleText: "a",
        totalTextChars: 1,
        toolStatus: [],
        outCursor: "10-0",
      },
    ]);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "b" },
      { headers: { request_id: requestId } },
    );

    // Resume run may only emit the continuation suffix.
    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "b" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts[0]).toEqual({ type: "text.set", text: "a" });
    expect(adapter.stream?.parts.some((p) => p.type === "text.delta" && p.delta === "b")).toBe(
      true,
    );
    expect(adapter.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "ab" });

    await bridge.stop();
  });

  it("deduplicates overlap when resumed finalText is suffix-only", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_resume_suffix_overlap";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        createdOutputRefs: [],
        visibleText: "abc",
        totalTextChars: 3,
        toolStatus: [],
      },
    ]);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "def" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "cdef!" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "abcdef!" });

    await bridge.stop();
  });

  it("appends non-overlapping suffix when resumed finalText is continuation-only", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_resume_suffix_non_overlap";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        createdOutputRefs: [],
        visibleText: "abc",
        totalTextChars: 3,
        toolStatus: [],
      },
    ]);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "def" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "XYZ" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "abcdefXYZ" });

    await bridge.stop();
  });

  it("keeps prefix slicing semantics after restored reanchor snapshots", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_restore_reanchor_prefix";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        createdOutputRefs: [],
        visibleText: "def",
        totalTextChars: 6,
        streamTextPrefixChars: 3,
        toolStatus: [],
      },
    ]);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "abcdefg" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "defg" });

    await bridge.stop();
  });

  it("keeps continuation suffix when restored prefix exceeds continuation finalText", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_restore_reanchor_continuation_suffix";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        createdOutputRefs: [],
        // Full text before restart was 6 chars of old lane + current lane "g".
        visibleText: "g",
        totalTextChars: 7,
        streamTextPrefixChars: 6,
        toolStatus: [],
      },
    ]);

    // Resume publisher emits continuation-only final text.
    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "!" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "g!" });

    await bridge.stop();
  });

  it("does not replay consumed out events after cursor restore", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapterA = new FakeAdapter();

    const requestId = "discord:chan:msg_restore_no_duplicate_out";

    const bridgeA = await bridgeBusToAdapter({
      adapter: adapterA,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter-a",
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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "a" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const snapshot = bridgeA.snapshotRelays()[0]!;
    await bridgeA.stop();

    const adapterB = new FakeAdapter();
    const bridgeB = await bridgeBusToAdapter({
      adapter: adapterB,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter-b",
      idleTimeoutMs: 10_000,
    });

    await bridgeB.restoreRelays([snapshot]);

    // No new deltas were published after restore; only final arrives.
    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "a" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    const replayedA =
      adapterB.stream?.parts.filter((p) => p.type === "text.delta" && p.delta === "a") ?? [];
    expect(replayedA).toHaveLength(0);
    expect(adapterB.stream?.parts.at(-1)).toEqual({ type: "text.set", text: "a" });

    await bridgeB.stop();
  });

  it("deletes restored preview-chain refs when resumed delivery is skip", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_restore_skip_deletes_refs";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        createdOutputRefs: [
          {
            platform: "discord",
            channelId: "chan",
            messageId: "m_old_1",
          },
          {
            platform: "discord",
            channelId: "chan",
            messageId: "m_old_2",
          },
        ],
        visibleText: "partial",
        totalTextChars: 7,
        toolStatus: [],
      },
    ]);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "ignored", delivery: "skip" },
      { headers: { request_id: requestId } },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.stream?.aborted).toBe("skip");
    expect(adapter.stream?.finished).toBe(false);
    expect(adapter.deletedMsgs.map((m) => m.messageId)).toEqual(["m_out_1", "m_old_2", "m_old_1"]);
    expect(bridge.snapshotRelays()).toHaveLength(0);

    await bridge.stop();
  });

  it("removes finished relay before blocking output subscription stop", async () => {
    const { raw, releaseTailStops } = createInMemoryRawBusWithBlockingTailStop();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_finish_blocking_tail_stop";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "hello" },
      { headers: { request_id: requestId } },
    );

    const publishFinal = bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "hello" },
      { headers: { request_id: requestId } },
    );

    const settled = await Promise.race([
      publishFinal.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 200);
      }),
    ]);

    expect(settled).toBe("resolved");
    expect(bridge.snapshotRelays()).toHaveLength(0);

    releaseTailStops();
    await bridge.stop();
  });

  it("uses resume metadata only for first restored startOutput", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_resume_once";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bridge.restoreRelays([
      {
        requestId,
        sessionId: "chan",
        requestClient: "discord",
        platform: "discord",
        routerSessionMode: "active",
        replyTo: {
          platform: "discord",
          channelId: "chan",
          messageId: "msg_resume_once",
        },
        createdOutputRefs: [
          {
            platform: "discord",
            channelId: "chan",
            messageId: "m_out_1",
          },
        ],
        visibleText: "partial",
        toolStatus: [],
        outCursor: "100-0",
      },
    ]);

    expect(adapter.starts).toHaveLength(1);
    expect(adapter.starts[0]?.opts?.resume?.created).toEqual([
      {
        platform: "discord",
        channelId: "chan",
        messageId: "m_out_1",
      },
    ]);

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      {
        inheritReplyTo: false,
        replyTo: {
          platform: "discord",
          channelId: "chan",
          messageId: "new_anchor",
        },
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(adapter.starts).toHaveLength(2);
    expect(adapter.starts[1]?.opts?.resume).toBeUndefined();
    expect(adapter.starts[1]?.opts?.replyTo).toEqual({
      platform: "discord",
      channelId: "chan",
      messageId: "new_anchor",
    });

    await bridge.stop();
  });
});
