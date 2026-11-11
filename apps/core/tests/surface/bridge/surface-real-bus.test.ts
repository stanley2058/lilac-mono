import { afterEach, describe, expect, it } from "bun:test";
import { Result } from "better-result";
import { z } from "zod";
import {
  lilacEventTypes,
  type LilacTopic,
  type DecodedLilacMessageForTopic,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceOutputPart,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import type { AdapterEvent } from "../../../src/surface/events";
import type { ContentOpts, MsgRef, SessionRef, SurfaceMessage } from "../../../src/surface/types";
import { bridgeAdapterToBus } from "../../../src/surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../../../src/surface/bridge/subscribe-from-bus";
import { projectAuthenticatedRequest } from "../../../src/surface/authenticated-request";
import { createDiscordRelayPolicy } from "../../../src/surface/discord/discord-runtime-descriptor";
import {
  adaptDiscordRequestRouterStartOutcomeToHost,
  startDiscordRequestRouter,
} from "../../../src/surface/discord/discord-request-router";
import {
  DiscordRequestDeliveryFailed,
  publishBusRequest,
  type DiscordRequestDeliveryPort,
} from "../../../src/surface/discord/discord-request-router/publish";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";
import { createTestResourceRegistry } from "../../helpers/resource-registry";
import { createRealCoreBusFixture, withBusDeadline as deadline } from "../../helpers/real-core-bus";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Fixture = Awaited<ReturnType<typeof createRealCoreBusFixture>>;

async function fixture() {
  const f = await createRealCoreBusFixture();
  cleanups.push(() => f.close());
  return f;
}

async function observe<T extends LilacTopic>(f: Fixture, topic: T, count: number) {
  const messages: DecodedLilacMessageForTopic<T>[] = [];
  const received = Promise.withResolvers<void>();
  const sub = (
    await f.bus.subscribeTopic(
      topic,
      {
        mode: "fanout",
        subscriptionId: crypto.randomUUID(),
        startFrom: "beginning",
      },
      async (message) => {
        messages.push(message);
        if (messages.length === count) received.resolve();
        return Result.ok(undefined);
      },
      () => "stop",
    )
  ).unwrap();
  cleanups.push(async () => {
    (await sub.stop()).unwrap();
  });
  return {
    messages,
    received: async () => {
      await deadline(received.promise, `${count} ${topic} events`);
      await Promise.all(messages.map((message) => f.waitForCommit(message.id, topic)));
    },
  };
}

function deliveryPort(f: Fixture): DiscordRequestDeliveryPort {
  return {
    async prepareAndPublish(input) {
      return (await f.coordinator.prepareAndPublish(input, f.publisher))
        .map(() => undefined)
        .mapError((cause) => new DiscordRequestDeliveryFailed({ cause, message: cause.message }));
    },
  };
}

class RecordingAdapter extends SurfaceAdapterTestBase {
  readonly handlers = new Set<AdapterEventHandler>();
  readonly messages = new Map<string, SurfaceMessage>();
  readonly parts: SurfaceOutputPart[] = [];
  readonly starts: Array<{ session: SessionRef; options?: StartOutputOpts }> = [];
  readonly finished = Promise.withResolvers<void>();
  readonly aborted = Promise.withResolvers<string | undefined>();
  readonly outputStarted = Promise.withResolvers<void>();
  readonly typingStopped = Promise.withResolvers<void>();

  async emit(event: AdapterEvent) {
    await Promise.all([...this.handlers].map((handler) => handler(event)));
  }
  async subscribe(handler: AdapterEventHandler) {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }
  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: "discord" as const, userId: "bot", userName: "lilac" };
  }
  async listSessions() {
    return Result.ok([]);
  }
  async startOutput(session: SessionRef, options?: StartOutputOpts) {
    this.starts.push({ session, options });
    const ref: MsgRef = { platform: "discord", channelId: session.channelId, messageId: "output" };
    let created = false;
    const stream: SurfaceOutputStream = {
      push: async (part) => {
        this.parts.push(part);
        if (!created) {
          created = true;
          options?.onMessageCreated?.(ref);
        }
        return Result.ok("visible");
      },
      finish: async () => {
        this.finished.resolve();
        return Result.ok({ created: [ref], last: ref });
      },
      abort: async (reason) => {
        this.aborted.resolve(reason);
        return Result.ok(undefined);
      },
      getFinalTextMode: () => "full",
    };
    this.outputStarted.resolve();
    return Result.ok(stream);
  }
  override async startTyping() {
    return Result.ok({
      stop: async () => {
        this.typingStopped.resolve();
        return Result.ok(undefined);
      },
    });
  }
  async sendMsg(session: SessionRef, _content: ContentOpts) {
    return Result.ok({
      platform: "discord" as const,
      channelId: session.channelId,
      messageId: "sent",
    });
  }
  async readMsg(ref: MsgRef) {
    return Result.ok(this.messages.get(ref.messageId) ?? null);
  }
  async listMsg() {
    return Result.ok([...this.messages.values()]);
  }
  async editMsg() {
    return Result.ok(undefined);
  }
  async deleteMsg() {
    return Result.ok(undefined);
  }
  async getReplyContext() {
    return Result.ok([...this.messages.values()]);
  }
  async addReaction() {
    return Result.ok(undefined);
  }
  async removeReaction() {
    return Result.ok(undefined);
  }
  async listReactions() {
    return Result.ok([]);
  }
  async getUnRead() {
    return Result.ok([]);
  }
  async markRead() {
    return Result.ok(undefined);
  }
}

async function ingress(f: Fixture, adapter: RecordingAdapter) {
  const bridge = await bridgeAdapterToBus({
    eventSource: adapter,
    platform: "discord",
    bus: f.bus,
    subscriptionId: "ingress",
  });
  cleanups.push(() => bridge.stop());
}

async function relay(f: Fixture, adapter: RecordingAdapter) {
  const bridge = await bridgeBusToAdapter({
    adapter,
    blobStore: f.blobs,
    bus: f.bus,
    platform: "discord",
    policy: createDiscordRelayPolicy(adapter),
    subscriptionId: "relay",
  });
  cleanups.push(async () => {
    await bridge.stop();
  });
}

function message(): SurfaceMessage {
  return {
    ref: { platform: "discord", channelId: "channel", messageId: "message" },
    session: { platform: "discord", channelId: "channel" },
    userId: "sender",
    text: "hello",
    ts: 1_700_000_000_000,
    raw: { discord: { isDMBased: true, mentionsBot: false, replyToBot: false, botUserId: "bot" } },
  };
}

describe("surface production contracts over Redis", () => {
  it("delivers adapter messages, edits, deletion, reactions and actions through the typed subscriber", async () => {
    const f = await fixture();
    const adapter = new RecordingAdapter();
    const observed = await observe(f, "evt.adapter", 6);
    await ingress(f, adapter);
    const m = message();
    const base = { platform: "discord" as const, ts: m.ts };
    const events: AdapterEvent[] = [
      { ...base, type: "adapter.message.created", message: m },
      { ...base, type: "adapter.message.updated", message: { ...m, text: "edited" } },
      { ...base, type: "adapter.message.deleted", messageRef: m.ref, session: m.session },
      {
        ...base,
        type: "adapter.reaction.added",
        messageRef: m.ref,
        session: m.session,
        reaction: "eyes",
        userId: "sender",
      },
      {
        ...base,
        type: "adapter.reaction.removed",
        messageRef: m.ref,
        session: m.session,
        reaction: "eyes",
        userId: "sender",
      },
      {
        ...base,
        type: "adapter.action.invoked",
        actionId: "approve",
        userId: "sender",
        messageRef: m.ref,
        sourceMessageId: "source",
      },
    ];
    for (const event of events) await adapter.emit(event);
    await observed.received();
    expect(observed.messages.map((event) => event.type)).toEqual([
      lilacEventTypes.EvtAdapterMessageCreated,
      lilacEventTypes.EvtAdapterMessageUpdated,
      lilacEventTypes.EvtAdapterMessageDeleted,
      lilacEventTypes.EvtAdapterReactionAdded,
      lilacEventTypes.EvtAdapterReactionRemoved,
      lilacEventTypes.EvtAdapterActionInvoked,
    ]);
    expect(observed.messages[0]?.data).toMatchObject({
      platform: "discord",
      channelId: "channel",
      messageId: "message",
      text: "hello",
      userId: "sender",
    });
    expect(observed.messages[1]?.data).toMatchObject({ text: "edited" });
    expect(observed.messages[5]?.data).toMatchObject({
      actionId: "approve",
      messageRef: m.ref,
      sourceMessageId: "source",
    });
  });

  it("publishes slash commands and both cancellation scopes with durable UUID identities", async () => {
    const f = await fixture();
    const adapter = new RecordingAdapter();
    const observed = await observe(f, "cmd.request", 3);
    await ingress(f, adapter);
    await adapter.emit({
      type: "adapter.command.invoked",
      platform: "discord",
      ts: 1_700_000_000_000,
      requestId: "discord:channel:command",
      sessionId: "channel",
      commandName: "review",
      args: ["main"],
      text: "review main",
      userId: "sender",
      sessionMode: "mention",
      sessionConfigId: "channel",
    });
    for (const cancelScope of ["active_only", "active_or_queued"] as const) {
      await adapter.emit({
        type: "adapter.request.cancel",
        platform: "discord",
        ts: 1_700_000_000_000,
        requestId: "discord:channel:command",
        sessionId: "channel",
        cancelScope,
        userId: "sender",
      });
    }
    await observed.received();
    expect(observed.messages.map((event) => event.data.queue)).toEqual([
      "prompt",
      "interrupt",
      "interrupt",
    ]);
    expect(new Set(observed.messages.map((event) => event.data.requestDeliveryId)).size).toBe(3);
    for (const event of observed.messages) {
      expect(z.uuid().safeParse(event.data.requestDeliveryId).success).toBe(true);
      expect(event.headers).toMatchObject({
        request_id: "discord:channel:command",
        session_id: "channel",
        request_client: "discord",
      });
      expect(f.store.load(event.data.requestDeliveryId).unwrap().publication?.streamId).toBe(
        event.id,
      );
    }
    expect(observed.messages[0]?.data.raw).toMatchObject({
      authenticatedActor: { platform: "discord", userId: "sender" },
      customCommand: { name: "review", args: ["main"] },
    });
    expect(observed.messages[1]?.data.raw).toMatchObject({
      cancel: true,
      cancelQueued: false,
      requiresActive: true,
    });
    expect(observed.messages[2]?.data.raw).toMatchObject({
      cancel: true,
      cancelQueued: true,
      requiresActive: false,
    });
  });

  it.each(["prompt", "followUp", "steer", "interrupt"] as const)(
    "preserves authenticated origin and lineage for prepared %s requests",
    async (queue) => {
      const f = await fixture();
      const observed = await observe(f, "cmd.request", 1);
      const origin = message();
      const requestDeliveryId = crypto.randomUUID();
      (
        await publishBusRequest({
          logger: new Logger({ module: "surface-real-bus" }),
          blobStore: f.blobs,
          requestDelivery: deliveryPort(f),
          input: {
            requestDeliveryId,
            requestId: "discord:channel:message",
            sessionId: "channel",
            sessionConfigId: "channel",
            queue,
            triggerType: "mention",
            sessionMode: "mention",
            messages: [{ role: "user", content: "hello" }],
            inputHandles: [],
            corePrimaryLineage: {
              state: "fresh-only",
              lineageVersion: 2,
              currentCanonicalStart: 0,
              reason: "test",
            },
            originMessage: origin,
            raw: {},
          },
        })
      ).unwrap();
      await observed.received();
      const delivered = observed.messages[0]!;
      expect(delivered.data).toMatchObject({
        requestDeliveryId,
        queue,
        corePrimaryLineage: { state: "fresh-only", lineageVersion: 2 },
      });
      expect(projectAuthenticatedRequest(delivered).unwrap()).toMatchObject({
        verifiedIngress: true,
        authenticatedOrigin: { userId: "sender" },
      });
      expect(f.store.load(requestDeliveryId).unwrap().publication?.streamId).toBe(delivered.id);
    },
  );

  it("routes an authenticated Discord message through adapter ingress and durable request admission", async () => {
    const f = await fixture();
    const adapter = new RecordingAdapter();
    const origin = message();
    adapter.messages.set(origin.ref.messageId, origin);
    const observed = await observe(f, "cmd.request", 1);
    const router = adaptDiscordRequestRouterStartOutcomeToHost(
      await startDiscordRequestRouter({
        adapter,
        bus: f.bus,
        blobStore: f.blobs,
        resourceRegistry: createTestResourceRegistry(),
        requestDelivery: deliveryPort(f),
        subscriptionId: "router",
        config: parseCoreConfigV1ToUniversal({}),
      }),
      () => {},
      () => {},
    );
    cleanups.push(async () => {
      await router.stop();
    });
    await ingress(f, adapter);
    await adapter.emit({
      type: "adapter.message.created",
      platform: "discord",
      ts: origin.ts,
      message: origin,
    });
    await observed.received();
    const delivered = observed.messages[0]!;
    expect(delivered.headers).toMatchObject({
      request_id: "discord:channel:message",
      session_id: "channel",
      request_client: "discord",
    });
    expect(delivered.data.queue).toBe("prompt");
    expect(JSON.stringify(delivered.data.messages)).toContain("hello");
    expect(projectAuthenticatedRequest(delivered).unwrap()).toMatchObject({
      verifiedIngress: true,
      authenticatedOrigin: { userId: "sender" },
    });
  });

  it("replays output published before relay attachment and publishes the resulting surface message", async () => {
    const f = await fixture();
    const adapter = new RecordingAdapter();
    const headers = {
      request_id: "discord:channel:message",
      session_id: "channel",
      request_client: "discord",
    } as const;
    const outputs = await observe(f, "evt.surface", 1);
    await relay(f, adapter);
    const upload = (
      await f.blobs.startUpload({
        source: new TextEncoder().encode("verified output"),
        retention: { kind: "durable" },
      })
    ).unwrap();
    (await upload.completion).unwrap();
    (
      await f.bus.publish(
        lilacEventTypes.EvtAgentOutputDeltaText,
        { delta: "draft", phase: "commentary" },
        { headers },
      )
    ).unwrap();
    (
      await f.bus.publish(
        lilacEventTypes.EvtAgentOutputTextReset,
        { text: "retained" },
        { headers },
      )
    ).unwrap();
    (
      await f.bus.publish(
        lilacEventTypes.EvtAgentOutputToolCall,
        { toolCallId: "tool", status: "end", display: "read file", ok: true },
        { headers },
      )
    ).unwrap();
    (
      await f.bus.publish(
        lilacEventTypes.EvtAgentOutputResponseBinary,
        { blob: upload.handle, mimeType: "text/plain", filename: "output.txt" },
        { headers },
      )
    ).unwrap();
    (
      await f.bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: "final answer" },
        { headers },
      )
    ).unwrap();
    (await f.bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers })).unwrap();
    await deadline(adapter.finished.promise, "relay completion");
    await outputs.received();
    expect(adapter.parts).toContainEqual(
      expect.objectContaining({ type: "text.set", text: "final answer" }),
    );
    expect(adapter.parts).toContainEqual({
      type: "tool.status",
      update: { toolCallId: "tool", status: "end", display: "read file", ok: true },
    });
    const attachment = adapter.parts.find((part) => part.type === "attachment.add");
    expect(attachment?.attachment.filename).toBe("output.txt");
    expect(new TextDecoder().decode(attachment?.attachment.bytes)).toBe("verified output");
    expect(adapter.starts[0]).toMatchObject({
      session: { platform: "discord", channelId: "channel" },
      options: { requestId: headers.request_id },
    });
    expect(outputs.messages[0]).toMatchObject({
      type: lilacEventTypes.EvtSurfaceOutputMessageCreated,
      headers,
      data: { msgRef: { platform: "discord", channelId: "channel", messageId: "output" } },
    });
    await deadline(adapter.typingStopped.promise, "typing cleanup");
  });

  it("reanchors through cmd.surface and handles terminal lifecycle before final output", async () => {
    const f = await fixture();
    const adapter = new RecordingAdapter();
    await relay(f, adapter);
    const headers = {
      request_id: "discord:channel:message",
      session_id: "channel",
      request_client: "discord",
    } as const;
    const reply = (await f.bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers })).unwrap();
    await f.waitForCommit(reply.cursor, "evt.request");
    const target = { platform: "discord" as const, channelId: "channel", messageId: "new-anchor" };
    const reanchor = (
      await f.bus.publish(
        lilacEventTypes.CmdSurfaceOutputReanchor,
        { inheritReplyTo: false, replyTo: target, mode: "interrupt" },
        { headers },
      )
    ).unwrap();
    await f.waitForCommit(reanchor.cursor, "cmd.surface");
    expect(await deadline(adapter.aborted.promise, "reanchor abort")).toBe("reanchor_interrupt");
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.starts[1]?.options?.replyTo).toEqual(target);
    const lifecycle = (
      await f.bus.publish(
        lilacEventTypes.EvtRequestLifecycleChanged,
        { state: "failed", detail: "model unavailable" },
        { headers },
      )
    ).unwrap();
    await f.waitForCommit(lifecycle.cursor, "evt.request");
    await deadline(adapter.typingStopped.promise, "terminal typing cleanup");
    (
      await f.bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: "Error: model unavailable" },
        { headers },
      )
    ).unwrap();
    await deadline(adapter.finished.promise, "failure output");
    expect(adapter.parts).toContainEqual(
      expect.objectContaining({ type: "text.set", text: "Error: model unavailable" }),
    );
  });

  it("delivers an ingress cancellation to an active output relay", async () => {
    const f = await fixture();
    const adapter = new RecordingAdapter();
    await relay(f, adapter);
    await ingress(f, adapter);
    const headers = {
      request_id: "discord:channel:message",
      session_id: "channel",
      request_client: "discord",
    } as const;
    (await f.bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers })).unwrap();
    await deadline(adapter.outputStarted.promise, "output start");
    await adapter.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: headers.request_id,
      sessionId: "channel",
    });
    expect(await deadline(adapter.aborted.promise, "relay cancellation")).toBe("cancel");
  });
});
