import { describe, expect, it, spyOn } from "bun:test";
import { Panic, Result } from "better-result";

import {
  adaptSurfaceOperationToRelay,
  bridgeBusToAdapter as bridgeBusToAdapterImpl,
  BusToAdapterEffectFailed,
  captureBusToAdapterEffect,
  logIngressAcknowledgementCleanupFailure,
  mergeContinuationText,
} from "../../../src/surface/bridge/subscribe-from-bus";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfaceOperationPartiallyCompleted,
  SurfaceOperationUnsupported,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  type SurfaceOperationError,
} from "../../../src/surface/adapter";
import type {
  SurfaceFinalTextMode,
  SurfaceOperationResult,
  SurfaceOutputPart,
  SurfaceOutputPartDisposition,
  SurfaceOutputResult,
  StartOutputOpts,
} from "../../../src/surface/adapter";
import type {
  ContentOpts,
  LimitOpts,
  SendOpts,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";
import type { MsgRef, SessionRef } from "../../../src/surface/types";
import { createDiscordRelayPolicy } from "../../../src/surface/discord/discord-runtime-descriptor";
import { createGithubRelayPolicy } from "../../../src/surface/github/github-runtime-descriptor";
import { SurfaceIngressAcknowledgementCleanupFailed } from "../../../src/surface/runtime-descriptor";

import {
  createMemoryBlobStore,
  type BlobHandleV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { createLilacBus, lilacEventTypes } from "@stanley2058/lilac-event-bus";
import {
  clearGithubAck,
  getGithubAck,
  setGithubAck,
  setGithubLatestRequestForSession,
  type GithubAckState,
} from "../../../src/github/github-state";
import {
  TranscriptStoreSqliteDriverFailure,
  type TranscriptStore,
} from "../../../src/transcript/transcript-store";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";
import {
  createInMemoryDeliveryBus as createInMemoryRawBus,
  type DeliveryObservation,
} from "../../helpers/in-memory-delivery-bus";

class FakeOutputStream {
  public readonly parts: SurfaceOutputPart[] = [];
  public readonly hydratedParts: SurfaceOutputPart[] = [];
  public finished = false;
  public aborted: string | undefined;
  public nextPushFailure: Error | null = null;
  public nextAbortFailure: Error | null = null;
  public finishResult: SurfaceOutputResult | null = null;
  private created = false;

  constructor(
    private readonly onFirstPush?: () => void,
    private readonly finalTextMode: SurfaceFinalTextMode = "continuation",
    private readonly platform: "discord" | "github" | "native" = "discord",
    private readonly terminalPartTypes: ReadonlySet<SurfaceOutputPart["type"]> = new Set(),
  ) {}

  hydrateRecovery(parts: readonly SurfaceOutputPart[]): SurfaceOutputPartDisposition {
    this.hydratedParts.push(...parts);
    if (parts.some((part) => part.type === "text.delta" || part.type === "text.set")) {
      return "visible";
    }
    if (
      this.platform === "github" &&
      parts.some((part) => part.type === "tool.status" || part.type === "attachment.add")
    ) {
      return "terminal";
    }
    return this.platform === "discord" && parts.length > 0 ? "visible" : "ignored";
  }

  async push(
    part: SurfaceOutputPart,
  ): Promise<SurfaceOperationResult<SurfaceOutputPartDisposition>> {
    if (this.nextPushFailure) {
      const failure = this.nextPushFailure;
      this.nextPushFailure = null;
      if (Panic.is(failure)) throw failure;
      return Result.err(
        new SurfaceUnavailable({
          platform: this.platform,
          operation: "push-output",
          message: failure.message,
        }),
      );
    }
    if (!this.created) {
      this.created = true;
      this.onFirstPush?.();
    }
    this.parts.push(part);
    if (this.terminalPartTypes.has(part.type)) return Result.ok("terminal");
    if (this.platform === "github" && part.type !== "text.delta" && part.type !== "text.set") {
      if (part.type === "tool.status" || part.type === "attachment.add") {
        return Result.ok("terminal");
      }
      return Result.ok("ignored");
    }
    return Result.ok("visible");
  }

  async finish(): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    this.finished = true;
    if (this.finishResult) return Result.ok(this.finishResult);
    const last: MsgRef = { platform: "discord", channelId: "chan", messageId: "m_out" };
    return Result.ok({ created: [last], last });
  }

  async abort(reason?: string): Promise<SurfaceOperationResult<void>> {
    if (this.nextAbortFailure) {
      const failure = this.nextAbortFailure;
      this.nextAbortFailure = null;
      if (Panic.is(failure)) throw failure;
      return Result.err(
        new SurfaceUnavailable({
          platform: this.platform,
          operation: "abort-output",
          message: failure.message,
        }),
      );
    }
    this.aborted = reason;
    return Result.ok(undefined);
  }

  getFinalTextMode(): SurfaceFinalTextMode {
    return this.finalTextMode;
  }
}

class FakeAdapter extends SurfaceAdapterTestBase {
  public lastStart: { sessionRef: SessionRef; opts?: StartOutputOpts } | null = null;
  public stream: FakeOutputStream | null = null;
  public starts: Array<{ sessionRef: SessionRef; opts?: StartOutputOpts }> = [];
  public streams: FakeOutputStream[] = [];
  public typingStarts: SessionRef[] = [];
  public typingStops = 0;
  public deletedMsgs: MsgRef[] = [];
  public outputFinalTextMode: SurfaceFinalTextMode = "continuation";
  public outputFinalTextModesByStart: SurfaceFinalTextMode[] = [];
  public terminalPartTypes = new Set<SurfaceOutputPart["type"]>();
  public failNextStart = false;
  public nextStreamPushFailure: Error | null = null;
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
  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    throw new Error("not implemented");
  }

  async startOutput(sessionRef: SessionRef, opts?: StartOutputOpts) {
    if (this.failNextStart) {
      this.failNextStart = false;
      return Result.err(
        new SurfaceUnavailable({
          platform: sessionRef.platform,
          operation: "start-output",
          message: "forced output start failure",
        }),
      );
    }
    this.lastStart = { sessionRef, opts };
    this.starts.push({ sessionRef, opts });
    const outputMessageId = `m_out_${this.nextOutputMessageId++}`;
    const mode = this.outputFinalTextModesByStart.shift() ?? this.outputFinalTextMode;
    const s = new FakeOutputStream(
      () => {
        if (sessionRef.platform !== "discord") return;
        opts?.onMessageCreated?.({
          platform: "discord",
          channelId: sessionRef.channelId,
          messageId: outputMessageId,
        });
      },
      mode,
      sessionRef.platform,
      this.terminalPartTypes,
    );
    this.stream = s;
    this.streams.push(s);
    s.nextPushFailure = this.nextStreamPushFailure;
    this.nextStreamPushFailure = null;
    return Result.ok(s);
  }

  override async startTyping(sessionRef: SessionRef) {
    this.typingStarts.push(sessionRef);
    return Result.ok({
      stop: async () => {
        this.typingStops += 1;
        return Result.ok(undefined);
      },
    });
  }

  async sendMsg(
    _sessionRef: SessionRef,
    _content: ContentOpts,
    _opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    throw new Error("not implemented");
  }
  async readMsg(_msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    throw new Error("not implemented");
  }
  async listMsg(
    _sessionRef: SessionRef,
    _opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    throw new Error("not implemented");
  }
  async editMsg(_msgRef: MsgRef, _content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    throw new Error("not implemented");
  }
  async deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
    this.deletedMsgs.push(msgRef);
    return Result.ok(undefined);
  }
  async getReplyContext(
    _msgRef: MsgRef,
    _opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    throw new Error("not implemented");
  }

  async addReaction(_msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
    throw new Error("not implemented");
  }
  async removeReaction(_msgRef: MsgRef, _reaction: string): Promise<SurfaceOperationResult<void>> {
    throw new Error("not implemented");
  }
  async listReactions(_msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    throw new Error("not implemented");
  }

  async subscribe(): Promise<{ stop(): Promise<void> }> {
    throw new Error("not implemented");
  }

  async getUnRead(_sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    throw new Error("not implemented");
  }
  async markRead(
    _sessionRef: SessionRef,
    _upToMsgRef?: MsgRef,
  ): Promise<SurfaceOperationResult<void>> {
    throw new Error("not implemented");
  }
}

async function bridgeBusToAdapter(
  params: Omit<Parameters<typeof bridgeBusToAdapterImpl>[0], "policy" | "blobStore"> & {
    readonly blobStore?: BlobStore;
  },
) {
  const blobStore = params.blobStore ?? (await defaultBlobStore());
  if (params.platform === "discord") {
    return bridgeBusToAdapterImpl({
      ...params,
      blobStore,
      platform: "discord",
      policy: createDiscordRelayPolicy(params.adapter),
    });
  }
  return bridgeBusToAdapterImpl({
    ...params,
    blobStore,
    platform: "github",
    policy: createGithubRelayPolicy(),
  });
}

let sharedBlobStore: BlobStore | undefined;

async function defaultBlobStore(): Promise<BlobStore> {
  if (sharedBlobStore) return sharedBlobStore;
  const created = await createMemoryBlobStore();
  sharedBlobStore = created.match({
    ok: (store) => store,
    err: (error) => {
      throw error;
    },
  });
  return sharedBlobStore;
}

async function uploadTestBlob(bytes: Uint8Array): Promise<BlobHandleV1> {
  const started = await (
    await defaultBlobStore()
  ).startUpload({
    source: bytes,
    retention: { kind: "durable" },
  });
  const upload = started.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
  (await upload.completion).match({
    ok: () => undefined,
    err: (error) => {
      throw error;
    },
  });
  return upload.handle;
}

function relayFailure(error: SurfaceOperationError): BusToAdapterEffectFailed {
  try {
    adaptSurfaceOperationToRelay("push-output", Result.err(error));
    throw new Error("expected relay adaptation failure");
  } catch (cause) {
    expect(cause).toBeInstanceOf(BusToAdapterEffectFailed);
    if (!(cause instanceof BusToAdapterEffectFailed)) throw cause;
    return cause;
  }
}

describe("mergeContinuationText", () => {
  it("drops only the longest replayed overlap", () => {
    expect(mergeContinuationText("hello wor", "world")).toBe("hello world");
    expect(mergeContinuationText("abab", "ababc")).toBe("ababc");
    expect(mergeContinuationText("aaab", "abaa")).toBe("aaabaa");
    expect(mergeContinuationText("first", "second")).toBe("firstsecond");
    expect(mergeContinuationText("", "next")).toBe("next");
    expect(mergeContinuationText("kept", "")).toBe("kept");
  });

  it("merges long repeated continuations at the longest overlap", () => {
    const replayed = "a".repeat(200_000);
    expect(mergeContinuationText(`${replayed}b`, replayed)).toBe(`${replayed}b${replayed}`);
    expect(mergeContinuationText(replayed, `${replayed.slice(1)}c`)).toBe(`${replayed}c`);
  });
});

describe("surface operation relay adaptation", () => {
  it.each([
    new SurfaceOperationUnsupported({
      platform: "discord",
      operation: "push-output",
      message: "unsupported secret=hidden",
    }),
    new SurfacePlatformMismatch({
      operation: "push-output",
      refRole: "sessionRef",
      expectedPlatform: "discord",
      receivedPlatform: "github",
      message: "platform mismatch secret=hidden",
    }),
    new SurfaceSessionMismatch({
      operation: "push-output",
      refRole: "replyTo",
      expectedSessionId: "expected",
      receivedSessionId: "received",
      message: "session mismatch secret=hidden",
    }),
    new SurfaceInvalidInput({
      platform: "discord",
      operation: "push-output",
      field: "content",
      message: "invalid secret=hidden",
    }),
    new SurfaceMessageNotFound({
      platform: "discord",
      operation: "push-output",
      message: "missing secret=hidden",
    }),
    new SurfacePermissionDenied({
      platform: "discord",
      operation: "push-output",
      message: "forbidden secret=hidden",
    }),
  ])("classifies $error._tag as a safe permanent failure", (error) => {
    const failure = relayFailure(error);

    expect(failure).toMatchObject({
      operation: "push-output",
      failureKind: "permanent",
      surfaceErrorTag: error._tag,
      created: null,
      cause: { errorTag: error._tag },
    });
    expect(JSON.stringify(failure)).not.toContain("secret=hidden");
  });

  it.each([
    new SurfaceRateLimited({
      platform: "discord",
      operation: "push-output",
      retryAfterMs: 2500,
      message: "rate limited secret=hidden",
    }),
    new SurfaceUnavailable({
      platform: "discord",
      operation: "push-output",
      message: "unavailable secret=hidden",
    }),
  ])("classifies $error._tag as a safe transient failure", (error) => {
    const failure = relayFailure(error);

    expect(failure).toMatchObject({
      operation: "push-output",
      failureKind: "transient",
      surfaceErrorTag: error._tag,
      created: null,
      cause: { errorTag: error._tag },
    });
    expect(JSON.stringify(failure)).not.toContain("secret=hidden");
  });

  it("preserves partial-completion context without exposing the provider message", () => {
    const created = { platform: "discord" as const, channelId: "channel", messageId: "message" };
    const failure = relayFailure(
      new SurfaceOperationPartiallyCompleted({
        platform: "discord",
        operation: "push-output",
        created,
        message: "partial secret=hidden",
      }),
    );

    expect(failure).toMatchObject({
      operation: "push-output",
      failureKind: "partial-completion",
      surfaceErrorTag: "SurfaceOperationPartiallyCompleted",
      created,
      cause: { errorTag: "SurfaceOperationPartiallyCompleted" },
    });
    expect(JSON.stringify(failure)).not.toContain("secret=hidden");
  });

  it("does not wrap Panic from relay effects", async () => {
    const panic = new Panic({ message: "relay invariant" });
    await expect(
      captureBusToAdapterEffect("push-output", async () => {
        throw panic;
      }),
    ).rejects.toBe(panic);
  });
});

describe("bridgeBusToAdapter", () => {
  it("keeps an idle relay alive with invisible agent activity", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_activity";
    const scheduled: Array<{ active: boolean; callback: () => void }> = [];

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 60,
      scheduleIdleTimeout: (callback) => {
        const timeout = { active: true, callback };
        scheduled.push(timeout);
        return () => {
          timeout.active = false;
        };
      },
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
      lilacEventTypes.EvtAgentOutputActivity,
      { source: "model" },
      { headers: { request_id: requestId } },
    );
    const originalTimeout = scheduled.shift();
    if (!originalTimeout) throw new Error("relay did not schedule its initial idle timeout");
    if (originalTimeout.active) originalTimeout.callback();

    expect(adapter.stream?.aborted).toBeUndefined();
    expect(adapter.stream?.parts).toEqual([]);

    const refreshedTimeout = scheduled.shift();
    if (!refreshedTimeout) throw new Error("activity did not refresh the relay idle timeout");
    if (refreshedTimeout.active) refreshedTimeout.callback();
    expect(adapter.stream?.aborted).toBe("timeout");

    await bridge.stop();
  });

  it("starts an output relay on evt.request.reply and streams output parts", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_1";

    // Pre-publish output before the reply event to ensure offset: begin catches it.
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "hello" },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
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

    expect(adapter.lastStart?.sessionRef).toEqual({ platform: "discord", channelId: "chan" });
    expect(adapter.lastStart?.opts?.requestId).toBe(requestId);
    expect(adapter.lastStart?.opts?.replyTo).toEqual({
      platform: "discord",
      channelId: "chan",
      messageId: "msg_1",
    });
    expect(adapter.lastStart?.opts?.requestStartedAtMs).toBeTypeOf("number");

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

  it("reuses the latest durable output ref and links a created message before terminal output", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_recovery_stream";
    const recoveredRef: MsgRef = {
      platform: "discord",
      channelId: "chan",
      messageId: "m_before_crash",
    };
    const linked: MsgRef[] = [];
    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest(input) {
        linked.push(...input.created);
      },
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      listSurfaceMessagesForRequest() {
        return [recoveredRef];
      },
      close() {},
    };
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
      transcriptStore,
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

    expect(adapter.lastStart?.opts?.resumeAt).toEqual(recoveredRef);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "continued" },
      { headers: { request_id: requestId } },
    );

    expect(linked).toEqual([{ platform: "discord", channelId: "chan", messageId: "m_out_1" }]);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "continued" },
      { headers: { request_id: requestId } },
    );
    await bridge.stop();
  });

  it("unlinks a transient output ref that finish replaces with a final message", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_preview_recovery";
    const linked: MsgRef[] = [];
    const unlinked: Array<{ platform: string; channelId: string; messageId: string }> = [];
    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest(input) {
        linked.push(...input.created);
      },
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      listSurfaceMessagesForRequest() {
        return [];
      },
      unlinkSurfaceMessage(input) {
        unlinked.push(input);
        return Result.ok({ requestId, checkpointDeleted: false });
      },
      close() {},
    };
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
      transcriptStore,
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
      { delta: "preview" },
      { headers: { request_id: requestId } },
    );
    const finalRef: MsgRef = {
      platform: "discord",
      channelId: "chan",
      messageId: "m_final",
    };
    if (!adapter.stream) throw new Error("relay did not start an output stream");
    adapter.stream.finishResult = { created: [finalRef], last: finalRef };

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "final" },
      { headers: { request_id: requestId } },
    );

    expect(unlinked).toEqual([{ platform: "discord", channelId: "chan", messageId: "m_out_1" }]);
    expect(linked).toEqual([
      { platform: "discord", channelId: "chan", messageId: "m_out_1" },
      finalRef,
    ]);
    await bridge.stop();
  });

  it.each([
    ["discord:chan", "malformed"],
    ["github:octo/repo#1:10", "cross-platform"],
    ["discord:other:message", "cross-session"],
  ] as const)(
    "dead-letters an invalid initial %s target instead of starting top-level",
    async (requestId) => {
      const deliveries: DeliveryObservation[] = [];
      const bus = createLilacBus(createInMemoryRawBus((delivery) => deliveries.push(delivery)));
      const adapter = new FakeAdapter();
      const bridge = await bridgeBusToAdapter({
        adapter,
        bus,
        platform: "discord",
        subscriptionId: `invalid-initial-${crypto.randomUUID()}`,
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

      expect(adapter.streams).toHaveLength(0);
      expect(deliveries.at(-1)?.disposition).toBe("dead-letter");
      await bridge.stop();
    },
  );

  it.each([
    { platform: "github" as const, channelId: "chan", messageId: "other-platform" },
    { platform: "discord" as const, channelId: "other", messageId: "other-session" },
  ])(
    "commits invalid reanchor target $messageId without switching output lanes",
    async (replyTo) => {
      const deliveries: DeliveryObservation[] = [];
      const bus = createLilacBus(createInMemoryRawBus((delivery) => deliveries.push(delivery)));
      const adapter = new FakeAdapter();
      const requestId = `discord:chan:${crypto.randomUUID()}`;
      const bridge = await bridgeBusToAdapter({
        adapter,
        bus,
        platform: "discord",
        subscriptionId: `invalid-reanchor-${crypto.randomUUID()}`,
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
        { inheritReplyTo: false, replyTo },
        {
          headers: {
            request_id: requestId,
            session_id: "chan",
            request_client: "discord",
          },
        },
      );

      expect(adapter.streams).toHaveLength(1);
      expect(adapter.streams[0]?.aborted).toBeUndefined();
      expect(deliveries.at(-1)?.disposition).toBe("commit");
      await bridge.stop();
    },
  );

  it("pushes normalized optional presentation parts to the GitHub output stream", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const sessionId = `octo/optional-${crypto.randomUUID()}#1`;
    const requestId = `github:${sessionId}:10`;
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "github",
      subscriptionId: `github-optional-${crypto.randomUUID()}`,
      idleTimeoutMs: 10_000,
    });

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: {
          request_id: requestId,
          session_id: sessionId,
          request_client: "github",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "thinking", seq: 1 },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "tool", status: "start", display: "bash pwd" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseBinary,
      {
        blob: await uploadTestBlob(new TextEncoder().encode("hi")),
        mimeType: "text/plain",
        filename: "result.txt",
      },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "finished", statsForNerdsLine: "stats" },
      { headers: { request_id: requestId } },
    );

    expect(adapter.stream?.parts.map((part) => part.type)).toEqual([
      "reasoning.status",
      "tool.status",
      "attachment.add",
      "meta.stats",
      "text.set",
    ]);
    await bridge.stop();
  });

  it("fully verifies a generated blob before pushing a Discord attachment", async () => {
    const created = await createMemoryBlobStore();
    const blobStore = created.match({
      ok: (store) => store,
      err: (error) => {
        throw error;
      },
    });
    const sourceController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const uploadStarted = await blobStore.startUpload({
      source: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("verified output"));
          sourceController.resolve(controller);
        },
      }),
      retention: { kind: "durable" },
    });
    const controlledSource = await sourceController.promise;
    const upload = uploadStarted.match({
      ok: (value) => value,
      err: (error) => {
        throw error;
      },
    });
    const resolveStarted = Promise.withResolvers<{ readonly timeoutMs: number }>();
    const observedBlobStore = new Proxy(blobStore, {
      get(target, property, receiver) {
        if (property === "resolve") {
          return (
            handle: Parameters<BlobStore["resolve"]>[0],
            options: Parameters<BlobStore["resolve"]>[1],
          ) => {
            resolveStarted.resolve(options);
            return target.resolve(handle, options);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = `discord:chan:${crypto.randomUUID()}`;
    const bridge = await bridgeBusToAdapter({
      adapter,
      blobStore: observedBlobStore,
      bus,
      platform: "discord",
      subscriptionId: `discord-verified-output-${crypto.randomUUID()}`,
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
    const publishing = bus.publish(
      lilacEventTypes.EvtAgentOutputResponseBinary,
      { blob: upload.handle, mimeType: "text/plain", filename: "verified.txt" },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    expect(await resolveStarted.promise).toEqual({ timeoutMs: 60_000 });
    expect(adapter.stream?.parts).toEqual([]);

    controlledSource.close();
    await publishing;
    const attachmentPart = adapter.stream?.parts.find((part) => part.type === "attachment.add");
    expect(attachmentPart?.type).toBe("attachment.add");
    if (attachmentPart?.type === "attachment.add") {
      expect(attachmentPart.attachment.filename).toBe("verified.txt");
      expect(new TextDecoder().decode(attachmentPart.attachment.bytes)).toBe("verified output");
    }

    await bridge.stop();
    await blobStore.close({ deadlineAtMs: Date.now() + 1_000 });
  });

  it("preserves rich subagent trees and terminal status across delayed updates and reanchor", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_subagent_tree";
    const headers = {
      request_id: requestId,
      session_id: "chan",
      request_client: "discord" as const,
    };
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bus.publish(lilacEventTypes.EvtRequestReply, {}, { headers });
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "agent-2",
        status: "update",
        display: "subagent (general; 0/1 done)\n`- > bash bun test",
      },
      { headers },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "agent-1",
        status: "update",
        display:
          "subagent (explore; gpt-5.6-sol [high]; 1/2 done)\n|- > read_file a.ts\n`- + grep auth",
      },
      { headers },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "agent-1",
        status: "end",
        display: "subagent (explore; resolved)",
        ok: true,
      },
      { headers },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "agent-1",
        status: "update",
        display:
          "subagent (explore; gpt-5.6-sol [high]; 2/2 done)\n|- + read_file a.ts\n`- + grep auth",
      },
      { headers },
    );

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      { inheritReplyTo: true },
      { headers },
    );
    const canonical = {
      toolCallId: "agent-2",
      status: "update" as const,
      display: "subagent (general; 0/1 done)\n`- > bash bun test",
      ok: undefined,
      error: undefined,
    };
    const canonicalAgentOne = {
      toolCallId: "agent-1",
      status: "end" as const,
      display:
        "subagent (explore; gpt-5.6-sol [high]; 2/2 done)\n|- + read_file a.ts\n`- + grep auth",
      ok: true,
      error: undefined,
    };
    expect(adapter.streams).toHaveLength(2);
    expect(adapter.streams[1]?.parts[0]).toEqual({
      type: "tool.status",
      update: canonical,
    });
    expect(adapter.streams[1]?.parts[1]).toEqual({
      type: "tool.status",
      update: canonicalAgentOne,
    });

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

    expect(adapter.starts.length).toBe(2);
    expect(adapter.starts[0]?.opts?.replyTo?.messageId).toBe("msg_3");
    expect(adapter.starts[1]?.opts?.replyTo?.messageId).toBe("msg_3");
    expect(adapter.starts[0]?.opts?.requestStartedAtMs).toBeTypeOf("number");
    expect(adapter.starts[1]?.opts?.requestStartedAtMs).toBe(
      adapter.starts[0]?.opts?.requestStartedAtMs,
    );

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

  it("defers OpenAI phase splitting until terminal finalization", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_phase_split";
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
      { delta: "NO_", phase: "commentary" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "call-1", status: "start", display: "read_file" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "call-1", status: "end", display: "read_file", ok: true },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: " ", phase: "final_answer" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "\n\nFinal answer.",
        phase: "final_answer",
        phaseBoundaryPrefixChars: 2,
      },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "NO_ \n\nFinal answer." },
      { headers: { request_id: requestId } },
    );

    expect(adapter.streams).toHaveLength(1);
    expect(adapter.streams[0]?.aborted).toBeUndefined();
    expect(adapter.streams[0]?.parts).toEqual([
      {
        type: "tool.status",
        update: {
          toolCallId: "call-1",
          status: "start",
          display: "read_file",
          ok: undefined,
          error: undefined,
        },
      },
      {
        type: "tool.status",
        update: {
          toolCallId: "call-1",
          status: "end",
          display: "read_file",
          ok: true,
          error: undefined,
        },
      },
      { type: "text.delta", delta: "NO_ ", phase: "final_answer" },
      { type: "text.delta", delta: "\n\nFinal answer.", phase: "final_answer" },
      {
        type: "text.set",
        text: "NO_ \n\nFinal answer.",
        phase: "final_answer",
        finalSegments: ["NO_", " Final answer."],
      },
    ]);
    expect(adapter.streams[0]?.finished).toBe(true);

    await bridge.stop();
  });

  it("restores retained commentary phase before a later final answer", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_phase_reset";
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
      { delta: "Retained commentary.", phase: "commentary" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "Transient commentary.", phase: "commentary" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputTextReset,
      { text: "Retained commentary.", phase: "commentary" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: " ", phase: "final_answer" },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      {
        delta: "\n\nVisible final answer.",
        phase: "final_answer",
        phaseBoundaryPrefixChars: 2,
      },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputTextReset,
      {
        text: "Retained commentary. \n\nVisible final answer.",
        phase: "final_answer",
      },
      { headers: { request_id: requestId } },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "Retained commentary. \n\nVisible final answer." },
      { headers: { request_id: requestId } },
    );

    expect(adapter.streams).toHaveLength(1);
    expect(adapter.streams[0]?.parts).toEqual([
      { type: "text.delta", delta: "Retained commentary.", phase: "commentary" },
      { type: "text.delta", delta: "Transient commentary.", phase: "commentary" },
      { type: "text.set", text: "Retained commentary.", phase: "commentary" },
      { type: "text.delta", delta: " \n\nVisible final answer.", phase: "final_answer" },
      {
        type: "text.set",
        text: "Retained commentary. \n\nVisible final answer.",
        phase: "final_answer",
      },
      {
        type: "text.set",
        text: "Retained commentary. \n\nVisible final answer.",
        phase: "final_answer",
        finalSegments: ["Retained commentary.", " Visible final answer."],
      },
    ]);
    expect(adapter.streams[0]?.finished).toBe(true);
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

    expect(adapter.streams.length).toBe(2);
    expect(adapter.streams[0]?.aborted).toBe("reanchor_interrupt");

    await bridge.stop();
  });

  it("uses full final text mode across multiple reanchors", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();
    adapter.outputFinalTextMode = "full";

    const requestId = "discord:chan:msg_reanchor_preview_full_final";

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
      { delta: "c" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "abc" },
      { headers: { request_id: requestId } },
    );

    expect(adapter.streams).toHaveLength(3);
    expect(adapter.streams[0]?.aborted).toBe("reanchor");
    expect(adapter.streams[1]?.aborted).toBe("reanchor");
    expect(adapter.streams[2]?.parts.at(-1)).toEqual({ type: "text.set", text: "c" });

    await bridge.stop();
  });

  it("keeps full final text behavior in full mode without reanchor", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();
    adapter.outputFinalTextMode = "full";

    const requestId = "discord:chan:msg_full_mode_no_reanchor";

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
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "b" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "ab" },
      { headers: { request_id: requestId } },
    );

    expect(adapter.streams).toHaveLength(1);
    expect(adapter.streams[0]?.parts.at(-1)).toEqual({ type: "text.set", text: "ab" });

    await bridge.stop();
  });

  it("keeps continuation slicing across multiple reanchors in inline mode", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_reanchor_inline_continuation";

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
      { delta: "c" },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "abc" },
      { headers: { request_id: requestId } },
    );

    expect(adapter.streams).toHaveLength(3);
    expect(adapter.streams[0]?.aborted).toBe("reanchor");
    expect(adapter.streams[1]?.aborted).toBe("reanchor");
    expect(adapter.streams[2]?.parts.at(-1)).toEqual({ type: "text.set", text: "c" });

    await bridge.stop();
  });

  it("refreshes final text mode when reanchor starts a new stream", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();
    adapter.outputFinalTextModesByStart = ["continuation", "full"];

    const requestId = "discord:chan:msg_reanchor_mode_refresh";

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

    expect(adapter.streams).toHaveLength(2);
    expect(adapter.streams[0]?.aborted).toBe("reanchor");
    expect(adapter.streams[1]?.parts.at(-1)).toEqual({ type: "text.set", text: "b" });

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
        requestDeliveryId: crypto.randomUUID(),
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

    expect(adapter.stream?.aborted).toBe("cancel");
    expect(adapter.typingStops).toBe(1);

    await bridge.stop();
  });

  it("does not cancel an active relay for inherited or accessor raw controls", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_hostile_cancel";
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

    let getterCalls = 0;
    const hostileRaw = Object.setPrototypeOf({}, { cancel: true });
    Object.defineProperty(hostileRaw, "cancel", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("hostile cancel getter must not run");
      },
    });
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt",
        messages: [],
        raw: hostileRaw,
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "discord",
        },
      },
    );

    expect(adapter.stream?.aborted).toBeUndefined();
    expect(adapter.typingStops).toBe(0);
    expect(getterCalls).toBe(0);
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

    expect(adapter.typingStops).toBe(1);
    expect(adapter.stream?.finished).toBe(false);

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "Error: boom" },
      { headers: { request_id: requestId } },
    );

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
    const linked: MsgRef[] = [];
    const unlinked: Array<{ platform: string; channelId: string; messageId: string }> = [];
    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest(input) {
        linked.push(...input.created);
      },
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      listSurfaceMessagesForRequest() {
        return [];
      },
      unlinkSurfaceMessage(input) {
        unlinked.push(input);
        return Result.ok({ requestId: "discord:chan:msg_skip", checkpointDeleted: false });
      },
      deleteUnlinkedCheckpointCandidate() {
        return Result.ok(false);
      },
      close() {},
    };

    const requestId = "discord:chan:msg_skip";

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
      transcriptStore,
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

    expect(adapter.stream?.aborted).toBe("skip");
    expect(adapter.stream?.finished).toBe(false);
    expect(adapter.deletedMsgs).toHaveLength(1);
    expect(adapter.deletedMsgs[0]).toEqual({
      platform: "discord",
      channelId: "chan",
      messageId: "m_out_1",
    });
    expect(adapter.stream?.parts).toEqual([{ type: "text.delta", delta: "working" }]);
    expect(linked).toEqual([{ platform: "discord", channelId: "chan", messageId: "m_out_1" }]);
    expect(unlinked).toEqual(linked);

    await bridge.stop();
  });

  it("finishes skip cleanup when checkpoint candidate deletion fails", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:msg_skip_cleanup_failure";
    const transcriptStore: TranscriptStore = {
      saveRequestTranscript() {
        return Result.ok(undefined);
      },
      linkSurfaceMessagesToRequest() {},
      getTranscriptBySurfaceMessage() {
        return Result.ok(null);
      },
      deleteUnlinkedCheckpointCandidate() {
        return Result.err(
          new TranscriptStoreSqliteDriverFailure({
            operation: "delete-unlinked-checkpoint-candidate",
            code: "SQLITE_IOERR",
            message: "cleanup failed",
          }),
        );
      },
      close() {},
    };

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
      transcriptStore,
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
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "NO_REPLY" },
      { headers: { request_id: requestId } },
    );
    expect(adapter.stream?.aborted).toBe("skip");
    expect(adapter.typingStops).toBe(1);

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

    expect(adapter.stream?.aborted).toBe("skip");
    expect(adapter.stream?.parts).toEqual([]);
    expect(adapter.deletedMsgs).toHaveLength(0);

    await bridge.stop();
  });

  it("buffers quoted NO_REPLY deltas so sentinel text is never shown", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:msg_skip_buffered_quoted";

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
      { delta: `"NO_` },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: `REPLY"  ` },
      { headers: { request_id: requestId } },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: `"NO_REPLY"` },
      { headers: { request_id: requestId } },
    );

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

    expect(adapter.stream?.parts).toEqual([
      { type: "text.delta", delta: "NO_REPLY because ..." },
      { type: "text.set", text: "NO_REPLY because ..." },
    ]);
    expect(adapter.stream?.finished).toBe(true);

    await bridge.stop();
  });

  it("requires an exact request_client match across relay-consumed event paths", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const requestId = "discord:chan:mismatch";

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
          request_client: "github",
        },
      },
    );

    expect(adapter.streams).toHaveLength(0);

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

    expect(adapter.stream).not.toBeNull();

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      {
        inheritReplyTo: true,
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "github",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt",
        messages: [],
        raw: { cancel: true, requiresActive: true },
      },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "github",
        },
      },
    );

    expect(adapter.streams[0]?.aborted).toBeUndefined();

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
    expect(adapter.streams).toHaveLength(2);

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
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
    expect(adapter.streams[1]?.aborted).toBe("cancel");

    await bridge.stop();
  });

  it("dead-letters relay mutations with conflicting active correlation", async () => {
    const deliveries: DeliveryObservation[] = [];
    const bus = createLilacBus(createInMemoryRawBus((delivery) => deliveries.push(delivery)));
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:correlated";
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "active-correlation",
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
      { inheritReplyTo: true },
      {
        headers: {
          request_id: requestId,
          session_id: "other",
          request_client: "discord",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt",
        messages: [],
        raw: { cancel: true },
      },
      {
        headers: {
          request_id: requestId,
          session_id: "other",
          request_client: "discord",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "failed" },
      {
        headers: {
          request_id: requestId,
          session_id: "chan",
          request_client: "github",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "must not render" },
      {
        headers: {
          request_id: requestId,
          session_id: "other",
          request_client: "discord",
        },
      },
    );
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "interrupt",
        messages: [],
        raw: { cancel: true },
      },
      { headers: { request_id: requestId, request_client: "discord" } },
    );
    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      { inheritReplyTo: true },
      { headers: { request_id: requestId, session_id: "chan" } },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "failed" },
      { headers: { request_id: requestId, request_client: "discord" } },
    );

    expect(deliveries.slice(-7).map((delivery) => delivery.disposition)).toEqual([
      "dead-letter",
      "dead-letter",
      "dead-letter",
      "dead-letter",
      "dead-letter",
      "dead-letter",
      "dead-letter",
    ]);
    expect(adapter.streams).toHaveLength(1);
    expect(adapter.stream?.aborted).toBeUndefined();
    expect(adapter.stream?.parts).toEqual([]);
    expect(adapter.typingStops).toBe(0);
    await bridge.stop();
  });

  it("preserves terminal-before-relay platform and session correlation", async () => {
    const deliveries: DeliveryObservation[] = [];
    const bus = createLilacBus(createInMemoryRawBus((delivery) => deliveries.push(delivery)));
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:terminal-first";
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "terminal-first-correlation",
      idleTimeoutMs: 10_000,
    });
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved" },
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
          session_id: "other",
          request_client: "discord",
        },
      },
    );
    expect(deliveries.at(-1)?.disposition).toBe("dead-letter");
    expect(adapter.streams).toHaveLength(0);

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
    expect(adapter.streams).toHaveLength(1);
    expect(adapter.typingStarts).toHaveLength(1);
    expect(adapter.typingStops).toBe(1);
    await bridge.stop();
  });

  it("dead-letters incomplete headers only after an output becomes surface-bound", async () => {
    const deliveries: DeliveryObservation[] = [];
    const bus = createLilacBus(
      createInMemoryRawBus((delivery) => deliveries.push(delivery), undefined, false),
    );
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:missing-output-correlation";
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "discord",
      subscriptionId: "missing-output-correlation",
      idleTimeoutMs: 10_000,
    });
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "not surface-bound yet" },
      { headers: { request_id: requestId } },
    );
    expect(deliveries).toEqual([]);

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
      { finalText: "must not finalize" },
      { headers: { request_id: requestId } },
    );
    expect(deliveries.at(-1)?.disposition).toBe("dead-letter");
    expect(adapter.stream?.parts).toEqual([]);
    expect(adapter.stream?.finished).toBe(false);
    expect(adapter.typingStops).toBe(0);
    await bridge.stop();
  });

  it("dead-letters missing request_client headers in every relay consumer", async () => {
    const deliveries: DeliveryObservation[] = [];
    const bus = createLilacBus(createInMemoryRawBus((delivery) => deliveries.push(delivery)));
    const bridge = await bridgeBusToAdapter({
      adapter: new FakeAdapter(),
      bus,
      platform: "discord",
      subscriptionId: "discord-adapter",
      idleTimeoutMs: 10_000,
    });

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      { requestDeliveryId: crypto.randomUUID(), queue: "prompt", messages: [] },
      { headers: { request_id: "missing-client-cmd", session_id: "chan" } },
    );
    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      { inheritReplyTo: true },
      { headers: { request_id: "missing-client-surface", session_id: "chan" } },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      { headers: { request_id: "missing-client-event", session_id: "chan" } },
    );

    expect(deliveries.map(({ topic, disposition }) => ({ topic, disposition }))).toEqual([
      { topic: "cmd.request", disposition: "dead-letter" },
      { topic: "cmd.surface", disposition: "dead-letter" },
      { topic: "evt.request", disposition: "dead-letter" },
    ]);
    expect(deliveries.every((delivery) => !delivery.contextHasCommit)).toBe(true);

    await bridge.stop();
  });

  it.each([
    [
      "skip",
      { finalText: "ignored", delivery: "skip" as const },
      { kind: "issue", issueNumber: 12 },
    ],
    ["empty output", { finalText: "" }, { kind: "issue", issueNumber: 12 }],
    ["finish", { finalText: "finished" }, { kind: "issue", issueNumber: 12 }],
    [
      "finish for a comment reaction",
      { finalText: "finished" },
      { kind: "comment", commentId: 55, issueNumber: 12 },
    ],
  ] satisfies ReadonlyArray<
    readonly [string, { finalText: string; delivery?: "skip" }, GithubAckState["target"]]
  >)("clears the GitHub acknowledgement on %s", async (_terminal, response, target) => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const sessionId = `octo/relay-ack-${crypto.randomUUID()}#12`;
    const requestId = `github:${sessionId}:12`;
    setGithubAck(requestId, {
      target,
      reactionId: 42,
    });
    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "github",
      subscriptionId: `github-ack-${crypto.randomUUID()}`,
      idleTimeoutMs: 10_000,
    });

    try {
      await bus.publish(
        lilacEventTypes.EvtRequestReply,
        {},
        {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
        },
      );
      await bus.publish(lilacEventTypes.EvtAgentOutputResponseText, response, {
        headers: { request_id: requestId },
      });

      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
      await bridge.stop();
      await bus.close();
      warning.mockRestore();
    }
  });

  it("logs a narrow GitHub acknowledgement failure and completes relay cleanup", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const sessionId = `octo/relay-ack-failure-${crypto.randomUUID()}#12`;
    const requestId = `github:${sessionId}:12`;
    setGithubAck(requestId, {
      target: { kind: "issue", issueNumber: 12 },
      reactionId: 42,
    });
    const policy = createGithubRelayPolicy({
      acknowledgementApi: {
        deleteIssueReactionById: async () => {
          throw new Error("GitHub API unavailable");
        },
        deleteIssueCommentReactionById: async () => undefined,
      },
    });
    const bridge = await bridgeBusToAdapterImpl({
      adapter,
      blobStore: await defaultBlobStore(),
      bus,
      platform: "github",
      policy,
      subscriptionId: `github-ack-failure-${crypto.randomUUID()}`,
      idleTimeoutMs: 10_000,
    });

    try {
      await bus.publish(
        lilacEventTypes.EvtRequestReply,
        {},
        {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
        },
      );
      await bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: "finished" },
        { headers: { request_id: requestId } },
      );

      expect(adapter.stream?.finished).toBe(true);
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
      await bridge.stop();
      await bus.close();
    }
  });

  it("logs the redacted narrow acknowledgement cleanup envelope", () => {
    const calls: Array<{ message: string; context: unknown }> = [];
    const requestId = "github:octo/repo#12:12";
    logIngressAcknowledgementCleanupFailure({
      logger: {
        warn: (message, context) => calls.push({ message, context }),
      },
      error: new SurfaceIngressAcknowledgementCleanupFailed({
        cause: {
          errorTag: "GithubAcknowledgementDeleteFailed",
          errorMessage: "Failed to delete GitHub acknowledgement reaction",
        },
        message: "Failed to clear surface ingress acknowledgement",
      }),
      requestId,
      sessionId: "octo/repo#12",
    });

    expect(calls).toEqual([
      {
        message: "failed to clear ingress acknowledgement",
        context: {
          requestId,
          sessionId: "octo/repo#12",
          errorTag: "SurfaceIngressAcknowledgementCleanupFailed",
          errorMessage: "Failed to clear surface ingress acknowledgement",
          causeErrorTag: "GithubAcknowledgementDeleteFailed",
          causeErrorMessage: "Failed to delete GitHub acknowledgement reaction",
        },
      },
    ]);
  });

  it("commits a previously swallowed reanchor side-effect failure", async () => {
    const deliveries: DeliveryObservation[] = [];
    const bus = createLilacBus(createInMemoryRawBus((delivery) => deliveries.push(delivery)));
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:reanchor_failure";
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
    adapter.failNextStart = true;
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

    expect(deliveries.at(-1)).toMatchObject({
      topic: "cmd.surface",
      disposition: "commit",
      contextHasCommit: false,
    });

    await bridge.stop();
  });

  it("stops failed tail processing without advancing the relay cursor", async () => {
    const deliveries: DeliveryObservation[] = [];
    const bus = createLilacBus(createInMemoryRawBus((delivery) => deliveries.push(delivery)));
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:tail_failure";
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
    const acceptedResult = await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "accepted" },
      { headers: { request_id: requestId } },
    );
    if (acceptedResult.status === "error") throw acceptedResult.error;
    const accepted = acceptedResult.value;

    if (!adapter.stream) throw new Error("relay output stream was not started");
    adapter.stream.nextPushFailure = new Error("forced output push failure");
    const failedResult = await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: " rejected" },
      { headers: { request_id: requestId } },
    );
    if (failedResult.status === "error") throw failedResult.error;
    const failed = failedResult.value;

    expect(deliveries.find((delivery) => delivery.cursor === failed.cursor)).toMatchObject({
      disposition: "stop",
      contextHasCommit: false,
    });
    expect(accepted.cursor).not.toBe(failed.cursor);

    await bridge.stop();
  });

  it("propagates a tail Panic instead of applying a delivery policy", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:tail_panic";
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
    if (!adapter.stream) throw new Error("relay output stream was not started");
    const panic = new Panic({ message: "forced output invariant failure" });
    adapter.stream.nextPushFailure = panic;

    await expect(
      bus.publish(
        lilacEventTypes.EvtAgentOutputDeltaText,
        { delta: "panic" },
        { headers: { request_id: requestId } },
      ),
    ).rejects.toBe(panic);

    await bridge.stop();
  });

  it("finishes terminal relay cleanup before rethrowing the original Panic", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FakeAdapter();
    const requestId = "discord:chan:terminal_cleanup_panic";
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
      { delta: "preview" },
      { headers: { request_id: requestId } },
    );
    if (!adapter.stream) throw new Error("relay output stream was not started");
    const panic = new Panic({ message: "forced abort invariant failure" });
    adapter.stream.nextAbortFailure = panic;

    await expect(
      bus.publish(
        lilacEventTypes.EvtAgentOutputResponseText,
        { finalText: "ignored", delivery: "skip" },
        { headers: { request_id: requestId } },
      ),
    ).rejects.toBe(panic);

    expect(adapter.deletedMsgs.map((message) => message.messageId)).toEqual(["m_out_1"]);

    await bridge.stop();
  });

  it("suppresses stale GitHub final replies when a newer request exists", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const adapter = new FakeAdapter();

    const sessionId = "octo/repo#12";
    const staleRequestId = `github:${sessionId}:old`;
    const latestRequestId = `github:${sessionId}:new`;
    setGithubLatestRequestForSession(sessionId, latestRequestId);
    setGithubAck(staleRequestId, {
      target: { kind: "issue", issueNumber: 12 },
      reactionId: 43,
    });

    const bridge = await bridgeBusToAdapter({
      adapter,
      bus,
      platform: "github",
      subscriptionId: "github-adapter",
      idleTimeoutMs: 10_000,
    });

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: {
          request_id: staleRequestId,
          session_id: sessionId,
          request_client: "github",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtAgentOutputResponseText,
      { finalText: "stale output" },
      {
        headers: {
          request_id: staleRequestId,
          session_id: sessionId,
          request_client: "github",
        },
      },
    );

    expect(adapter.streams[0]?.aborted).toBe("superseded");
    expect(adapter.streams[0]?.finished).toBe(false);
    expect(getGithubAck(staleRequestId)).toEqual({
      target: { kind: "issue", issueNumber: 12 },
      reactionId: 43,
    });

    clearGithubAck(staleRequestId);
    await bridge.stop();
  });
});
