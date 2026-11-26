import { describe, expect, expectTypeOf, it } from "bun:test";
import { Panic, Result } from "better-result";

import type {
  StartOutputOpts,
  SurfaceAdapter,
  SurfaceCacheBurstProvider,
  SurfaceGuildIdResolver,
  SurfaceOperationResult,
  SurfaceOutputResult,
  SurfaceOutputStream,
  SurfaceRequestReadScopeProvider,
} from "../../src/surface/adapter";
import {
  hasCacheBurstProvider,
  hasRequestReadScopeProvider,
  hasSurfaceGuildIdResolver,
  SurfaceOperationPartiallyCompleted,
  SurfaceRateLimited,
  SurfaceUnavailable,
} from "../../src/surface/adapter";
import type { AdapterEvent } from "../../src/surface/events";
import {
  createDescriptorBoundSurfaceAdapter,
  createDescriptorBoundSurfaceEventSource,
  createDescriptorBoundWorkflowProgressPort,
} from "../../src/surface/produced-ref-guard";
import type {
  RegisteredSurfacePlatform,
  SurfaceWorkflowProgressPort,
  WorkflowProgressOperationFailureFields,
} from "../../src/surface/runtime-descriptor";
import { workflowProgressOperationFailure } from "../../src/surface/runtime-descriptor";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";

const DISCORD_SESSION = { platform: "discord" as const, channelId: "channel" };
const DISCORD_REF = { ...DISCORD_SESSION, messageId: "message" };
const WRONG_PLATFORM_REF = {
  platform: "github" as const,
  channelId: "channel",
  messageId: "wrong-platform",
};

type InvalidPermanentWorkflowFailure = {
  readonly operation: "send";
  readonly disposition: "permanent";
  readonly reason: "rate-limited";
  readonly message: string;
};

type InvalidPermanentWorkflowFailureIsAssignable =
  InvalidPermanentWorkflowFailure extends WorkflowProgressOperationFailureFields ? true : false;

expectTypeOf<InvalidPermanentWorkflowFailureIsAssignable>().toEqualTypeOf<false>();
const WRONG_SESSION_REF = {
  platform: "discord" as const,
  channelId: "other",
  messageId: "wrong-session",
};

function message(ref: MsgRef, session: SessionRef = DISCORD_SESSION): SurfaceMessage {
  return {
    ref,
    session,
    userId: "user",
    text: "text",
    ts: 1,
  };
}

function outputStream(): SurfaceOutputStream {
  return {
    push: async () => Result.ok("visible"),
    finish: async () => Result.ok({ created: [DISCORD_REF], last: DISCORD_REF }),
    abort: async () => Result.ok(undefined),
  };
}

const DEFAULT_ADAPTER = {
  connect: async () => undefined,
  disconnect: async () => undefined,
  getSelf: async () => ({ platform: "discord" as const, userId: "bot", userName: "bot" }),
  listSessions: async () => Result.ok([]),
  listSessionParticipants: async () =>
    Result.ok({ source: "guild_members" as const, participants: [] }),
  startOutput: async (_sessionRef: SessionRef, _opts?: StartOutputOpts) =>
    Result.ok(outputStream()),
  startTyping: async () => Result.ok({ stop: async () => Result.ok(undefined) }),
  prepareSendMsg: async () => Result.ok(undefined),
  sendMsg: async (sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts) =>
    Result.ok({
      platform: sessionRef.platform,
      channelId: sessionRef.channelId,
      messageId: "message",
    }),
  readMsg: async (_msgRef: MsgRef) => Result.ok(null),
  listMsg: async (_sessionRef: SessionRef, _opts?: LimitOpts) => Result.ok([]),
  editMsg: async () => Result.ok(undefined),
  deleteMsg: async () => Result.ok(undefined),
  getReplyContext: async (_msgRef: MsgRef, _opts?: LimitOpts) => Result.ok([]),
  planReplyChain: async (msgRef: MsgRef) => Result.ok([msgRef]),
  planMergeBlockEndingAt: async (msgRef: MsgRef) => Result.ok([msgRef]),
  addReaction: async () => Result.ok(undefined),
  removeReaction: async () => Result.ok(undefined),
  listReactions: async () => Result.ok([]),
  listReactionDetails: async () => Result.ok([]),
  getUnRead: async () => Result.ok([]),
  markRead: async () => Result.ok(undefined),
} satisfies SurfaceAdapter;

function faultyAdapter(overrides: Partial<SurfaceAdapter>): SurfaceAdapter {
  return { ...DEFAULT_ADAPTER, ...overrides };
}

async function expectPanic(effect: () => Promise<unknown>): Promise<void> {
  const [settled] = await Promise.allSettled([effect()]);
  expect(settled?.status).toBe("rejected");
  if (settled?.status !== "rejected") return;
  expect(Panic.is(settled.reason)).toBe(true);
}

describe("descriptor-bound produced ref guard", () => {
  it("rejects every adapter operation that can produce a mismatched ref", async () => {
    const cases: Array<{ readonly name: string; readonly run: () => Promise<unknown> }> = [
      {
        name: "listSessions",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({
              listSessions: async () =>
                Result.ok([{ ref: WRONG_PLATFORM_REF, kind: "thread" as const }]),
            }),
          ).listSessions(),
      },
      {
        name: "sendMsg",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({ sendMsg: async () => Result.ok(WRONG_SESSION_REF) }),
          ).sendMsg(DISCORD_SESSION, { text: "send" }),
      },
      {
        name: "readMsg.ref",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({ readMsg: async () => Result.ok(message(WRONG_PLATFORM_REF)) }),
          ).readMsg(DISCORD_REF),
      },
      {
        name: "readMsg.session",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({
              readMsg: async () => Result.ok(message(DISCORD_REF, { ...WRONG_SESSION_REF })),
            }),
          ).readMsg(DISCORD_REF),
      },
      {
        name: "listMsg",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({ listMsg: async () => Result.ok([message(WRONG_SESSION_REF)]) }),
          ).listMsg(DISCORD_SESSION),
      },
      {
        name: "getReplyContext",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({
              getReplyContext: async () => Result.ok([message(WRONG_PLATFORM_REF)]),
            }),
          ).getReplyContext(DISCORD_REF),
      },
      {
        name: "getUnRead",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({ getUnRead: async () => Result.ok([message(WRONG_SESSION_REF)]) }),
          ).getUnRead(DISCORD_SESSION),
      },
      {
        name: "planReplyChain",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({ planReplyChain: async () => Result.ok([WRONG_PLATFORM_REF]) }),
          ).planReplyChain(DISCORD_REF),
      },
      {
        name: "planMergeBlockEndingAt",
        run: () =>
          createDescriptorBoundSurfaceAdapter(
            "discord",
            faultyAdapter({
              planMergeBlockEndingAt: async () => Result.ok([WRONG_SESSION_REF]),
            }),
          ).planMergeBlockEndingAt(DISCORD_REF),
      },
    ];

    for (const contractCase of cases) {
      await expectPanic(contractCase.run);
    }
  });

  it("rejects a mismatched partial-completion ref instead of returning an operation error", async () => {
    const partial = new SurfaceOperationPartiallyCompleted({
      platform: "discord",
      operation: "send-message",
      created: WRONG_PLATFORM_REF,
      message: "created before failure",
    });
    const adapter = createDescriptorBoundSurfaceAdapter(
      "discord",
      faultyAdapter({
        sendMsg: async (): Promise<SurfaceOperationResult<MsgRef>> => Result.err(partial),
      }),
    );

    await expectPanic(() => adapter.sendMsg(DISCORD_SESSION, { text: "send" }));
  });

  it("rejects callback refs before invoking the shared caller callback", async () => {
    let observed = false;
    const adapter = createDescriptorBoundSurfaceAdapter(
      "discord",
      faultyAdapter({
        startOutput: async (_sessionRef, opts) => {
          opts?.onMessageCreated?.(WRONG_PLATFORM_REF);
          return Result.ok(outputStream());
        },
      }),
    );

    await expectPanic(() =>
      adapter.startOutput(DISCORD_SESSION, {
        onMessageCreated: () => {
          observed = true;
        },
      }),
    );
    expect(observed).toBe(false);
  });

  it.each([
    ["created", { created: [WRONG_PLATFORM_REF], last: DISCORD_REF }],
    ["last", { created: [DISCORD_REF], last: WRONG_SESSION_REF }],
  ] satisfies Array<[string, SurfaceOutputResult]>)(
    "rejects a mismatched output finish %s ref",
    async (_role, output) => {
      const adapter = createDescriptorBoundSurfaceAdapter(
        "discord",
        faultyAdapter({
          startOutput: async () =>
            Result.ok({
              ...outputStream(),
              finish: async () => Result.ok(output),
            }),
        }),
      );
      const started = await adapter.startOutput(DISCORD_SESSION);
      if (started.status === "error") throw started.error;
      let linked = false;

      await expectPanic(() =>
        started.value.finish().then((result) => {
          linked = result.status === "ok";
          return result;
        }),
      );
      expect(linked).toBe(false);
    },
  );

  it("forwards optional capabilities and output final-text mode through the facade", async () => {
    const burstInputs: Array<Parameters<SurfaceCacheBurstProvider["burstCache"]>[0]> = [];
    let scopeRuns = 0;
    const raw = {
      ...DEFAULT_ADAPTER,
      burstCache: async (input: Parameters<SurfaceCacheBurstProvider["burstCache"]>[0]) => {
        burstInputs.push(input);
      },
      withRequestReadScope: async <T>(run: () => Promise<T>) => {
        scopeRuns += 1;
        return await run();
      },
      fetchGuildIdForChannel: async (channelId: string) => `guild:${channelId}`,
      startOutput: async () =>
        Result.ok({
          ...outputStream(),
          getFinalTextMode: () => "full" as const,
        }),
    } satisfies SurfaceAdapter &
      SurfaceCacheBurstProvider &
      SurfaceRequestReadScopeProvider &
      SurfaceGuildIdResolver;
    const guarded = createDescriptorBoundSurfaceAdapter("discord", raw);

    expect(hasCacheBurstProvider(guarded)).toBe(true);
    if (!hasCacheBurstProvider(guarded)) throw new Error("cache burst capability missing");
    await guarded.burstCache({ sessionRef: DISCORD_SESSION, reason: "other" });
    expect(burstInputs).toEqual([{ sessionRef: DISCORD_SESSION, reason: "other" }]);

    expect(hasRequestReadScopeProvider(guarded)).toBe(true);
    if (!hasRequestReadScopeProvider(guarded)) throw new Error("request scope capability missing");
    expect(await guarded.withRequestReadScope(async () => "scoped")).toBe("scoped");
    expect(scopeRuns).toBe(1);

    expect(hasSurfaceGuildIdResolver(guarded)).toBe(true);
    if (!hasSurfaceGuildIdResolver(guarded)) throw new Error("guild resolver capability missing");
    expect(await guarded.fetchGuildIdForChannel("channel")).toBe("guild:channel");

    const started = await guarded.startOutput(DISCORD_SESSION);
    if (started.status === "error") throw started.error;
    expect(started.value.getFinalTextMode?.()).toBe("full");
  });

  it("rejects every ref-bearing event variant before invoking an ingress consumer", async () => {
    const events: AdapterEvent[] = [
      {
        type: "adapter.message.created",
        platform: "discord",
        message: message(WRONG_PLATFORM_REF),
        ts: 1,
      },
      {
        type: "adapter.message.updated",
        platform: "discord",
        message: message(WRONG_SESSION_REF),
        ts: 1,
      },
      {
        type: "adapter.message.deleted",
        platform: "discord",
        messageRef: WRONG_PLATFORM_REF,
        session: DISCORD_SESSION,
        ts: 1,
      },
      {
        type: "adapter.reaction.added",
        platform: "discord",
        messageRef: WRONG_SESSION_REF,
        session: DISCORD_SESSION,
        reaction: "thumbsup",
        ts: 1,
      },
      {
        type: "adapter.reaction.removed",
        platform: "discord",
        messageRef: WRONG_PLATFORM_REF,
        session: DISCORD_SESSION,
        reaction: "thumbsup",
        ts: 1,
      },
      {
        type: "adapter.action.invoked",
        platform: "discord",
        actionId: "action",
        userId: "user",
        messageRef: WRONG_PLATFORM_REF,
        ts: 1,
      },
    ];

    for (const event of events) {
      let handlerCalls = 0;
      const source = createDescriptorBoundSurfaceEventSource("discord", {
        subscribe: async (handler) => {
          await handler(event);
          return { stop: async () => undefined };
        },
      });

      await expectPanic(() =>
        source.subscribe(() => {
          handlerCalls += 1;
        }),
      );
      expect(handlerCalls).toBe(0);
    }
  });

  it("rejects a workflow wrong-channel partial creation before persistence", async () => {
    const descriptorPlatform = ((): RegisteredSurfacePlatform => "github")();
    const port: SurfaceWorkflowProgressPort<RegisteredSurfacePlatform> = {
      configurationRevision: "test-v1",
      checkMessage: async () => Result.ok("found"),
      send: async () =>
        Result.err({
          kind: "created",
          ref: { platform: "github", channelId: "other", messageId: "partial" },
        }),
      edit: async () => Result.ok(undefined),
    };
    const guarded = createDescriptorBoundWorkflowProgressPort(descriptorPlatform, port);
    let persisted = false;

    await expectPanic(() =>
      guarded.send({ channelId: "channel", content: { text: "send" } }).then((result) => {
        persisted = result.status === "ok";
        return result;
      }),
    );
    expect(persisted).toBe(false);
  });

  it("rejects a workflow send ref with the selected platform and channel correlation", async () => {
    const descriptorPlatform = ((): RegisteredSurfacePlatform => "discord")();
    const port: SurfaceWorkflowProgressPort<RegisteredSurfacePlatform> = {
      configurationRevision: "test-v1",
      checkMessage: async () => Result.ok("found"),
      send: async () => Result.ok(WRONG_PLATFORM_REF),
      edit: async () => Result.ok(undefined),
    };
    const guarded = createDescriptorBoundWorkflowProgressPort(descriptorPlatform, port);
    let persisted = false;

    await expectPanic(() =>
      guarded.send({ channelId: "channel", content: { text: "send" } }).then((result) => {
        persisted = result.status === "ok";
        return result;
      }),
    );
    expect(persisted).toBe(false);
  });

  it("rejects a forged workflow failure disposition and reason pair", async () => {
    const failure = workflowProgressOperationFailure(
      "send",
      new SurfaceUnavailable({
        platform: "discord",
        operation: "send-message",
        message: "unavailable",
      }),
    );
    Object.defineProperty(failure, "disposition", { value: "permanent" });
    const port: SurfaceWorkflowProgressPort<"discord"> = {
      configurationRevision: "test-v1",
      checkMessage: async () => Result.ok("found"),
      send: async () => Result.err({ kind: "failed", error: failure }),
      edit: async () => Result.ok(undefined),
    };
    const guarded = createDescriptorBoundWorkflowProgressPort("discord", port);

    await expectPanic(() => guarded.send({ channelId: "channel", content: { text: "send" } }));
  });

  it.each([
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ] as const)("rejects a %s workflow Retry-After", async (_label, retryAfterMs) => {
    const failure = workflowProgressOperationFailure(
      "send",
      new SurfaceRateLimited({
        platform: "discord",
        operation: "send-message",
        retryAfterMs,
        message: "rate limited",
      }),
    );
    const guarded = createDescriptorBoundWorkflowProgressPort("discord", {
      configurationRevision: "test-v1",
      checkMessage: async () => Result.ok("found"),
      send: async () => Result.err({ kind: "failed", error: failure }),
      edit: async () => Result.ok(undefined),
    });

    await expectPanic(() => guarded.send({ channelId: "channel", content: { text: "send" } }));
  });

  it("accepts an integer workflow Retry-After", async () => {
    const failure = workflowProgressOperationFailure(
      "send",
      new SurfaceRateLimited({
        platform: "discord",
        operation: "send-message",
        retryAfterMs: 1_500,
        message: "rate limited",
      }),
    );
    const guarded = createDescriptorBoundWorkflowProgressPort("discord", {
      configurationRevision: "test-v1",
      checkMessage: async () => Result.ok("found"),
      send: async () => Result.err({ kind: "failed", error: failure }),
      edit: async () => Result.ok(undefined),
    });

    const sent = await guarded.send({ channelId: "channel", content: { text: "send" } });

    expect(sent.status).toBe("error");
    if (sent.status === "error" && sent.error.kind === "failed") {
      expect(sent.error.error.retryAfterMs).toBe(1_500);
    }
  });
});

it("forwards session listing filters through the descriptor boundary", async () => {
  const options = { limit: 101, archived: true };
  const seen: Array<Parameters<SurfaceAdapter["listSessions"]>[0]> = [];
  const adapter = createDescriptorBoundSurfaceAdapter(
    "native",
    faultyAdapter({
      listSessions: async (input) => {
        seen.push(input);
        return Result.ok([]);
      },
    }),
  );
  expect((await adapter.listSessions(options)).unwrap()).toEqual([]);
  expect(seen).toEqual([options]);
});
