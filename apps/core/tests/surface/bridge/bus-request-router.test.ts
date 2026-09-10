import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  createLilacBus,
  EventDeliveryStartFailed,
  EventDeliveryStopFailed,
  EventDeliveryTransportFailed,
  lilacEventTypes,
  type EventDeliveryContext,
  type EventDeliveryDoneError,
  type DecodedLilacMessageForTopic,
  type FetchOptions,
  type LilacBus,
  type LilacTopic,
  type Message,
  type PublishOptions,
  type RawBus,
  type RawDeliveryAction,
  type RawDeliveryHandler,
  type SubscriptionOptions,
  type BusMessageV2,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import { projectAuthenticatedRequest } from "../../../src/surface/authenticated-request";
import { resolveAuthenticatedRequestSafetyMode } from "../../../src/surface/builtin-surface-protocols";

import {
  adaptDiscordRequestRouterStartOutcomeToHost,
  DiscordRequestRouterAdapterSelfLookupRejected,
  DiscordRequestRouterStartupAndCleanupFailed,
  DiscordRequestRouterSubscriptionStopRejected,
  discordRequestCompositionFailurePolicy,
  startDiscordRequestRouter as startDiscordRequestRouterImpl,
  type StartDiscordRequestRouterInput,
} from "../../../src/surface/discord/discord-request-router";
import {
  withDefaultToolsConfig,
  type RouterConfigOverride,
} from "../../../src/surface/discord/discord-request-router/common";
import {
  resolvePreviousMessageText,
  resolveRepliedToMessageText,
} from "../../../src/surface/discord/discord-request-router/context";
import { formatBufferedMessageForGateTranscript } from "../../../src/surface/discord/discord-request-router/gate";
import {
  DiscordRequestDeliveryFailed,
  publishSingleMessagePrompt,
} from "../../../src/surface/discord/discord-request-router/publish";
import { getTestBlobStore } from "../../helpers/blob-store";
import {
  SurfaceInvalidInput,
  SurfacePermissionDenied,
  SurfaceRateLimited,
  SurfaceUnavailable,
  type SurfaceOperationResult,
} from "../../../src/surface/adapter";

import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
} from "../../../src/surface/types";

import {
  CoreOwnedBlobIntegrityError,
  SqliteTranscriptStore,
  type TranscriptStore,
} from "../../../src/transcript/transcript-store";
import type { ModelMessage } from "ai";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";
import { createTestResourceRegistry } from "../../helpers/resource-registry";
import { ResourceStoreFailure, type ResourceRegistry } from "../../../src/resource";

type TestRawBus = RawBus & {
  readonly deliveryActions: Array<{ readonly topic: string; readonly action: RawDeliveryAction }>;
  readonly returnedStartFailures: EventDeliveryStartFailed[];
  readonly stoppedTopics: string[];
  activeSubscriptionCount(): number;
  failPublicationsTo(topic: string, cause: unknown): void;
  failNextPublicationTo(topic: string, cause: unknown): void;
  failStartsFor(topic: string, cause: unknown): void;
  rejectStartsFor(topic: string, cause: unknown): void;
  failStopsFor(topic: string, cause: unknown): void;
  rejectStopsFor(topic: string, cause: unknown): void;
  throwStopsFor(topic: string, cause: unknown): void;
  blockStopsFor(topic: string): { readonly entered: Promise<void>; release(): void };
  clearStopFailuresFor(topic: string): void;
  finishDelivery(topic: string, error: EventDeliveryDoneError): void;
};

type TestDiscordRequestRouterInput = Omit<
  StartDiscordRequestRouterInput,
  "blobStore" | "resourceRegistry" | "requestDelivery" | "config"
> &
  Partial<
    Pick<StartDiscordRequestRouterInput, "blobStore" | "resourceRegistry" | "requestDelivery">
  > & {
    config?: CoreConfig | RouterConfigOverride;
  };

function normalizeTestRouterConfig(
  config: CoreConfig | RouterConfigOverride | undefined,
): CoreConfig | undefined {
  if (!config) return undefined;
  if ("configVersion" in config) return config as CoreConfig;
  const parsed = withDefaultToolsConfig(config);
  if (parsed.status === "ok") return parsed.value;
  throw parsed.error;
}

async function startDiscordRequestRouter(input: TestDiscordRequestRouterInput) {
  return startDiscordRequestRouterImpl({
    ...input,
    config: normalizeTestRouterConfig(input.config),
    blobStore: input.blobStore ?? (await getTestBlobStore()),
    resourceRegistry: input.resourceRegistry ?? createTestResourceRegistry(),
    requestDelivery: input.requestDelivery ?? {
      async prepareAndPublish({ envelope }) {
        return (
          await input.bus.publish(lilacEventTypes.CmdRequestMessage, envelope.data, {
            headers: envelope.headers,
          })
        )
          .map(() => undefined)
          .mapError(
            (cause) =>
              new DiscordRequestDeliveryFailed({
                cause,
                message: "Test request publication failed",
              }),
          );
      },
    },
  });
}

class RouterTestHookFailure extends TaggedError("RouterTestHookFailure")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

async function startBusRequestRouter(input: TestDiscordRequestRouterInput) {
  return adaptDiscordRequestRouterStartOutcomeToHost(
    await startDiscordRequestRouter(input),
    () => {},
    () => {},
  );
}

function expectStarted<T>(started: ResultType<T, EventDeliveryStartFailed>): T {
  if (started.status === "ok") return started.value;
  if (Panic.is(started.error)) throw started.error;
  throw new Error(
    `Test delivery failed to start [${started.error._tag}]: ${started.error.message}`,
    {
      cause: started.error,
    },
  );
}

async function subscribeTopicForTest<TTopic extends LilacTopic>(
  bus: LilacBus,
  topic: TTopic,
  options: SubscriptionOptions,
  handler: (message: DecodedLilacMessageForTopic<TTopic>) => Promise<ResultType<void, never>>,
) {
  const deliveryWaiters: PromiseWithResolvers<void>[] = [];
  const subscription = expectStarted(
    await bus.subscribeTopic(
      topic,
      options,
      (message) => {
        const result = handler(message);
        void result.then(
          () => deliveryWaiters.shift()?.resolve(),
          () => deliveryWaiters.shift()?.resolve(),
        );
        return result;
      },
      () => "park-pending",
    ),
  );
  return {
    ...subscription,
    waitForDelivery: () => {
      const delivery = Promise.withResolvers<void>();
      deliveryWaiters.push(delivery);
      return delivery.promise;
    },
  };
}

async function triggerRouterDebounce(
  trigger: () => Promise<unknown>,
  completed: Promise<unknown>,
  debounceMs = 5,
): Promise<void> {
  jest.useFakeTimers({ now: Date.now() });
  try {
    await trigger();
    jest.advanceTimersByTime(debounceMs);
    await completed;
  } finally {
    jest.useRealTimers();
  }
}

function observeRouterDecision() {
  const logger = new Logger({ module: "bus-request-router-decision-test" });
  const decided = Promise.withResolvers<void>();
  const resolveDecision = (message: unknown) => {
    if (message === "router.route.decision") decided.resolve();
  };
  const info = spyOn(logger, "info").mockImplementation(resolveDecision);
  const debug = spyOn(logger, "debug").mockImplementation(resolveDecision);
  return {
    logger,
    decided: decided.promise.finally(() => {
      info.mockRestore();
      debug.mockRestore();
    }),
  };
}

afterEach(() => {
  jest.useRealTimers();
});

function createInMemoryRawBus(): TestRawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const deliveryActions: TestRawBus["deliveryActions"] = [];
  const returnedStartFailures: EventDeliveryStartFailed[] = [];
  const stoppedTopics: string[] = [];
  const publicationFailures = new Map<string, unknown>();
  const nextPublicationFailures = new Map<string, unknown[]>();
  const startFailures = new Map<string, unknown>();
  const startRejections = new Map<string, unknown>();
  const stopFailures = new Map<string, unknown>();
  const stopRejections = new Map<string, unknown>();
  const stopThrows = new Map<string, unknown>();
  const stopBlocks = new Map<
    string,
    {
      readonly entered: PromiseWithResolvers<void>;
      readonly release: PromiseWithResolvers<void>;
    }
  >();
  const deliverySubs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: RawDeliveryHandler;
    done: PromiseWithResolvers<ResultType<void, EventDeliveryDoneError>>;
  }>();

  const deliveryContext = (
    topic: string,
    id: string,
    opts: SubscriptionOptions,
  ): EventDeliveryContext => {
    const evidence = {
      source: {
        transport: "redis-streams" as const,
        streamKey: topic,
        topic,
        messageId: id,
      },
      wire: { kind: "bounded-complete" as const, fields: [] },
    };
    if (opts.mode === "tail") return { cursor: id, mode: "tail", evidence };
    return {
      cursor: id,
      mode: opts.mode,
      evidence,
      deliveryId: "0000000000000000000000000000000000000000000000000000000000000000",
      attempt: 1,
      leaseDeadline: Date.now() + 60_000,
      signal: new AbortController().signal,
    };
  };

  return {
    deliveryActions,
    returnedStartFailures,
    stoppedTopics,
    activeSubscriptionCount: () => deliverySubs.size,
    failPublicationsTo: (topic, cause) => {
      publicationFailures.set(topic, cause);
    },
    failNextPublicationTo: (topic, cause) => {
      const failures = nextPublicationFailures.get(topic) ?? [];
      failures.push(cause);
      nextPublicationFailures.set(topic, failures);
    },
    failStartsFor: (topic, cause) => {
      startFailures.set(topic, cause);
    },
    rejectStartsFor: (topic, cause) => {
      startRejections.set(topic, cause);
    },
    failStopsFor: (topic, cause) => {
      stopFailures.set(topic, cause);
    },
    rejectStopsFor: (topic, cause) => {
      stopRejections.set(topic, cause);
    },
    throwStopsFor: (topic, cause) => {
      stopThrows.set(topic, cause);
    },
    blockStopsFor: (topic) => {
      const block = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      stopBlocks.set(topic, block);
      return {
        entered: block.entered.promise,
        release: () => block.release.resolve(),
      };
    },
    clearStopFailuresFor: (topic) => {
      stopFailures.delete(topic);
      stopRejections.delete(topic);
      stopThrows.delete(topic);
    },
    finishDelivery: (topic, error) => {
      for (const subscription of deliverySubs) {
        if (subscription.topic === topic) subscription.done.resolve(Result.err(error));
      }
    },
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      const nextFailures = nextPublicationFailures.get(opts.topic);
      if (nextFailures && nextFailures.length > 0) {
        const cause = nextFailures.shift();
        if (nextFailures.length === 0) nextPublicationFailures.delete(opts.topic);
        throw cause;
      }
      if (publicationFailures.has(opts.topic)) throw publicationFailures.get(opts.topic);
      const id = String(Date.now()) + "-0";
      const stored: Message<unknown> = {
        topic: opts.topic,
        id,
        type: opts.type,
        ts: Date.now(),
        key: opts.key,
        headers: opts.headers,
        data: msg.data,
      };

      const list = topics.get(opts.topic) ?? [];
      list.push(stored);
      topics.set(opts.topic, list);

      for (const s of deliverySubs) {
        if (s.topic !== opts.topic) continue;
        const action = await s.handler(stored, deliveryContext(s.topic, id, s.opts));
        deliveryActions.push({ topic: s.topic, action });
      }

      return { id, cursor: id };
    },

    subscribe: async (topic, opts, handler) => {
      if (startRejections.has(topic)) throw startRejections.get(topic);
      if (startFailures.has(topic)) {
        const failure = new EventDeliveryStartFailed({
          topic,
          cause: startFailures.get(topic),
          message: "forced start failure",
        });
        returnedStartFailures.push(failure);
        return Result.err(failure);
      }
      const done = Promise.withResolvers<ResultType<void, EventDeliveryDoneError>>();
      const entry = { topic, opts, handler, done };
      deliverySubs.add(entry);

      if (opts.mode === "tail" && opts.offset?.type === "begin") {
        for (const message of topics.get(topic) ?? []) {
          await handler(message, deliveryContext(topic, message.id, opts));
        }
      }

      return Result.ok({
        done: done.promise,
        stop: () => {
          stoppedTopics.push(topic);
          const block = stopBlocks.get(topic);
          const finishStop = (): Promise<ResultType<void, EventDeliveryStopFailed>> => {
            deliverySubs.delete(entry);
            done.resolve(Result.ok(undefined));
            if (stopThrows.has(topic)) throw stopThrows.get(topic);
            if (stopRejections.has(topic)) return Promise.reject(stopRejections.get(topic));
            if (stopFailures.has(topic)) {
              return Promise.resolve(
                Result.err(
                  new EventDeliveryStopFailed({
                    topic,
                    cause: stopFailures.get(topic),
                    message: "forced stop failure",
                  }),
                ),
              );
            }
            return Promise.resolve(Result.ok(undefined));
          };
          if (!block) return finishStop();
          block.entered.resolve();
          return block.release.promise.then(finishStop);
        },
      });
    },

    fetch: async (topic: string, _opts: FetchOptions) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]!.id : undefined,
      };
    },

    close: async () => {},
  };
}

class FakeAdapter extends SurfaceAdapterTestBase {
  constructor(
    private readonly messages: Record<string, SurfaceMessage>,
    private readonly platform: "discord" | "github" = "discord",
  ) {
    super();
  }

  async connect(): Promise<void> {
    throw new Error("not implemented");
  }
  async disconnect(): Promise<void> {
    throw new Error("not implemented");
  }

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: this.platform, userId: "bot", userName: "lilac" };
  }
  async listSessions() {
    return Result.ok([]);
  }

  async startOutput(_sessionRef: SessionRef) {
    return Result.ok({
      hydrateRecovery: () => "visible" as const,
      push: async () => Result.ok("visible" as const),
      finish: async () => {
        const ref = { platform: "discord" as const, channelId: "unused", messageId: "unused" };
        return Result.ok({ created: [ref], last: ref });
      },
      abort: async () => Result.ok(undefined),
    });
  }

  async sendMsg(_sessionRef: SessionRef, _content: ContentOpts, _opts?: SendOpts) {
    return Result.ok({ platform: "discord", channelId: "unused", messageId: "unused" } as const);
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    const key = `${msgRef.channelId}:${msgRef.messageId}`;
    return Result.ok(this.messages[key] ?? null);
  }

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts) {
    const limit = opts?.limit ?? 50;
    const before = opts?.beforeMessageId;

    const list = Object.values(this.messages)
      .filter((m) => m.session.channelId === sessionRef.channelId)
      .slice()
      .sort((a, b) => a.ts - b.ts);

    const beforeMessage = before
      ? list.find((m) => m.ref.messageId === before && m.session.channelId === sessionRef.channelId)
      : null;

    const eligible = beforeMessage
      ? list.filter((m) => {
          if (m.ts < beforeMessage.ts) return true;
          if (m.ts > beforeMessage.ts) return false;
          return m.ref.messageId < beforeMessage.ref.messageId;
        })
      : list;

    return Result.ok(eligible.slice(Math.max(0, eligible.length - limit)));
  }

  async editMsg(_msgRef: MsgRef, _content: ContentOpts) {
    return Result.ok(undefined);
  }

  async deleteMsg(_msgRef: MsgRef) {
    return Result.ok(undefined);
  }

  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const key = `${msgRef.channelId}:${msgRef.messageId}`;
    const base = this.messages[key];
    if (!base) return Result.ok([]);

    const limit = opts?.limit ?? 20;
    const half = Math.max(1, Math.floor(limit / 2));

    const all = Object.values(this.messages)
      .filter((m) => m.session.channelId === msgRef.channelId)
      .slice()
      .sort((a, b) => a.ts - b.ts);

    const beforeAll = all.filter((m) => m.ts <= base.ts);
    const before = beforeAll.slice(Math.max(0, beforeAll.length - half));

    const after = all.filter((m) => m.ts > base.ts).slice(0, half);

    return Result.ok(before.concat(after));
  }

  async addReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async removeReaction(_msgRef: MsgRef, _reaction: string) {
    return Result.ok(undefined);
  }

  async listReactions(_msgRef: MsgRef) {
    return Result.ok([]);
  }

  async subscribe(): Promise<{ stop(): Promise<void> }> {
    throw new Error("not implemented");
  }

  async getUnRead(_sessionRef: SessionRef) {
    return Result.ok([]);
  }

  async markRead(_sessionRef: SessionRef) {
    return Result.ok(undefined);
  }
}

function collectUserText(messages: readonly (ModelMessage | BusMessageV2)[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      parts.push(msg.content);
      continue;
    }
    for (const part of msg.content) {
      if (part.type === "text") parts.push(part.text);
    }
  }

  return parts.join("\n\n");
}

describe("Discord request composition failure policy", () => {
  it.each([
    new SurfaceRateLimited({
      platform: "discord",
      operation: "read-message",
      message: "rate limited",
    }),
    new SurfaceUnavailable({
      platform: "discord",
      operation: "read-message",
      message: "unavailable",
    }),
  ])("classifies $error._tag as a transient gateway drop", (error) => {
    expect(discordRequestCompositionFailurePolicy(error)).toEqual({
      disposition: "drop-transient-gateway-event",
      level: "warn",
      retryable: true,
    });
  });

  it.each([
    new SurfaceInvalidInput({
      platform: "discord",
      operation: "read-message",
      field: "messageId",
      message: "invalid",
    }),
    new SurfacePermissionDenied({
      platform: "discord",
      operation: "read-message",
      message: "forbidden",
    }),
  ])("classifies $error._tag as a permanent gateway drop", (error) => {
    expect(discordRequestCompositionFailurePolicy(error)).toEqual({
      disposition: "drop-permanent-gateway-event",
      level: "warn",
      retryable: false,
    });
  });

  it("keeps owned blob integrity failures distinct", () => {
    expect(
      discordRequestCompositionFailurePolicy(new CoreOwnedBlobIntegrityError("corrupt blob")),
    ).toEqual({
      disposition: "drop-integrity-failure",
      level: "error",
      retryable: false,
    });
  });
});

describe("Discord context text command", () => {
  const config: RouterConfigOverride = {
    surface: {
      discord: {
        tokenEnv: "DISCORD_TOKEN",
        allowedChannelIds: [],
        allowedGuildIds: [],
        botName: "lilac",
        outputMode: "inline",
        previewFinalOutputStyle: "embed",
      },
      router: {
        defaultMode: "active",
        sessionModes: {},
        activeDebounceMs: 5,
        activeGate: { enabled: true, timeoutMs: 2_500 },
      },
    },
    agent: { systemPrompt: "(unused in tests; compiled at runtime)" },
    models: {
      def: {},
      main: { model: "openrouter/openai/gpt-4o" },
      fast: { model: "openrouter/openai/gpt-4o-mini" },
    },
  };

  it("reports a snapshot at rest without publishing an agent request", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "channel", messageId: "context" },
      session: { platform: "discord", channelId: "channel" },
      userId: "user",
      userName: "User",
      text: "!context ignored trailing text",
      ts: Date.now(),
      raw: { discord: { isChat: true } },
    };
    const adapter = new FakeAdapter({ "channel:context": message });
    const sendMsg = spyOn(adapter, "sendMsg");
    const reports: Array<readonly { role: string; content: unknown }[]> = [];
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "context-rest-router-test",
      config,
      contextReport: async (request) => {
        reports.push([...request.messages]);
        return Result.ok({ text: "snapshot report", accentColor: 0x5865f2 });
      },
    });
    const requests: unknown[] = [];
    const requestSub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      { mode: "fanout", subscriptionId: "context-rest-requests", consumerId: "test" },
      async (request) => {
        requests.push(request);
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: "channel",
      messageId: "context",
      userId: "user",
      userName: "User",
      text: message.text,
      ts: message.ts,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: false,
          botUserId: "bot",
        },
      },
    });

    expect(requests).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(collectUserText(reports[0] as ModelMessage[])).toContain("!context");
    expect(sendMsg).toHaveBeenCalledWith(
      message.session,
      { text: "snapshot report", accentColor: 0x5865f2 },
      { replyTo: message.ref, silent: true },
    );

    sendMsg.mockRestore();
    await requestSub.stop();
    await router.stop();
    await bus.close();
  });

  it("queues the command as a follow-up when the session has an active request", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const message: SurfaceMessage = {
      ref: { platform: "discord", channelId: "channel", messageId: "context" },
      session: { platform: "discord", channelId: "channel" },
      userId: "user",
      userName: "User",
      text: "!context",
      ts: Date.now(),
      raw: { discord: { isChat: true } },
    };
    const adapter = new FakeAdapter({ "channel:context": message });
    let deliveryAttempts = 0;
    let reportCount = 0;
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "context-active-router-test",
      config,
      requestDelivery: {
        prepareAndPublish: async ({ envelope }) => {
          deliveryAttempts += 1;
          if (deliveryAttempts === 1) {
            return Result.err(
              new DiscordRequestDeliveryFailed({
                message: "Injected context follow-up delivery failure",
              }),
            );
          }
          return (
            await bus.publish(lilacEventTypes.CmdRequestMessage, envelope.data, {
              headers: envelope.headers,
            })
          )
            .map(() => undefined)
            .mapError(
              (cause) =>
                new DiscordRequestDeliveryFailed({
                  cause,
                  message: "Test request publication failed",
                }),
            );
        },
      },
      contextReport: async () => {
        reportCount += 1;
        return Result.ok({ text: "snapshot report", accentColor: 0x5865f2 });
      },
    });
    const requests: Array<DecodedLilacMessageForTopic<"cmd.request">> = [];
    const requestSub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      { mode: "fanout", subscriptionId: "context-active-requests", consumerId: "test" },
      async (request) => {
        requests.push(request);
        return Result.ok(undefined);
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: "discord:channel:active",
          session_id: "channel",
          request_client: "discord",
        },
      },
    );

    const eventData = {
      platform: "discord",
      channelId: "channel",
      messageId: "context",
      userId: "user",
      userName: "User",
      text: message.text,
      ts: message.ts,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: false,
          botUserId: "bot",
        },
      },
    } as const;
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, eventData);

    expect(requests).toHaveLength(0);
    expect(reportCount).toBe(0);
    expect(
      raw.deliveryActions
        .filter(({ topic }) => topic === "evt.adapter")
        .map(({ action }) => action.disposition)
        .at(-1),
    ).toBe("park-pending");

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, eventData);

    expect(requests).toHaveLength(1);
    expect(reportCount).toBe(1);
    expect(requests[0]?.headers?.request_id).toBe("discord:channel:active");
    expect(requests[0]?.data.queue).toBe("followUp");
    expect(collectUserText(requests[0]?.data.messages ?? [])).toContain("!context");
    expect(
      raw.deliveryActions
        .filter(({ topic }) => topic === "evt.adapter")
        .map(({ action }) => action.disposition)
        .slice(-2),
    ).toEqual(["park-pending", "commit"]);

    await requestSub.stop();
    await router.stop();
    await bus.close();
  });
});

describe("Discord authenticated-origin publication", () => {
  it("rejects an ingress identity whose complete message ref does not match", async () => {
    const logger = new Logger({ module: "discord-origin-correlation-test" });
    const msgRef = { platform: "discord" as const, channelId: "channel", messageId: "message" };
    const message: SurfaceMessage = {
      ref: msgRef,
      session: { platform: "discord", channelId: "channel" },
      userId: "authenticated-user",
      text: "hello",
      ts: 1,
      raw: { discord: { isChat: true } },
    };
    const mismatchedIngress: SurfaceMessage = {
      ...message,
      ref: { ...msgRef, channelId: "other-channel" },
      session: { platform: "discord", channelId: "other-channel" },
      userId: "uncorrelated-user",
    };
    const adapter = new FakeAdapter({ "channel:message": message });
    const readMsg = spyOn(adapter, "readMsg").mockResolvedValue(Result.ok(message));
    const blobStore = await getTestBlobStore();
    let publishedRaw: unknown;

    const result = await publishSingleMessagePrompt({
      adapter,
      blobStore,
      resourceRegistry: createTestResourceRegistry(),
      requestDelivery: {
        prepareAndPublish: async (input) => {
          publishedRaw = input.envelope.data.raw;
          return Result.ok(undefined);
        },
      },
      cfg: parseCoreConfigV1ToUniversal({}),
      logger,
      input: {
        requestId: "discord:channel:message",
        sessionId: "channel",
        sessionConfigId: "channel",
        msgRef,
        ingressMessage: mismatchedIngress,
        sessionMode: "mention",
      },
    });

    expect(result).toEqual(Result.ok(undefined));
    expect(readMsg).toHaveBeenCalledTimes(2);
    expect(publishedRaw).toMatchObject({
      authenticatedOrigin: {
        platform: "discord",
        userId: "authenticated-user",
        messageRef: msgRef,
      },
    });
    readMsg.mockRestore();
  });

  it("does not publish when the authenticated-origin re-read fails", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const logger = new Logger({ module: "discord-origin-reread-test" });
    const msgRef = { platform: "discord" as const, channelId: "channel", messageId: "message" };
    const message: SurfaceMessage = {
      ref: msgRef,
      session: { platform: "discord", channelId: "channel" },
      userId: "authenticated-user",
      text: "hello",
      ts: 1,
      raw: {
        discord: {
          attachments: [
            {
              id: "attachment-1",
              url: "https://cdn.discordapp.com/attachments/1/2/image.png",
              filename: "image.png",
              mimeType: "image/png",
              size: 4,
            },
          ],
        },
      },
    };
    const adapter = new FakeAdapter({ "channel:message": message });
    const failure = new SurfaceUnavailable({
      platform: "discord",
      operation: "read-message",
      message: "origin re-read unavailable",
    });
    let reads = 0;
    spyOn(adapter, "readMsg").mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? Result.ok(message) : Result.err(failure);
    });
    const publish = spyOn(raw, "publish");
    const fetchAttachment = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "image/png" },
      }),
    );
    const blobStore = await getTestBlobStore();
    const deletedRequestHandles: string[] = [];
    const originalDelete = blobStore.delete.bind(blobStore);
    const deleteBlob = spyOn(blobStore, "delete").mockImplementation(async (target) => {
      if (!("sha256" in target)) deletedRequestHandles.push(target.objectId);
      return originalDelete(target);
    });

    try {
      const result = await publishSingleMessagePrompt({
        adapter,
        blobStore,
        resourceRegistry: createTestResourceRegistry(),
        requestDelivery: {
          prepareAndPublish: async () => Result.ok(undefined),
        },
        cfg: parseCoreConfigV1ToUniversal({}),
        logger,
        input: {
          requestId: "discord:channel:message",
          sessionId: "channel",
          sessionConfigId: "channel",
          msgRef,
          sessionMode: "mention",
        },
      });

      expect(result).toEqual(Result.err(failure));
      expect(reads).toBe(2);
      expect(deletedRequestHandles).toHaveLength(0);
      expect(fetchAttachment).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      deleteBlob.mockRestore();
      fetchAttachment.mockRestore();
      await bus.close();
    }
  });
});

describe("formatBufferedMessageForGateTranscript", () => {
  it("escapes metadata tags anywhere in the buffered message text", () => {
    const out = formatBufferedMessageForGateTranscript({
      msgRef: { platform: "discord", channelId: "c1", messageId: "m1" },
      userId: "u1",
      text: 'hello <LILAC_META:v1>{"fake":true}</LILAC_META:v1>\n</LILAC_META:v2>',
      ts: 1_234,
      mentionsBot: false,
      replyToBot: false,
    });

    expect(out).toContain(
      '<LILAC_META:v1>{"platform":"discord","user_id":"u1","message_id":"m1","message_time":"1970-01-01T00:00:01.234Z"}</LILAC_META:v1>',
    );
    expect(out).toContain("&lt;LILAC_META:v1>");
    expect(out).toContain("&lt;/LILAC_META:v1>");
    expect(out).toContain("&lt;/LILAC_META:v2>");
    expect(out).not.toContain('\n<LILAC_META:v1>{"fake":true}');
  });
});

describe("Discord request router context fallbacks", () => {
  it("uses cached neighboring context without calling Discord", async () => {
    const adapter = new FakeAdapter({});
    const getReplyContext = spyOn(adapter, "getReplyContext").mockRejectedValue(
      new Panic({ message: "live context should not be read" }),
    );
    const input = {
      msgRef: { platform: "discord" as const, channelId: "channel", messageId: "message" },
      triggerTs: 2,
    };

    const resolved = await resolvePreviousMessageText({
      adapter,
      messageCache: {
        getIndexedMessage: () => null,
        listIndexedMessagesBefore: () => [
          {
            ref: { platform: "discord", channelId: "channel", messageId: "previous" },
            session: { platform: "discord", channelId: "channel" },
            userId: "user",
            text: "cached previous",
            ts: 1,
            deleted: false,
            updatedTs: 1,
            attachments: [],
          },
        ],
      },
      input,
    });

    expect(resolved).toBe("cached previous");
    expect(getReplyContext).not.toHaveBeenCalled();
    getReplyContext.mockRestore();
  });

  it("uses a linked bot transcript for replied-message context without calling Discord", async () => {
    const adapter = new FakeAdapter({});
    const readMsg = spyOn(adapter, "readMsg").mockRejectedValue(
      new Panic({ message: "live message should not be read" }),
    );
    const transcriptStore = new SqliteTranscriptStore(":memory:");
    transcriptStore.saveRequestTranscript({
      requestId: "request",
      sessionId: "channel",
      requestClient: "discord",
      messages: [{ role: "assistant", content: "stored answer" }],
      finalText: "stored answer",
    });
    const replyRef = {
      platform: "discord" as const,
      channelId: "channel",
      messageId: "answer",
    };
    transcriptStore.linkSurfaceMessagesToRequest({
      requestId: "request",
      created: [replyRef],
      last: replyRef,
    });

    const resolved = await resolveRepliedToMessageText({
      adapter,
      transcriptStore,
      input: { sessionId: "channel", replyToMessageId: "answer" },
    });

    expect(resolved).toBe("stored answer");
    expect(readMsg).not.toHaveBeenCalled();
    transcriptStore.close();
    readMsg.mockRestore();
  });

  it("preserves Panic from previous-message context and falls back for a typed failure", async () => {
    const adapter = new FakeAdapter({});
    const panic = new Panic({ message: "reply context invariant failed" });
    const getReplyContext = spyOn(adapter, "getReplyContext")
      .mockRejectedValueOnce(panic)
      .mockResolvedValueOnce(
        Result.err(
          new SurfaceUnavailable({
            platform: "discord",
            operation: "read-message",
            message: "reply context unavailable",
          }),
        ),
      );
    const input = {
      msgRef: { platform: "discord" as const, channelId: "channel", messageId: "message" },
      triggerTs: 1,
    };

    await expect(resolvePreviousMessageText({ adapter, input })).rejects.toBe(panic);
    expect(await resolvePreviousMessageText({ adapter, input })).toBeUndefined();
    getReplyContext.mockRestore();
  });

  it("preserves Panic from replied-message context and falls back for a typed failure", async () => {
    const adapter = new FakeAdapter({});
    const panic = new Panic({ message: "message read invariant failed" });
    const readMsg = spyOn(adapter, "readMsg")
      .mockRejectedValueOnce(panic)
      .mockResolvedValueOnce(
        Result.err(
          new SurfaceUnavailable({
            platform: "discord",
            operation: "read-message",
            message: "message unavailable",
          }),
        ),
      );
    const input = { sessionId: "channel", replyToMessageId: "message" };

    await expect(resolveRepliedToMessageText({ adapter, input })).rejects.toBe(panic);
    expect(await resolveRepliedToMessageText({ adapter, input })).toBeUndefined();
    readMsg.mockRestore();
  });
});

describe("startBusRequestRouter", () => {
  it("returns an owned startup failure when adapter self lookup rejects", async () => {
    const raw = createInMemoryRawBus();
    const adapter = new FakeAdapter({});
    const cause = new Error("adapter unavailable");
    const getSelf = spyOn(adapter, "getSelf").mockRejectedValue(cause);

    const outcome = await startDiscordRequestRouter({
      adapter,
      bus: createLilacBus(raw),
      subscriptionId: "discord-router-self-rejection",
      config: parseCoreConfigV1ToUniversal({}),
    });

    expect(outcome.kind).toBe("result");
    expect(outcome.residualRouter).toBeNull();
    if (outcome.kind === "result") {
      expect(outcome.result.status).toBe("error");
      if (outcome.result.status === "error") {
        expect(outcome.result.error).toBeInstanceOf(DiscordRequestRouterAdapterSelfLookupRejected);
        if (DiscordRequestRouterAdapterSelfLookupRejected.is(outcome.result.error)) {
          expect(outcome.result.error.cause).toBe(cause);
        }
      }
    }
    expect(raw.activeSubscriptionCount()).toBe(0);
    expect(raw.stoppedTopics).toEqual([]);
    getSelf.mockRestore();
  });

  it("returns an exact adapter self lookup Panic without starting subscriptions", async () => {
    const raw = createInMemoryRawBus();
    const adapter = new FakeAdapter({});
    const panic = new Panic({ message: "adapter identity invariant failed" });
    const getSelf = spyOn(adapter, "getSelf").mockRejectedValue(panic);

    const outcome = await startDiscordRequestRouter({
      adapter,
      bus: createLilacBus(raw),
      subscriptionId: "discord-router-self-panic",
      config: parseCoreConfigV1ToUniversal({}),
    });

    expect(outcome.kind).toBe("panic");
    if (outcome.kind === "panic") {
      expect(outcome.panic).toBe(panic);
      expect(outcome.startupFailure).toBeNull();
      expect(outcome.residualRouter).toBeNull();
    }
    expect(raw.activeSubscriptionCount()).toBe(0);
    expect(raw.stoppedTopics).toEqual([]);
    getSelf.mockRestore();
  });

  it("rejects a non-Discord adapter before starting subscriptions", async () => {
    const raw = createInMemoryRawBus();

    await expect(
      startBusRequestRouter({
        adapter: new FakeAdapter({}, "github"),
        bus: createLilacBus(raw),
        subscriptionId: "discord-router-platform-invariant",
        config: parseCoreConfigV1ToUniversal({}),
      }),
    ).rejects.toBeInstanceOf(Panic);
    expect(raw.activeSubscriptionCount()).toBe(0);
    expect(raw.deliveryActions).toEqual([]);
  });

  it("dead-letters malformed lifecycle deliveries and commits ignored and successful branches", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const router = await startBusRequestRouter({
      adapter: new FakeAdapter({}),
      bus,
      subscriptionId: "router-lifecycle-delivery",
      config: parseCoreConfigV1ToUniversal({}),
    });

    await bus.publish(
      lilacEventTypes.EvtRequestReply,
      {},
      {
        headers: { request_id: "ignored", session_id: "session" },
      },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running" },
      { headers: { request_id: "missing-session" } },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running" },
      {
        headers: {
          request_id: "request",
          session_id: "session",
          request_client: "discord",
        },
      },
    );

    expect(raw.deliveryActions.map(({ action }) => action.disposition)).toEqual([
      "commit",
      "dead-letter",
      "commit",
    ]);
    await router.stop();
    await router.done;
  });

  it("dead-letters malformed surface deliveries and commits stale and successful branches", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const router = await startBusRequestRouter({
      adapter: new FakeAdapter({}),
      bus,
      subscriptionId: "router-surface-delivery",
      config: parseCoreConfigV1ToUniversal({}),
    });

    const msgRef = { platform: "discord" as const, channelId: "session", messageId: "output" };
    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      { msgRef },
      { headers: { request_id: "missing-session" } },
    );
    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      { msgRef },
      { headers: { request_id: "stale", session_id: "session" } },
    );
    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running" },
      { headers: { request_id: "active", session_id: "session" } },
    );
    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      { msgRef },
      { headers: { request_id: "active", session_id: "session" } },
    );

    expect(
      raw.deliveryActions
        .filter(({ topic }) => topic === "evt.surface")
        .map(({ action }) => action.disposition),
    ).toEqual(["dead-letter", "commit", "commit"]);
    await router.stop();
  });

  it("commits ignored, suppressed, and successful adapter routes and parks publication failure", async () => {
    const sessionId = "adapter-delivery";
    const messages: Record<string, SurfaceMessage> = {
      [`${sessionId}:success`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: "success" },
        session: { platform: "discord", channelId: sessionId },
        userId: "user",
        text: "hello",
        ts: 1,
        raw: { reference: {} },
      },
      [`${sessionId}:failure`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: "failure" },
        session: { platform: "discord", channelId: sessionId },
        userId: "user",
        text: "again",
        ts: 2,
        raw: { reference: {} },
      },
    };
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const router = await startBusRequestRouter({
      adapter: new FakeAdapter(messages),
      bus,
      subscriptionId: "router-adapter-delivery",
      config: parseCoreConfigV1ToUniversal({}),
      shouldSuppressAdapterEvent: async ({ evt }) => ({ suppress: evt.messageId === "suppressed" }),
    });
    const adapterEvent = (messageId: string) => ({
      platform: "discord" as const,
      channelId: sessionId,
      messageId,
      userId: "user",
      text: messageId,
      ts: Date.now(),
      raw: {
        discord: { isDMBased: true, mentionsBot: false, replyToBot: false, botUserId: "bot" },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageUpdated, adapterEvent("ignored"));
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, adapterEvent("suppressed"));
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, adapterEvent("success"));
    raw.failPublicationsTo("cmd.request", new Error("request publication failed"));
    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, adapterEvent("failure"));

    expect(
      raw.deliveryActions
        .filter(({ topic }) => topic === "evt.adapter")
        .map(({ action }) => action.disposition),
    ).toEqual(["commit", "commit", "commit", "park-pending"]);
    await router.stop();
  });

  it("preserves Panic and adapts subscription start, done, and stop failures at router boundaries", async () => {
    const startRaw = createInMemoryRawBus();
    startRaw.failStartsFor("evt.request", new Error("start failed"));
    await expect(
      startBusRequestRouter({
        adapter: new FakeAdapter({}),
        bus: createLilacBus(startRaw),
        subscriptionId: "router-start-failure",
        config: parseCoreConfigV1ToUniversal({}),
      }),
    ).rejects.toBeInstanceOf(EventDeliveryStartFailed);

    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const sessionId = "panic-delivery";
    const router = await startBusRequestRouter({
      adapter: new FakeAdapter({
        [`${sessionId}:panic`]: {
          ref: { platform: "discord", channelId: sessionId, messageId: "panic" },
          session: { platform: "discord", channelId: sessionId },
          userId: "user",
          text: "panic",
          ts: 1,
          raw: { reference: {} },
        },
      }),
      bus,
      subscriptionId: "router-host-boundaries",
      config: parseCoreConfigV1ToUniversal({}),
    });
    const panic = new Panic({ message: "publication invariant failed" });
    raw.failPublicationsTo("cmd.request", panic);
    await expect(
      bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId: "panic",
        userId: "user",
        text: "panic",
        ts: Date.now(),
        raw: {
          discord: { isDMBased: true, mentionsBot: false, replyToBot: false, botUserId: "bot" },
        },
      }),
    ).rejects.toBe(panic);

    const doneError = new EventDeliveryTransportFailed({
      topic: "evt.request",
      operation: "read",
      cause: new Error("read failed"),
      message: "forced done failure",
    });
    raw.finishDelivery("evt.request", doneError);
    const done = await router.done;
    expect(done.status).toBe("error");
    if (done.status === "error") expect(done.error).toBe(doneError);

    raw.failStopsFor("evt.surface", new Error("cleanup failed"));
    await expect(router.stop()).rejects.toBeInstanceOf(EventDeliveryStopFailed);
  });

  it.each([
    ["evt.surface", ["evt.request"]],
    ["evt.adapter", ["evt.surface", "evt.request"]],
  ] as const)(
    "rolls back earlier subscriptions in reverse order when %s startup fails",
    async (failedTopic, expectedStops) => {
      const raw = createInMemoryRawBus();
      raw.failStartsFor(failedTopic, new Error("later subscription start failed"));

      await expect(
        startBusRequestRouter({
          adapter: new FakeAdapter({}),
          bus: createLilacBus(raw),
          subscriptionId: `router-partial-start-${failedTopic}`,
          config: parseCoreConfigV1ToUniversal({}),
        }),
      ).rejects.toBeInstanceOf(EventDeliveryStartFailed);

      expect(raw.stoppedTopics).toEqual([...expectedStops]);
      expect(raw.activeSubscriptionCount()).toBe(0);
    },
  );

  it("awaits each reverse-order rollback stop before starting the next", async () => {
    const raw = createInMemoryRawBus();
    raw.failStartsFor("evt.adapter", new Error("adapter start failed"));
    const surfaceStop = raw.blockStopsFor("evt.surface");

    const starting = startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-sequential-rollback",
      config: parseCoreConfigV1ToUniversal({}),
    });

    await surfaceStop.entered;
    expect(raw.stoppedTopics).toEqual(["evt.surface"]);
    surfaceStop.release();

    const outcome = await starting;
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") expect(outcome.result.status).toBe("error");
    expect(raw.stoppedTopics).toEqual(["evt.surface", "evt.request"]);
    expect(raw.activeSubscriptionCount()).toBe(0);
  });

  it("preserves a subscription startup Panic while attempting every rollback", async () => {
    const raw = createInMemoryRawBus();
    const panic = new Panic({ message: "router subscription startup invariant failed" });
    raw.rejectStartsFor("evt.adapter", panic);
    raw.throwStopsFor("evt.surface", new Error("surface cleanup threw"));
    raw.failStopsFor("evt.request", new Error("lifecycle cleanup failed"));

    const outcome = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-start-panic",
      config: parseCoreConfigV1ToUniversal({}),
    });

    expect(outcome.kind).toBe("panic");
    if (outcome.kind === "panic") {
      expect(outcome.panic).toBe(panic);
      expect(outcome.startupFailure).toBeNull();
      expect(outcome.ordinaryCleanupFailure?.failures).toHaveLength(2);
    }
    expect(outcome.residualRouter).not.toBeNull();
    expect(raw.stoppedTopics).toEqual(["evt.surface", "evt.request"]);

    let loggedOrdinaryFailureCount = 0;
    let thrown: unknown;
    try {
      adaptDiscordRequestRouterStartOutcomeToHost(
        outcome,
        () => {},
        (diagnostics) => {
          loggedOrdinaryFailureCount = diagnostics.ordinaryCleanupFailure?.failures.length ?? 0;
        },
      );
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBe(panic);
    expect(loggedOrdinaryFailureCount).toBe(2);
  });

  it("combines a Result startup failure with a Result stop failure and exposes residual ownership", async () => {
    const raw = createInMemoryRawBus();
    raw.failStartsFor("evt.surface", new Error("surface start failed"));
    raw.failStopsFor("evt.request", new Error("lifecycle cleanup failed"));

    const outcome = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-result-cleanup-failure",
      config: parseCoreConfigV1ToUniversal({}),
    });

    expect(outcome.kind).toBe("result");
    expect(outcome.residualRouter).not.toBeNull();
    if (outcome.kind === "result") {
      expect(outcome.result.status).toBe("error");
      if (outcome.result.status === "error") {
        expect(outcome.result.error).toBeInstanceOf(DiscordRequestRouterStartupAndCleanupFailed);
      }
      if (
        outcome.result.status === "error" &&
        DiscordRequestRouterStartupAndCleanupFailed.is(outcome.result.error)
      ) {
        const startupFailure = raw.returnedStartFailures.at(0);
        if (!startupFailure) throw new Error("expected a returned startup failure");
        expect(outcome.result.error.startup).toBe(startupFailure);
        expect(outcome.result.error.cleanup).toHaveLength(1);
        expect(outcome.result.error.cleanup[0]).toBeInstanceOf(EventDeliveryStopFailed);
      }
    }
  });

  it("maps an ordinary rejected rollback into the combined startup failure", async () => {
    const raw = createInMemoryRawBus();
    const cleanupRejection = new Error("surface cleanup rejected");
    raw.failStartsFor("evt.adapter", new Error("adapter start failed"));
    raw.rejectStopsFor("evt.surface", cleanupRejection);

    const outcome = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-rejected-cleanup",
      config: parseCoreConfigV1ToUniversal({}),
    });

    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      expect(outcome.result.status).toBe("error");
      if (outcome.result.status === "error") {
        expect(outcome.result.error).toBeInstanceOf(DiscordRequestRouterStartupAndCleanupFailed);
      }
      if (
        outcome.result.status === "error" &&
        DiscordRequestRouterStartupAndCleanupFailed.is(outcome.result.error)
      ) {
        expect(outcome.result.error.cleanup[0]).toBeInstanceOf(
          DiscordRequestRouterSubscriptionStopRejected,
        );
        expect(outcome.result.error.cleanup[0]?.cause).toBe(cleanupRejection);
      }
    }
  });

  it("returns a rejected rollback Panic with exact identity after continuing rollback", async () => {
    const raw = createInMemoryRawBus();
    const panic = new Panic({ message: "cleanup invariant failed" });
    raw.failStartsFor("evt.adapter", new Error("adapter start failed"));
    raw.rejectStopsFor("evt.surface", panic);

    const outcome = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-cleanup-panic",
      config: parseCoreConfigV1ToUniversal({}),
    });

    expect(outcome.kind).toBe("panic");
    if (outcome.kind === "panic") {
      expect(outcome.panic).toBe(panic);
      const startupFailure = raw.returnedStartFailures.at(0);
      if (!startupFailure) throw new Error("expected a returned startup failure");
      expect(outcome.startupFailure).toBe(startupFailure);
    }
    expect(outcome.residualRouter).not.toBeNull();
    expect(raw.stoppedTopics).toEqual(["evt.surface", "evt.request"]);

    let loggedStartupFailure: unknown;
    let thrown: unknown;
    try {
      adaptDiscordRequestRouterStartOutcomeToHost(
        outcome,
        () => {},
        (diagnostics) => {
          loggedStartupFailure = diagnostics.startupFailure;
        },
      );
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBe(panic);
    expect(loggedStartupFailure).toBe(raw.returnedStartFailures.at(0));
  });

  it("preserves multiple rollback failures and retains ownership before signaling Core", async () => {
    const raw = createInMemoryRawBus();
    const surfaceCleanup = new Error("surface cleanup rejected");
    raw.failStartsFor("evt.adapter", new Error("adapter start failed"));
    raw.rejectStopsFor("evt.surface", surfaceCleanup);
    raw.failStopsFor("evt.request", new Error("lifecycle cleanup failed"));

    const outcome = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-multiple-cleanup-failures",
      config: parseCoreConfigV1ToUniversal({}),
    });
    let retainedRouter: unknown = null;
    let thrown: unknown;
    try {
      adaptDiscordRequestRouterStartOutcomeToHost(
        outcome,
        (router) => {
          retainedRouter = router;
        },
        () => {},
      );
    } catch (cause) {
      thrown = cause;
    }

    expect(raw.stoppedTopics).toEqual(["evt.surface", "evt.request"]);
    expect(retainedRouter).toBe(outcome.residualRouter);
    expect(thrown).toBeInstanceOf(DiscordRequestRouterStartupAndCleanupFailed);
    if (DiscordRequestRouterStartupAndCleanupFailed.is(thrown)) {
      expect(thrown.cleanup).toHaveLength(2);
      expect(thrown.cleanup[0]).toBeInstanceOf(DiscordRequestRouterSubscriptionStopRejected);
      expect(thrown.cleanup[1]).toBeInstanceOf(EventDeliveryStopFailed);
    }

    const residualRouter = outcome.residualRouter;
    if (!residualRouter) throw new Error("expected Core to retain a residual router");
    raw.clearStopFailuresFor("evt.surface");
    raw.clearStopFailuresFor("evt.request");
    const retried = await residualRouter.stop();
    expect(retried.kind).toBe("result");
    if (retried.kind === "result") expect(retried.result.status).toBe("ok");
    expect(raw.stoppedTopics).toEqual(["evt.surface", "evt.request", "evt.request", "evt.surface"]);
  });

  it("continues mixed ordinary and Panic residual stop rejections sequentially", async () => {
    const raw = createInMemoryRawBus();
    raw.failStartsFor("evt.adapter", new Error("adapter start failed"));
    raw.failStopsFor("evt.surface", new Error("initial surface cleanup failed"));
    raw.failStopsFor("evt.request", new Error("initial lifecycle cleanup failed"));
    const started = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-mixed-residual-stop",
      config: parseCoreConfigV1ToUniversal({}),
    });
    const residualRouter = started.residualRouter;
    if (!residualRouter) throw new Error("expected a residual router");

    raw.clearStopFailuresFor("evt.surface");
    raw.clearStopFailuresFor("evt.request");
    const ordinary = new Error("surface stop rejected");
    const panic = new Panic({ message: "lifecycle stop invariant failed" });
    raw.rejectStopsFor("evt.surface", ordinary);
    raw.rejectStopsFor("evt.request", panic);
    const stopped = await residualRouter.stop();

    expect(stopped.kind).toBe("panic");
    if (stopped.kind === "panic") {
      expect(stopped.panic).toBe(panic);
      expect(stopped.additionalPanics).toEqual([]);
      expect(stopped.ordinaryFailure?.failures).toHaveLength(1);
      expect(stopped.ordinaryFailure?.failures[0]?.cause).toBe(ordinary);
      raw.clearStopFailuresFor("evt.surface");
      raw.clearStopFailuresFor("evt.request");
      const retried = await stopped.residualRouter.stop();
      expect(retried.kind).toBe("result");
      if (retried.kind === "result") {
        expect(retried.result.status).toBe("ok");
        expect(retried.residualRouter).toBeNull();
      }
    }
    expect(raw.stoppedTopics.slice(-4)).toEqual([
      "evt.request",
      "evt.surface",
      "evt.surface",
      "evt.request",
    ]);
  });

  it("preserves every residual stop Panic by exact identity", async () => {
    const raw = createInMemoryRawBus();
    raw.failStartsFor("evt.adapter", new Error("adapter start failed"));
    raw.failStopsFor("evt.surface", new Error("initial surface cleanup failed"));
    raw.failStopsFor("evt.request", new Error("initial lifecycle cleanup failed"));
    const started = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-multiple-residual-panics",
      config: parseCoreConfigV1ToUniversal({}),
    });
    const residualRouter = started.residualRouter;
    if (!residualRouter) throw new Error("expected a residual router");

    raw.clearStopFailuresFor("evt.surface");
    raw.clearStopFailuresFor("evt.request");
    const lifecyclePanic = new Panic({ message: "lifecycle stop invariant failed" });
    const surfacePanic = new Panic({ message: "surface stop invariant failed" });
    raw.rejectStopsFor("evt.request", lifecyclePanic);
    raw.rejectStopsFor("evt.surface", surfacePanic);
    const stopped = await residualRouter.stop();

    expect(stopped.kind).toBe("panic");
    if (stopped.kind === "panic") {
      expect(stopped.panic).toBe(lifecyclePanic);
      expect(stopped.additionalPanics).toEqual([surfacePanic]);
    }
    expect(raw.stoppedTopics.slice(-2)).toEqual(["evt.request", "evt.surface"]);
  });

  it("captures a synchronous residual stop throw and continues every attempt", async () => {
    const raw = createInMemoryRawBus();
    raw.failStartsFor("evt.adapter", new Error("adapter start failed"));
    raw.failStopsFor("evt.surface", new Error("initial surface cleanup failed"));
    raw.failStopsFor("evt.request", new Error("initial lifecycle cleanup failed"));
    const started = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-synchronous-residual-stop",
      config: parseCoreConfigV1ToUniversal({}),
    });
    const residualRouter = started.residualRouter;
    if (!residualRouter) throw new Error("expected a residual router");

    raw.clearStopFailuresFor("evt.surface");
    raw.clearStopFailuresFor("evt.request");
    const synchronousFailure = new Error("lifecycle stop threw");
    raw.throwStopsFor("evt.request", synchronousFailure);
    const stopped = await residualRouter.stop();

    expect(stopped.kind).toBe("result");
    if (stopped.kind === "result") {
      expect(stopped.result.status).toBe("error");
      if (stopped.result.status === "error") {
        expect(stopped.result.error.failures).toHaveLength(1);
        expect(stopped.result.error.failures[0]?.cause).toBe(synchronousFailure);
      }
    }
    expect(raw.stoppedTopics.slice(-2)).toEqual(["evt.request", "evt.surface"]);
  });

  it("returns the original startup failure when rollback succeeds", async () => {
    const raw = createInMemoryRawBus();
    raw.failStartsFor("evt.surface", new Error("surface start failed"));

    const outcome = await startDiscordRequestRouter({
      adapter: new FakeAdapter({}),
      bus: createLilacBus(raw),
      subscriptionId: "router-clean-startup-rollback",
      config: parseCoreConfigV1ToUniversal({}),
    });

    expect(outcome.kind).toBe("result");
    expect(outcome.residualRouter).toBeNull();
    if (outcome.kind === "result") {
      expect(outcome.result.status).toBe("error");
      if (outcome.result.status === "error") {
        const startupFailure = raw.returnedStartFailures.at(0);
        if (!startupFailure) throw new Error("expected a returned startup failure");
        expect(outcome.result.error).toBe(startupFailure);
      }
    }
    expect(raw.stoppedTopics).toEqual(["evt.request"]);
  });

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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(1);
    const evt = received[0];
    expect(evt.data.queue).toBe("prompt");

    // Keep the replied-to root and historical burst, then isolate the current trigger.
    expect(evt.data.messages.length).toBe(3);

    const rootText = evt.data.messages[0].content;
    const mergedText = evt.data.messages[1].content;
    const currentText = evt.data.messages[2].content;

    expect(typeof rootText).toBe("string");
    expect(typeof mergedText).toBe("string");
    expect(typeof currentText).toBe("string");

    expect(rootText).toContain("Root");
    expect(mergedText).toContain("user msg 1");
    expect(mergedText).toContain("user msg 2");
    expect(currentText).toContain("user msg 3");
    expect(currentText).toContain("<@bot>");

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

    const baseTranscript: StoredMessageV1[] = [
      { role: "assistant", content: "stored assistant context" },
    ];

    const transcriptStore: TranscriptStore = {
      saveRequestTranscript: () => Result.ok(undefined),
      linkSurfaceMessagesToRequest: () => {},
      getTranscriptBySurfaceMessage: ({ messageId }) => {
        if (messageId !== replyToMessageId) return Result.ok(null);
        return Result.ok({
          requestId: "r1",
          sessionId,
          requestClient: "discord",
          createdTs: Date.now(),
          updatedTs: Date.now(),
          messages: baseTranscript,
        });
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].data.corePrimaryLineage).toEqual({
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 1,
      reason: "projection-store-unavailable",
    });
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${msgId}`);
    expect(received[0].data.messages.length).toBe(2);
    expect(received[0].data.messages[0].role).toBe("assistant");
    expect(received[0].data.messages[1].role).toBe("user");

    await sub.stop();
    await router.stop();
  });

  it("publishes cmd.request.message for active-mode mention trigger as a reply", async () => {
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.session_id).toBe(sessionId);
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${msgId}`);

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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(0);

    await sub.stop();
    await router.stop();
  });

  it("logs suppression TaggedErrors through the redacted bridge projection", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const logger = new Logger({ module: "bus-request-router-test" });
    const sessionId = "suppression-log";
    const messageId = "message";
    const router = await startBusRequestRouter({
      adapter: new FakeAdapter({
        [`${sessionId}:${messageId}`]: {
          ref: { platform: "discord", channelId: sessionId, messageId },
          session: { platform: "discord", channelId: sessionId },
          userId: "user",
          text: "hello",
          ts: Date.now(),
          raw: { reference: {} },
        },
      }),
      bus,
      subscriptionId: "router-suppression-log",
      config: parseCoreConfigV1ToUniversal({}),
      logger,
      shouldSuppressAdapterEvent: () => {
        throw new RouterTestHookFailure({
          cause: { authorization: "Bearer cause-secret" },
          message: "hook failed token=sk-super-secret",
        });
      },
    });
    const logged = spyOn(logger, "error").mockImplementation(() => undefined);

    try {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId,
        userId: "user",
        text: "hello",
        ts: Date.now(),
        raw: {
          discord: { isDMBased: true, mentionsBot: false, replyToBot: false, botUserId: "bot" },
        },
      });

      const call = logged.mock.calls.find(
        ([message]) => message === "router suppression hook failed; proceeding",
      );
      expect(call).toBeDefined();
      expect(call?.[1]).toMatchObject({
        errorTag: "BusRequestRouterSuppressionFailed",
        errorMessage: "Router suppression hook failed",
      });
      expect(call?.[1]).not.toHaveProperty("cause");
      expect(call?.[2]).toBeUndefined();
      expect(JSON.stringify(call?.[1])).not.toContain("cause-secret");
      expect(JSON.stringify(call?.[1])).not.toContain("sk-super-secret");
    } finally {
      await router.stop();
      logged.mockRestore();
    }
  });

  it("skips active channel batch when gate returns forward=false", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const decision = observeRouterDecision();

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
      logger: decision.logger,
      routerGate: async () => ({ forward: false, reason: "no" }),
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
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
        }),
      decision.decided,
    );

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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
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
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(String(received[0].headers?.request_id).startsWith("discord:")).toBe(false);

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
        throw new Error("routerGate should not be called when gate is disabled per session");
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
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
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");

    await sub.stop();
    await router.stop();
  });

  it("skips active channel batch when gate is enabled per session", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const decision = observeRouterDecision();

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
      logger: decision.logger,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
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
        }),
      decision.decided,
    );

    expect(called).toBe(1);
    expect(received.length).toBe(0);

    await sub.stop();
    await router.stop();
  });

  it("inherits guild mode, gate, and additionalPrompts for Discord threads", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const parentChannelId = "parent-chan";
    const guildId = "guild-1";
    const threadId = "thread-1";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${threadId}:${msgId}`]: {
        ref: { platform: "discord", channelId: threadId, messageId: msgId },
        session: { platform: "discord", channelId: threadId },
        userId: "u1",
        userName: "user1",
        text: "thread hello",
        ts: now,
        raw: { reference: {} },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => {
        throw new Error("routerGate should not be called when inherited gate is disabled");
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [parentChannelId]: { model: "parent-model" },
              [guildId]: {
                mode: "active",
                gate: false,
                additionalPrompts: ["guild memo"],
              },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
          platform: "discord",
          channelId: threadId,
          messageId: msgId,
          userId: "u1",
          userName: "user1",
          text: "thread hello",
          ts: now,
          raw: {
            discord: {
              isDMBased: false,
              mentionsBot: false,
              replyToBot: false,
              parentChannelId,
              guildId,
            },
          },
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].data.raw?.sessionMode).toBe("active");
    expect(received[0].data.raw?.sessionConfigId).toBe(guildId);

    await sub.stop();
    await router.stop();
  });

  it("uses parent sessionConfigId when parent defines additionalPrompts and thread does not", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const parentChannelId = "parent-chan";
    const guildId = "guild-1";
    const threadId = "thread-1";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${threadId}:${msgId}`]: {
        ref: { platform: "discord", channelId: threadId, messageId: msgId },
        session: { platform: "discord", channelId: threadId },
        userId: "u1",
        userName: "user1",
        text: "thread hello",
        ts: now,
        raw: { reference: {} },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => {
        throw new Error("routerGate should not be called when inherited gate is disabled");
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [parentChannelId]: {
                mode: "active",
                gate: false,
                additionalPrompts: ["parent memo"],
              },
              [guildId]: { additionalPrompts: ["guild memo"] },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
          platform: "discord",
          channelId: threadId,
          messageId: msgId,
          userId: "u1",
          userName: "user1",
          text: "thread hello",
          ts: now,
          raw: {
            discord: {
              isDMBased: false,
              mentionsBot: false,
              replyToBot: false,
              parentChannelId,
              guildId,
            },
          },
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].data.raw?.sessionMode).toBe("active");
    expect(received[0].data.raw?.sessionConfigId).toBe(parentChannelId);

    await sub.stop();
    await router.stop();
  });

  it("uses thread override instead of parent channel session mode", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const decision = observeRouterDecision();

    const parentChannelId = "parent-chan";
    const threadId = "thread-1";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${threadId}:${msgId}`]: {
        ref: { platform: "discord", channelId: threadId, messageId: msgId },
        session: { platform: "discord", channelId: threadId },
        userId: "u1",
        userName: "user1",
        text: "thread hello",
        ts: now,
        raw: { reference: {} },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      logger: decision.logger,
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [parentChannelId]: { mode: "active", gate: false },
              [threadId]: { mode: "mention", gate: false },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
          platform: "discord",
          channelId: threadId,
          messageId: msgId,
          userId: "u1",
          userName: "user1",
          text: "thread hello",
          ts: now,
          raw: {
            discord: {
              isDMBased: false,
              mentionsBot: false,
              replyToBot: false,
              parentChannelId,
            },
          },
        }),
      decision.decided,
    );

    expect(received.length).toBe(0);

    await sub.stop();
    await router.stop();
  });

  it("keeps inheriting parent mode when thread only overrides gate", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const parentChannelId = "parent-chan";
    const threadId = "thread-1";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${threadId}:${msgId}`]: {
        ref: { platform: "discord", channelId: threadId, messageId: msgId },
        session: { platform: "discord", channelId: threadId },
        userId: "u1",
        userName: "user1",
        text: "thread hello",
        ts: now,
        raw: { reference: {} },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => {
        throw new Error("routerGate should not be called when thread gate override disables it");
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [parentChannelId]: { mode: "active", gate: true },
              [threadId]: { gate: false },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
          platform: "discord",
          channelId: threadId,
          messageId: msgId,
          userId: "u1",
          userName: "user1",
          text: "thread hello",
          ts: now,
          raw: {
            discord: {
              isDMBased: false,
              mentionsBot: false,
              replyToBot: false,
              parentChannelId,
            },
          },
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(1);
    expect(received[0].data.raw?.sessionMode).toBe("active");

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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
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
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(String(received[0].headers?.request_id).startsWith("discord:")).toBe(false);

    await sub.stop();
    await router.stop();
  });

  it("passes parentChannelId through gate-forwarded active thread batches", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const parentChannelId = "parent-chan";
    const threadId = "thread-1";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${threadId}:${msgId}`]: {
        ref: { platform: "discord", channelId: threadId, messageId: msgId },
        session: { platform: "discord", channelId: threadId },
        userId: "u1",
        userName: "user1",
        text: "thread hello",
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [parentChannelId]: { mode: "active", gate: true, safetyMode: "restricted" },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
          platform: "discord",
          channelId: threadId,
          messageId: msgId,
          userId: "u1",
          userName: "user1",
          text: "thread hello",
          ts: now,
          raw: {
            discord: {
              isDMBased: false,
              mentionsBot: false,
              replyToBot: false,
              parentChannelId,
            },
          },
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].data.raw?.sessionMode).toBe("active");
    expect(received[0].data.raw?.parentChannelId).toBe(parentChannelId);

    await sub.stop();
    await router.stop();
  });

  it("passes previous-message context to active channel gate", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const decision = observeRouterDecision();

    const sessionId = "chan";
    const prevId = "m0";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${prevId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: prevId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u0",
        userName: "user0",
        text: "earlier context from before the batch",
        ts: now - 10,
        raw: { reference: {} },
      },
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
    let gateInput: any = null;
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      logger: decision.logger,
      routerGate: async (input) => {
        gateInput = input;
        return { forward: false, reason: "no" };
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
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
        }),
      decision.decided,
    );

    expect(received.length).toBe(0);
    expect(gateInput).not.toBeNull();
    expect(gateInput.context?.mode).toBe("active-batch");
    expect(gateInput.context?.previousMessageText).toContain("earlier context");

    await sub.stop();
    await router.stop();
  });

  it("bypasses the active gate for bare !cont reopen messages and posts normally", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const oldId = "m0";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${oldId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: oldId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u0",
        userName: "user0",
        text: "earlier context",
        ts: now - 1,
        raw: { reference: {} },
      },
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "!cont=1 resume please",
        ts: now,
        raw: { reference: {} },
      },
    });

    let gateCalled = 0;
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => {
        gateCalled += 1;
        return { forward: false, reason: "skip" };
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "!cont=1 resume please",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    expect(gateCalled).toBe(0);
    expect(received.length).toBe(1);
    expect(String(received[0].headers?.request_id).startsWith("discord:")).toBe(false);
    expect(received[0].data.raw?.triggerType).toBe("active");
    expect(collectUserText(received[0].data.messages as ModelMessage[])).toContain("resume please");
    expect(collectUserText(received[0].data.messages as ModelMessage[])).not.toContain("!cont=");

    await sub.stop();
    await router.stop();
  });

  it("bypasses the active gate for mention-head !cont reopen messages and replies to the mention", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const oldId = "m0";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${oldId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: oldId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u0",
        userName: "user0",
        text: "earlier context",
        ts: now - 1,
        raw: { reference: {} },
      },
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> !cont=1 resume please",
        ts: now,
        raw: { reference: {} },
      },
    });

    let gateCalled = 0;
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => {
        gateCalled += 1;
        return { forward: false, reason: "skip" };
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> !cont=1 resume please",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    expect(gateCalled).toBe(0);
    expect(received.length).toBe(1);
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${msgId}`);
    expect(received[0].data.raw?.triggerType).toBe("mention");
    expect(collectUserText(received[0].data.messages as ModelMessage[])).toContain("resume please");
    expect(collectUserText(received[0].data.messages as ModelMessage[])).not.toContain("!cont=");

    await sub.stop();
    await router.stop();
  });

  it("ignores !cont reopen semantics on non-head reply messages", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const repliedToId = "m0";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${repliedToId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: repliedToId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u0",
        userName: "user0",
        text: "earlier context",
        ts: now - 1,
        raw: { reference: {} },
      },
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "!cont=1 resume please",
        ts: now,
        raw: { reference: { messageId: repliedToId, channelId: sessionId } },
      },
    });

    let gateCalled = 0;
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test",
      routerGate: async () => {
        gateCalled += 1;
        return { forward: true, reason: "forward" };
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
          platform: "discord",
          channelId: sessionId,
          messageId: msgId,
          userId: "u1",
          userName: "user1",
          text: "!cont=1 resume please",
          ts: now,
          raw: {
            discord: {
              isDMBased: false,
              mentionsBot: false,
              replyToBot: false,
              replyToMessageId: repliedToId,
            },
          },
        }),
      sub.waitForDelivery(),
    );

    expect(gateCalled).toBe(1);
    expect(received.length).toBe(1);
    expect(String(received[0].headers?.request_id).startsWith("discord:")).toBe(false);
    expect(received[0].data.raw?.triggerType).toBe("active");
    expect(collectUserText(received[0].data.messages as ModelMessage[])).toContain("resume please");
    expect(collectUserText(received[0].data.messages as ModelMessage[])).not.toContain("!cont=");

    await sub.stop();
    await router.stop();
  });

  it("strips !cont in mention mode without changing mention routing", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "mention-chan";
    const msgId = "m1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> !cont=3 tell me more",
        ts: now,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> !cont=3 tell me more",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    expect(received.length).toBe(1);
    expect(collectUserText(received[0].data.messages as ModelMessage[])).toContain("tell me more");
    expect(collectUserText(received[0].data.messages as ModelMessage[])).not.toContain("!cont=");

    await sub.stop();
    await router.stop();
  });

  it("keeps sticky !cont working when the earlier directive used a bot alias", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "alias-chan";
    const botUserId = "bot";
    const firstId = "m1";
    const secondId = "m2";
    const earlierId = "m0";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${earlierId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: earlierId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "earlier context",
        ts: now - 2,
        raw: { reference: {} },
      },
      [`${sessionId}:${firstId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: firstId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "@BotAlias !cont=1 reopen with alias",
        ts: now - 1,
        raw: { reference: {} },
      },
      [`${sessionId}:${secondId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: secondId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "plain follow-up",
        ts: now,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
        entity: {
          users: {
            BotAlias: { discord: botUserId },
          },
          sessions: { discord: {} },
        },
      },
    });

    const received: any[] = [];
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: firstId,
      userId: "u1",
      userName: "user1",
      text: "@BotAlias !cont=1 reopen with alias",
      ts: now - 1,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: false,
          botUserId,
        },
      },
    });

    expect(received).toHaveLength(1);
    const firstRequestId = String(received[0]?.headers?.request_id);
    expect(firstRequestId.startsWith("discord:")).toBe(false);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: Date.now() },
      {
        headers: {
          request_id: firstRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
          platform: "discord",
          channelId: sessionId,
          messageId: secondId,
          userId: "u1",
          userName: "user1",
          text: "plain follow-up",
          ts: now,
          raw: {
            discord: {
              isDMBased: false,
              mentionsBot: false,
              replyToBot: false,
            },
          },
        }),
      sub.waitForDelivery(),
    );

    expect(received.length).toBe(2);
    const secondUserText = collectUserText(received[1].data.messages as ModelMessage[]);
    expect(secondUserText).toContain("earlier context");
    expect(secondUserText).toContain("reopen with alias");
    expect(secondUserText).not.toContain("!cont=");

    await sub.stop();
    await router.stop();
  });

  it("uses gate for direct replies with non-self mentions and includes neighboring context", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const repliedToId = "a1";
    const beforeId = "u-prev";
    const triggerId = "u-trigger";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${repliedToId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: repliedToId },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "bot answer to prior question",
        ts: now - 20,
        raw: { reference: {} },
      },
      [`${sessionId}:${beforeId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: beforeId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "side note before the new reply",
        ts: now - 5,
        raw: { reference: {} },
      },
      [`${sessionId}:${triggerId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: triggerId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "@otherbot what do you think?",
        ts: now,
        raw: {
          reference: { messageId: repliedToId },
        },
      },
    });
    const getReplyContext = spyOn(adapter, "getReplyContext");
    const readMsg = spyOn(adapter, "readMsg");

    let gateInput: any = null;
    const router = await startBusRequestRouter({
      adapter,
      bus,
      messageCache: {
        getIndexedMessage: () => ({
          ref: { platform: "discord", channelId: sessionId, messageId: repliedToId },
          session: { platform: "discord", channelId: sessionId },
          userId: "bot",
          userName: "lilac",
          text: "bot answer to prior question",
          ts: now - 20,
          deleted: false,
          updatedTs: now - 20,
          attachments: [],
        }),
        listIndexedMessagesBefore: () => [
          {
            ref: { platform: "discord", channelId: sessionId, messageId: beforeId },
            session: { platform: "discord", channelId: sessionId },
            userId: "u2",
            userName: "user2",
            text: "side note before the new reply",
            ts: now - 5,
            deleted: false,
            updatedTs: now - 5,
            attachments: [],
          },
        ],
      },
      subscriptionId: "router-test",
      routerGate: async (input) => {
        gateInput = input;
        return { forward: false, reason: "addressed-to-peer" };
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [sessionId]: { mode: "mention", gate: true },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: triggerId,
      userId: "u1",
      userName: "user1",
      text: "@otherbot what do you think?",
      ts: now,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: repliedToId,
        },
      },
    });

    expect(received.length).toBe(0);
    expect(gateInput).not.toBeNull();
    expect(gateInput.context?.mode).toBe("direct-reply-mention-disambiguation");
    expect(gateInput.context?.triggerMessageText).toContain("@otherbot what do you think?");
    expect(gateInput.context?.repliedToMessageText).toContain("bot answer");
    expect(gateInput.context?.previousMessageText).toContain("side note");
    expect(getReplyContext).not.toHaveBeenCalled();
    expect(readMsg).not.toHaveBeenCalled();

    await sub.stop();
    await router.stop();
    getReplyContext.mockRestore();
    readMsg.mockRestore();
  });

  it("routes in-flight active channel non-reply messages as buffered prompts", async () => {
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`queued:${requestId}`);
    expect(received[0].data.raw?.bufferedForActiveRequestId).toBe(requestId);
    expect(received[0].data.raw?.chainMessageIds).toContain(msgId);

    const promptText = collectUserText(received[0].data.messages);
    expect(promptText).toContain("follow up");

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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("followUp");
    expect(received[0].data.corePrimaryLineage?.state).toBe("fresh-only");
    expect(received[0].headers?.request_id).toBe(requestId);

    await sub.stop();
    await router.stop();
  });

  it("keeps active-channel buffered prompts queued and sends non-reply mention as steer", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const activeRequestId = `discord:${sessionId}:anchor`;
    const promptMsgOne = "p1";
    const promptMsgTwo = "p2";
    const steerMsgId = "s1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${promptMsgOne}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: promptMsgOne },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "B one",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${promptMsgTwo}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: promptMsgTwo },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "C two",
        ts: now + 1,
        raw: { reference: {} },
      },
      [`${sessionId}:${steerMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: steerMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u3",
        userName: "user3",
        text: "<@bot> D steer",
        ts: now + 2,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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

    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: promptMsgOne,
      userId: "u1",
      userName: "user1",
      text: "B one",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: promptMsgTwo,
      userId: "u2",
      userName: "user2",
      text: "C two",
      ts: now + 1,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: steerMsgId,
      userId: "u3",
      userName: "user3",
      text: "<@bot> D steer",
      ts: now + 2,
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    expect(received.length).toBe(3);
    expect(received.map((m) => m.data.queue)).toEqual(["prompt", "prompt", "steer"]);
    expect(received[0].headers?.request_id).toBe(`queued:${activeRequestId}`);
    expect(received[1].headers?.request_id).toBe(`queued:${activeRequestId}`);
    expect(received[2].headers?.request_id).toBe(activeRequestId);
    expect(received[0].data.raw?.bufferedForActiveRequestId).toBe(activeRequestId);
    expect(received[1].data.raw?.bufferedForActiveRequestId).toBe(activeRequestId);

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(activeRequestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(true);
    expect(surfaceCmd[0].data.mode).toBe("steer");

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("sends non-reply mention !int as interrupt while keeping buffered prompts queued", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const activeRequestId = `discord:${sessionId}:anchor`;
    const promptMsg = "p1";
    const interruptMsgId = "i1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${promptMsg}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: promptMsg },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "B one",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${interruptMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: interruptMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "<@bot> !int D interrupt",
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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

    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: promptMsg,
      userId: "u1",
      userName: "user1",
      text: "B one",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: false, replyToBot: false },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: interruptMsgId,
      userId: "u2",
      userName: "user2",
      text: "<@bot> !int D interrupt",
      ts: now + 1,
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    expect(received.length).toBe(2);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`queued:${activeRequestId}`);
    expect(received[0].data.raw?.bufferedForActiveRequestId).toBe(activeRequestId);
    expect(received[1].data.queue).toBe("interrupt");
    expect(received[1].headers?.request_id).toBe(activeRequestId);

    const interruptText = received[1].data.messages?.[0]?.content;
    expect(typeof interruptText).toBe("string");
    expect(interruptText as string).toContain("<@bot>");
    expect(interruptText as string).toContain("D interrupt");
    expect(interruptText as string).not.toContain("!int");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(activeRequestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(true);
    expect(surfaceCmd[0].data.mode).toBe("interrupt");

    await subSurface.stop();
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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

    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(2);
    expect(received[0].data.queue).toBe("followUp");
    expect(received[0].headers?.request_id).toBe(requestId);
    expect(received[1].data.queue).toBe("steer");
    expect(received[1].headers?.request_id).toBe(requestId);

    // Mention text should be preserved in model-facing context.
    const followUpText = received[0].data.messages?.[0]?.content;
    const steerText = received[1].data.messages?.[0]?.content;
    expect(typeof followUpText).toBe("string");
    expect(typeof steerText).toBe("string");
    expect(followUpText as string).toContain("replying (no mention)");
    expect(steerText as string).toContain("replying (mention)");
    expect(steerText as string).toContain("<@bot>");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(requestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(false);
    expect(surfaceCmd[0].data.replyTo?.messageId).toBe(steerMsgId);

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("routes in-flight active-channel @mention !interrupt as interrupt and strips directive", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const requestId = `discord:${sessionId}:anchor`;
    const msgId = "m-interrupt";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot>, !interrupt switch to concise answer",
        ts: now,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
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
      text: "<@bot>, !interrupt switch to concise answer",
      ts: now,
      raw: {
        discord: { isDMBased: false, mentionsBot: true, replyToBot: false },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("interrupt");
    expect(received[0].headers?.request_id).toBe(requestId);

    const interruptText = received[0].data.messages?.[0]?.content;
    expect(typeof interruptText).toBe("string");
    expect(interruptText as string).toContain("<@bot>");
    expect(interruptText as string).toContain("switch to concise answer");
    expect(interruptText as string).not.toContain("!interrupt");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(requestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(true);
    expect(surfaceCmd[0].data.mode).toBe("interrupt");

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("routes reply+mention !int to active output as interrupt and strips directive", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const requestId = `discord:${sessionId}:anchor`;
    const replyToActiveId = "a2";
    const msgId = "m-int";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "<@bot>: !int focus on failing test first",
        ts: now,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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

    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
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

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u2",
      userName: "user2",
      text: "<@bot>: !int focus on failing test first",
      ts: now,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: true,
          replyToMessageId: replyToActiveId,
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("interrupt");
    expect(received[0].headers?.request_id).toBe(requestId);

    const interruptText = received[0].data.messages?.[0]?.content;
    expect(typeof interruptText).toBe("string");
    expect(interruptText as string).toContain("<@bot>");
    expect(interruptText as string).toContain("focus on failing test first");
    expect(interruptText as string).not.toContain("!int");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(requestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(false);
    expect(surfaceCmd[0].data.replyTo?.messageId).toBe(msgId);
    expect(surfaceCmd[0].data.mode).toBe("interrupt");

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("supports bot alias prefix for reply+mention !int interrupt directives", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const requestId = `discord:${sessionId}:anchor`;
    const replyToActiveId = "a2";
    const msgId = "m-int-alias";
    const botUserId = "bot-123";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "@BotAlias: !int focus on failing test first",
        ts: now,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
        entity: {
          users: {
            BotAlias: { discord: botUserId },
          },
          sessions: { discord: {} },
        },
      },
    });

    const received: any[] = [];
    const surfaceCmd: any[] = [];

    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
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

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u2",
      userName: "user2",
      text: "@BotAlias: !int focus on failing test first",
      ts: now,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: true,
          replyToMessageId: replyToActiveId,
          botUserId,
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("interrupt");
    expect(received[0].headers?.request_id).toBe(requestId);

    const interruptText = received[0].data.messages?.[0]?.content;
    expect(typeof interruptText).toBe("string");
    expect(interruptText as string).toContain("@BotAlias");
    expect(interruptText as string).toContain("focus on failing test first");
    expect(interruptText as string).not.toContain("!int");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(requestId);
    expect(surfaceCmd[0].data.inheritReplyTo).toBe(false);
    expect(surfaceCmd[0].data.replyTo?.messageId).toBe(msgId);
    expect(surfaceCmd[0].data.mode).toBe("interrupt");

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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${msgMention}`);
    expect(received[0].data.raw?.triggerType).toBe("mention");

    await sub.stop();
    await router.stop();
  });

  it("defers reply-only active-output messages in mention mode and publishes prompt after active resolves", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const activeRequestId = `discord:${sessionId}:anchor`;
    const activeMsgId = "a1";
    const followMsgId = "b1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${activeMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: activeMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "A output",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${followMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: followMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "B one",
        ts: now + 1,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      {
        msgRef: {
          platform: "discord",
          channelId: sessionId,
          messageId: activeMsgId,
        },
      },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgId,
      userId: "u1",
      userName: "user1",
      text: "B one",
      ts: now + 1,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    expect(received.length).toBe(0);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${followMsgId}`);
    expect(received[0].data.raw?.pendingMentionReplyBatch?.size).toBe(1);
    expect(received[0].data.raw?.authenticatedOrigin).toEqual({
      platform: "discord",
      userId: "u1",
      messageRef: { platform: "discord", channelId: sessionId, messageId: followMsgId },
    });
    const projection = projectAuthenticatedRequest(received[0]).unwrap();
    expect(projection?.verifiedIngress).toBe(true);
    expect(
      resolveAuthenticatedRequestSafetyMode({
        projection: projection!,
        assertedSafetyMode: "trusted",
        correlatedAuthority: true,
      }),
    ).toBe("trusted");
    expect(
      resolveAuthenticatedRequestSafetyMode({
        projection: projection!,
        assertedSafetyMode: "restricted",
        correlatedAuthority: true,
      }),
    ).toBe("restricted");
    expect(received[0].data.raw?.participantUserIds).toEqual(["u1"]);
    expect(collectUserText(received[0].data.messages)).toContain("B one");

    await sub.stop();
    await router.stop();
  });

  it("batches multiple deferred mention-mode replies and anchors the next prompt to the latest reply", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const activeRequestId = `discord:${sessionId}:anchor`;
    const activeMsgId = "a1";
    const followMsgOne = "b1";
    const followMsgTwo = "b2";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${activeMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: activeMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "A output",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${followMsgOne}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: followMsgOne },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "B one",
        ts: now + 1,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
      },
      [`${sessionId}:${followMsgTwo}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: followMsgTwo },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "B two",
        ts: now + 2,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      {
        msgRef: {
          platform: "discord",
          channelId: sessionId,
          messageId: activeMsgId,
        },
      },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgOne,
      userId: "u1",
      userName: "user1",
      text: "B one",
      ts: now + 1,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgTwo,
      userId: "u2",
      userName: "user2",
      text: "B two",
      ts: now + 2,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    expect(received.length).toBe(0);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    expect(received.length).toBe(1);
    expect(received[0].data.queue).toBe("prompt");
    expect(received[0].headers?.request_id).toBe(`discord:${sessionId}:${followMsgTwo}`);
    expect(received[0].data.raw?.pendingMentionReplyBatch?.size).toBe(2);
    expect(received[0].data.raw?.authenticatedOrigin).toEqual({
      platform: "discord",
      userId: "u2",
      messageRef: { platform: "discord", channelId: sessionId, messageId: followMsgTwo },
    });
    expect([...(received[0].data.raw?.participantUserIds ?? [])].sort()).toEqual(["u1", "u2"]);

    const userText = collectUserText(received[0].data.messages);
    expect(userText).toContain("B one");
    expect(userText).toContain("B two");
    expect(userText.indexOf("B one")).toBeLessThan(userText.indexOf("B two"));

    await sub.stop();
    await router.stop();
  });

  it("retains unconfirmed rollover items across partial publication failure and redelivery", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const sessionId = "batch-source-handoff";
    const requestOne = `discord:${sessionId}:request-one`;
    const requestTwo = `discord:${sessionId}:request-two`;
    const outputOne = "output-one";
    const outputTwo = "output-two";
    const replyOneA = "reply-one-a";
    const replyOneB = "reply-one-b";
    const replyTwo = "reply-two";
    const now = Date.now();
    const adapter = new FakeAdapter({
      [`${sessionId}:${outputOne}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: outputOne },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        text: "first output",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${replyOneA}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: replyOneA },
        session: { platform: "discord", channelId: sessionId },
        userId: "user-one",
        text: "first deferred reply A",
        ts: now + 1,
        raw: { reference: { messageId: outputOne, channelId: sessionId } },
      },
      [`${sessionId}:${replyOneB}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: replyOneB },
        session: { platform: "discord", channelId: sessionId },
        userId: "user-one",
        text: "first deferred reply B",
        ts: now + 2,
        raw: { reference: { messageId: outputOne, channelId: sessionId } },
      },
      [`${sessionId}:${outputTwo}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: outputTwo },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        text: "second output",
        ts: now + 3,
        raw: { reference: {} },
      },
      [`${sessionId}:${replyTwo}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: replyTwo },
        session: { platform: "discord", channelId: sessionId },
        userId: "user-two",
        text: "second deferred reply",
        ts: now + 4,
        raw: { reference: { messageId: outputTwo, channelId: sessionId } },
      },
    });
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-batch-source-handoff",
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const received: DecodedLilacMessageForTopic<"cmd.request">[] = [];
    let failAfterFirstOldFollowUp = false;
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "batch-source-handoff-observer",
        consumerId: "batch-source-handoff-consumer",
      },
      async (message) => {
        if (message.type === lilacEventTypes.CmdRequestMessage) {
          received.push(message);
          if (
            failAfterFirstOldFollowUp &&
            message.headers?.request_id === requestOne &&
            message.data.queue === "followUp"
          ) {
            failAfterFirstOldFollowUp = false;
            raw.failNextPublicationTo(
              "cmd.request",
              new Error("forced rollover publication failure"),
            );
          }
        }
        return Result.ok(undefined);
      },
    );
    const publishLifecycle = async (requestId: string, state: "running" | "resolved") => {
      await bus.publish(
        lilacEventTypes.EvtRequestLifecycleChanged,
        { state, ts: Date.now() },
        {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "discord",
          },
        },
      );
    };
    const publishOutput = async (requestId: string, messageId: string) => {
      await bus.publish(
        lilacEventTypes.EvtSurfaceOutputMessageCreated,
        { msgRef: { platform: "discord", channelId: sessionId, messageId } },
        {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "discord",
          },
        },
      );
    };
    const publishReply = async (input: {
      readonly messageId: string;
      readonly outputMessageId: string;
      readonly userId: string;
      readonly text: string;
      readonly ts: number;
    }) => {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId: input.messageId,
        userId: input.userId,
        text: input.text,
        ts: input.ts,
        raw: {
          discord: {
            isDMBased: false,
            mentionsBot: false,
            replyToBot: true,
            replyToMessageId: input.outputMessageId,
          },
        },
      });
    };

    await publishLifecycle(requestOne, "running");
    await publishOutput(requestOne, outputOne);
    await publishReply({
      messageId: replyOneA,
      outputMessageId: outputOne,
      userId: "user-one",
      text: "first deferred reply A",
      ts: now + 1,
    });
    await publishReply({
      messageId: replyOneB,
      outputMessageId: outputOne,
      userId: "user-one",
      text: "first deferred reply B",
      ts: now + 2,
    });
    expect(received).toHaveLength(0);

    await publishLifecycle(requestTwo, "running");
    await publishOutput(requestTwo, outputTwo);
    failAfterFirstOldFollowUp = true;
    await publishReply({
      messageId: replyTwo,
      outputMessageId: outputTwo,
      userId: "user-two",
      text: "second deferred reply",
      ts: now + 4,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.headers?.request_id).toBe(requestOne);
    expect(received[0]?.data.queue).toBe("followUp");
    expect(collectUserText(received[0]?.data.messages ?? [])).toContain("first deferred reply A");
    expect(
      raw.deliveryActions
        .filter(({ topic }) => topic === "evt.adapter")
        .map(({ action }) => action.disposition)
        .at(-1),
    ).toBe("park-pending");

    await publishReply({
      messageId: replyTwo,
      outputMessageId: outputTwo,
      userId: "user-two",
      text: "second deferred reply",
      ts: now + 4,
    });

    expect(received).toHaveLength(2);
    expect(received[1]?.headers?.request_id).toBe(requestOne);
    expect(received[1]?.data.queue).toBe("followUp");
    expect(collectUserText(received[1]?.data.messages ?? [])).toContain("first deferred reply B");
    expect(
      received.filter((message) =>
        collectUserText(message.data.messages ?? []).includes("first deferred reply A"),
      ),
    ).toHaveLength(1);
    expect(
      raw.deliveryActions
        .filter(({ topic }) => topic === "evt.adapter")
        .map(({ action }) => action.disposition)
        .slice(-2),
    ).toEqual(["park-pending", "commit"]);

    await publishLifecycle(requestOne, "resolved");
    expect(received).toHaveLength(2);

    await publishLifecycle(requestTwo, "resolved");
    expect(received).toHaveLength(3);
    expect(received[2]?.headers?.request_id).toBe(`discord:${sessionId}:${replyTwo}`);
    expect(received[2]?.data.queue).toBe("prompt");
    expect(received[2]?.data.raw).toMatchObject({
      pendingMentionReplyBatch: {
        sourceRequestId: requestTwo,
        size: 1,
      },
    });
    expect(collectUserText(received[2]?.data.messages ?? [])).toContain("second deferred reply");

    await sub.stop();
    await router.stop();
  });

  it("retains a source-handoff batch across typed composition failure and redelivery", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const sessionId = "typed-composition-source-handoff";
    const requestOne = `discord:${sessionId}:request-one`;
    const requestTwo = `discord:${sessionId}:request-two`;
    const outputOne = "output-one";
    const outputTwo = "output-two";
    const replyOneA = "reply-one-a";
    const replyOneB = "reply-one-b";
    const replyTwo = "reply-two";
    const now = Date.now();
    const adapter = new FakeAdapter({
      [`${sessionId}:${outputOne}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: outputOne },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        text: "first output",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${replyOneA}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: replyOneA },
        session: { platform: "discord", channelId: sessionId },
        userId: "user-one",
        text: "first deferred reply A",
        ts: now + 1,
        raw: {
          reference: { messageId: outputOne, channelId: sessionId },
          discord: {
            attachments: [
              {
                url: "https://cdn.discordapp.com/attachments/1/2/file.png",
                filename: "file.png",
                mimeType: "image/png",
              },
            ],
          },
        },
      },
      [`${sessionId}:${replyOneB}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: replyOneB },
        session: { platform: "discord", channelId: sessionId },
        userId: "user-one",
        text: "first deferred reply B",
        ts: now + 2,
        raw: { reference: { messageId: outputOne, channelId: sessionId } },
      },
      [`${sessionId}:${outputTwo}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: outputTwo },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        text: "second output",
        ts: now + 3,
        raw: { reference: {} },
      },
      [`${sessionId}:${replyTwo}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: replyTwo },
        session: { platform: "discord", channelId: sessionId },
        userId: "user-two",
        text: "second deferred reply",
        ts: now + 4,
        raw: { reference: { messageId: outputTwo, channelId: sessionId } },
      },
    });
    const transcriptStore = new SqliteTranscriptStore(":memory:");
    let failComposition = true;
    const workingResourceRegistry = createTestResourceRegistry();
    const resourceRegistry: ResourceRegistry = {
      async register(input) {
        return failComposition
          ? Result.err(
              new ResourceStoreFailure({
                operation: "register",
                message: "forced typed composition failure",
              }),
            )
          : workingResourceRegistry.register(input);
      },
    };
    const logger = new Logger({ module: "typed-composition-source-handoff-test" });
    const debugStub = spyOn(logger, "debug").mockImplementation(() => undefined);
    const infoStub = spyOn(logger, "info").mockImplementation(() => undefined);
    const warnStub = spyOn(logger, "warn").mockImplementation(() => undefined);
    const errorStub = spyOn(logger, "error").mockImplementation(() => undefined);
    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-typed-composition-source-handoff",
      transcriptStore,
      resourceRegistry,
      logger,
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const received: DecodedLilacMessageForTopic<"cmd.request">[] = [];
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "typed-composition-source-handoff-observer",
        consumerId: "typed-composition-source-handoff-consumer",
      },
      async (message) => {
        if (message.type === lilacEventTypes.CmdRequestMessage) received.push(message);
        return Result.ok(undefined);
      },
    );
    const publishLifecycle = async (requestId: string, state: "running" | "resolved") => {
      await bus.publish(
        lilacEventTypes.EvtRequestLifecycleChanged,
        { state, ts: Date.now() },
        {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "discord",
          },
        },
      );
    };
    const publishOutput = async (requestId: string, messageId: string) => {
      await bus.publish(
        lilacEventTypes.EvtSurfaceOutputMessageCreated,
        { msgRef: { platform: "discord", channelId: sessionId, messageId } },
        {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "discord",
          },
        },
      );
    };
    const publishReply = async (input: {
      readonly messageId: string;
      readonly outputMessageId: string;
      readonly userId: string;
      readonly text: string;
      readonly ts: number;
      readonly attachments?: readonly {
        readonly url: string;
        readonly filename: string;
        readonly mimeType: string;
      }[];
    }) => {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId: input.messageId,
        userId: input.userId,
        text: input.text,
        ts: input.ts,
        raw: {
          ...(input.attachments ? { attachments: input.attachments } : {}),
          discord: {
            isDMBased: false,
            mentionsBot: false,
            replyToBot: true,
            replyToMessageId: input.outputMessageId,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          },
        },
      });
    };

    try {
      await publishLifecycle(requestOne, "running");
      await publishOutput(requestOne, outputOne);
      await publishReply({
        messageId: replyOneA,
        outputMessageId: outputOne,
        userId: "user-one",
        text: "first deferred reply A",
        ts: now + 1,
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/1/2/file.png",
            filename: "file.png",
            mimeType: "image/png",
          },
        ],
      });
      await publishReply({
        messageId: replyOneB,
        outputMessageId: outputOne,
        userId: "user-one",
        text: "first deferred reply B",
        ts: now + 2,
      });

      await publishLifecycle(requestTwo, "running");
      await publishOutput(requestTwo, outputTwo);
      await publishReply({
        messageId: replyTwo,
        outputMessageId: outputTwo,
        userId: "user-two",
        text: "second deferred reply",
        ts: now + 4,
      });

      expect(received).toHaveLength(0);
      expect(
        raw.deliveryActions
          .filter(({ topic }) => topic === "evt.adapter")
          .map(({ action }) => action.disposition)
          .at(-1),
      ).toBe("park-pending");

      failComposition = false;
      await publishReply({
        messageId: replyTwo,
        outputMessageId: outputTwo,
        userId: "user-two",
        text: "second deferred reply",
        ts: now + 4,
      });

      expect(received).toHaveLength(2);
      expect(
        received.map((message) => ({
          requestId: message.headers?.request_id,
          queue: message.data.queue,
          text: collectUserText(message.data.messages),
        })),
      ).toEqual([
        {
          requestId: requestOne,
          queue: "followUp",
          text: expect.stringContaining("first deferred reply A"),
        },
        {
          requestId: requestOne,
          queue: "followUp",
          text: expect.stringContaining("first deferred reply B"),
        },
      ]);
      expect(
        raw.deliveryActions
          .filter(({ topic }) => topic === "evt.adapter")
          .map(({ action }) => action.disposition)
          .slice(-2),
      ).toEqual(["park-pending", "commit"]);

      await publishLifecycle(requestTwo, "resolved");

      expect(received).toHaveLength(3);
      expect(received[2]?.headers?.request_id).toBe(`discord:${sessionId}:${replyTwo}`);
      expect(received[2]?.data.queue).toBe("prompt");
      expect(collectUserText(received[2]?.data.messages ?? [])).toContain("second deferred reply");
      expect(
        received.filter((message) =>
          collectUserText(message.data.messages).includes("first deferred reply A"),
        ),
      ).toHaveLength(1);
      expect(
        received.filter((message) =>
          collectUserText(message.data.messages).includes("first deferred reply B"),
        ),
      ).toHaveLength(1);
    } finally {
      await sub.stop();
      await router.stop();
      transcriptStore.close();
      debugStub.mockRestore();
      infoStub.mockRestore();
      warnStub.mockRestore();
      errorStub.mockRestore();
    }
  });

  it("converts deferred mention-mode reply batch into followUps when steer arrives", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const activeRequestId = `discord:${sessionId}:anchor`;
    const activeMsgId = "a1";
    const followMsgOne = "b1";
    const followMsgTwo = "b2";
    const steerMsg = "c1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${activeMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: activeMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "A output",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${followMsgOne}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: followMsgOne },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "B one",
        ts: now + 1,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
      },
      [`${sessionId}:${followMsgTwo}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: followMsgTwo },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "B two",
        ts: now + 2,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
      },
      [`${sessionId}:${steerMsg}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: steerMsg },
        session: { platform: "discord", channelId: sessionId },
        userId: "u3",
        userName: "user3",
        text: "<@bot> steer now",
        ts: now + 3,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const surfaceCmd: any[] = [];

    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      {
        msgRef: {
          platform: "discord",
          channelId: sessionId,
          messageId: activeMsgId,
        },
      },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgOne,
      userId: "u1",
      userName: "user1",
      text: "B one",
      ts: now + 1,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgTwo,
      userId: "u2",
      userName: "user2",
      text: "B two",
      ts: now + 2,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: steerMsg,
      userId: "u3",
      userName: "user3",
      text: "<@bot> steer now",
      ts: now + 3,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    expect(received.length).toBe(3);
    expect(received.map((m) => m.data.queue)).toEqual(["steer", "followUp", "followUp"]);
    expect(received.map((m) => m.headers?.request_id)).toEqual([
      activeRequestId,
      activeRequestId,
      activeRequestId,
    ]);

    const followTextOne = received[1].data.messages?.[0]?.content;
    const followTextTwo = received[2].data.messages?.[0]?.content;
    expect(typeof followTextOne).toBe("string");
    expect(typeof followTextTwo).toBe("string");
    expect(followTextOne as string).toContain("B one");
    expect(followTextTwo as string).toContain("B two");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(activeRequestId);
    expect(surfaceCmd[0].data.replyTo?.messageId).toBe(steerMsg);

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    expect(received.length).toBe(3);

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("converts deferred mention-mode reply batch into followUps when interrupt arrives", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const activeRequestId = `discord:${sessionId}:anchor`;
    const activeMsgId = "a1";
    const followMsgId = "b1";
    const interruptMsg = "c1";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${activeMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: activeMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "A output",
        ts: now,
        raw: { reference: {} },
      },
      [`${sessionId}:${followMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: followMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "B one",
        ts: now + 1,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
      },
      [`${sessionId}:${interruptMsg}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: interruptMsg },
        session: { platform: "discord", channelId: sessionId },
        userId: "u2",
        userName: "user2",
        text: "<@bot> !int switch to direct answer",
        ts: now + 2,
        raw: { reference: { messageId: activeMsgId, channelId: sessionId } },
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const surfaceCmd: any[] = [];

    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    const subSurface = await subscribeTopicForTest(
      bus,
      "cmd.surface",
      {
        mode: "fanout",
        subscriptionId: "test-surface",
        consumerId: "c2",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdSurfaceOutputReanchor) {
          surfaceCmd.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "running", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(
      lilacEventTypes.EvtSurfaceOutputMessageCreated,
      {
        msgRef: {
          platform: "discord",
          channelId: sessionId,
          messageId: activeMsgId,
        },
      },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: followMsgId,
      userId: "u1",
      userName: "user1",
      text: "B one",
      ts: now + 1,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: interruptMsg,
      userId: "u2",
      userName: "user2",
      text: "<@bot> !int switch to direct answer",
      ts: now + 2,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: true,
          replyToMessageId: activeMsgId,
        },
      },
    });

    expect(received.length).toBe(2);
    expect(received[0].data.queue).toBe("interrupt");
    expect(received[1].data.queue).toBe("followUp");
    expect(received[0].headers?.request_id).toBe(activeRequestId);
    expect(received[1].headers?.request_id).toBe(activeRequestId);

    const followText = received[1].data.messages?.[0]?.content;
    expect(typeof followText).toBe("string");
    expect(followText as string).toContain("B one");

    expect(surfaceCmd.length).toBe(1);
    expect(surfaceCmd[0].headers?.request_id).toBe(activeRequestId);
    expect(surfaceCmd[0].data.mode).toBe("interrupt");

    await bus.publish(
      lilacEventTypes.EvtRequestLifecycleChanged,
      { state: "resolved", ts: Date.now() },
      {
        headers: {
          request_id: activeRequestId,
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );

    expect(received.length).toBe(2);

    await subSurface.stop();
    await sub.stop();
    await router.stop();
  });

  it("propagates session model override from adapter raw", async () => {
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          sessionModelOverride: "sonnet",
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.modelOverride).toBe("sonnet");
    expect(received[0].data.raw?.modelOverride).toBe("sonnet");

    await sub.stop();
    await router.stop();
  });

  it("prefers one-shot !m override over session override", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const msgId = "m1";
    const oneShot = "openrouter/anthropic/claude-sonnet-4.6";

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: `<@bot> !m:${oneShot} hi`,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: `<@bot> !m:${oneShot} hi`,
      ts: Date.now(),
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          sessionModelOverride: "sonnet",
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.modelOverride).toBe(oneShot);
    const lastUser = [...received[0].data.messages]
      .reverse()
      .find((m: ModelMessage) => m.role === "user");
    expect(typeof lastUser?.content === "string" ? lastUser.content.includes("!m:") : false).toBe(
      false,
    );

    await sub.stop();
    await router.stop();
  });

  it("supports one-shot !model override alias", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const msgId = "m1";
    const oneShot = "openrouter/anthropic/claude-sonnet-4.6";

    const adapter = new FakeAdapter({
      [`${sessionId}:${msgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: msgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: `<@bot> !model:${oneShot} hi`,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: `<@bot> !model:${oneShot} hi`,
      ts: Date.now(),
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.modelOverride).toBe(oneShot);
    const lastUser = [...received[0].data.messages]
      .reverse()
      .find((m: ModelMessage) => m.role === "user");
    const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";
    expect(lastUserText.includes("!model:")).toBe(false);

    await sub.stop();
    await router.stop();
  });

  it("uses session model override from core config", async () => {
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [sessionId]: {
                model: "sonnet",
              },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
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
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.modelOverride).toBe("sonnet");

    await sub.stop();
    await router.stop();
  });

  it("inherits parent model override from core config for threads", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const parentChannelId = "parent";
    const threadId = "thread";
    const msgId = "m1";

    const adapter = new FakeAdapter({
      [`${threadId}:${msgId}`]: {
        ref: { platform: "discord", channelId: threadId, messageId: msgId },
        session: { platform: "discord", channelId: threadId, parentChannelId },
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [parentChannelId]: {
                model: "sonnet",
              },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: threadId,
      messageId: msgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> hi",
      ts: Date.now(),
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          parentChannelId,
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].data.modelOverride).toBe("sonnet");

    await sub.stop();
    await router.stop();
  });

  it("applies model precedence: prompt > in-memory > session config > global", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const configuredSessionId = "chan-config";
    const globalSessionId = "chan-global";

    const promptMsgId = "m-prompt";
    const memoryMsgId = "m-memory";
    const configMsgId = "m-config";
    const globalMsgId = "m-global";

    const adapter = new FakeAdapter({
      [`${configuredSessionId}:${promptMsgId}`]: {
        ref: { platform: "discord", channelId: configuredSessionId, messageId: promptMsgId },
        session: { platform: "discord", channelId: configuredSessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> !m:one-shot hi",
        ts: Date.now(),
        raw: { reference: {} },
      },
      [`${configuredSessionId}:${memoryMsgId}`]: {
        ref: { platform: "discord", channelId: configuredSessionId, messageId: memoryMsgId },
        session: { platform: "discord", channelId: configuredSessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> hi from memory",
        ts: Date.now() + 1,
        raw: { reference: {} },
      },
      [`${configuredSessionId}:${configMsgId}`]: {
        ref: { platform: "discord", channelId: configuredSessionId, messageId: configMsgId },
        session: { platform: "discord", channelId: configuredSessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> hi from config",
        ts: Date.now() + 2,
        raw: { reference: {} },
      },
      [`${globalSessionId}:${globalMsgId}`]: {
        ref: { platform: "discord", channelId: globalSessionId, messageId: globalMsgId },
        session: { platform: "discord", channelId: globalSessionId },
        userId: "u1",
        userName: "user1",
        text: "<@bot> hi from global",
        ts: Date.now() + 3,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [configuredSessionId]: {
                model: "from-config",
              },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: configuredSessionId,
      messageId: promptMsgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> !m:one-shot hi",
      ts: Date.now(),
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          sessionModelOverride: "from-memory",
        },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: configuredSessionId,
      messageId: memoryMsgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> hi from memory",
      ts: Date.now() + 1,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          sessionModelOverride: "from-memory",
        },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: configuredSessionId,
      messageId: configMsgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> hi from config",
      ts: Date.now() + 2,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
        },
      },
    });

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: globalSessionId,
      messageId: globalMsgId,
      userId: "u1",
      userName: "user1",
      text: "<@bot> hi from global",
      ts: Date.now() + 3,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
        },
      },
    });

    expect(received.length).toBe(4);
    expect(received[0].data.modelOverride).toBe("one-shot");
    expect(received[1].data.modelOverride).toBe("from-memory");
    expect(received[2].data.modelOverride).toBe("from-config");
    expect(received[3].data.modelOverride).toBeUndefined();

    await sub.stop();
    await router.stop();
  });

  it("strips !m directive from earlier message in active debounce batch", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const firstMsgId = "m1";
    const secondMsgId = "m2";

    const adapter = new FakeAdapter({
      [`${sessionId}:${firstMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: firstMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "!m:sonnet write a short haiku",
        ts: Date.now(),
        raw: { reference: {} },
      },
      [`${sessionId}:${secondMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: secondMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "about shipping code",
        ts: Date.now() + 1,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(async () => {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId: firstMsgId,
        userId: "u1",
        userName: "user1",
        text: "!m:sonnet write a short haiku",
        ts: Date.now(),
        raw: {
          discord: {
            isDMBased: false,
            mentionsBot: false,
            replyToBot: false,
          },
        },
      });

      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId: secondMsgId,
        userId: "u1",
        userName: "user1",
        text: "about shipping code",
        ts: Date.now() + 1,
        raw: {
          discord: {
            isDMBased: false,
            mentionsBot: false,
            replyToBot: false,
          },
        },
      });
    }, sub.waitForDelivery());

    expect(received.length).toBe(1);
    expect(received[0].data.modelOverride).toBe("sonnet");

    const userContents = (received[0].data.messages as ModelMessage[])
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    expect(userContents.some((text) => text.includes("!m:"))).toBe(false);

    await sub.stop();
    await router.stop();
  });

  it("strips !model directive from earlier message in active debounce batch", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan";
    const firstMsgId = "m1";
    const secondMsgId = "m2";

    const adapter = new FakeAdapter({
      [`${sessionId}:${firstMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: firstMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "!model:sonnet write a short haiku",
        ts: Date.now(),
        raw: { reference: {} },
      },
      [`${sessionId}:${secondMsgId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: secondMsgId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "about shipping code",
        ts: Date.now() + 1,
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
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(async () => {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId: firstMsgId,
        userId: "u1",
        userName: "user1",
        text: "!model:sonnet write a short haiku",
        ts: Date.now(),
        raw: {
          discord: {
            isDMBased: false,
            mentionsBot: false,
            replyToBot: false,
          },
        },
      });

      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: sessionId,
        messageId: secondMsgId,
        userId: "u1",
        userName: "user1",
        text: "about shipping code",
        ts: Date.now() + 1,
        raw: {
          discord: {
            isDMBased: false,
            mentionsBot: false,
            replyToBot: false,
          },
        },
      });
    }, sub.waitForDelivery());

    expect(received.length).toBe(1);
    expect(received[0].data.modelOverride).toBe("sonnet");

    const userContents = (received[0].data.messages as ModelMessage[])
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content as string);
    expect(userContents.some((text) => text.includes("!model:"))).toBe(false);

    await sub.stop();
    await router.stop();
  });

  it("fails open for direct-reply disambiguation gate errors", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);

    const sessionId = "chan-fail-open";
    const repliedToId = "a1";
    const triggerId = "u-trigger";
    const now = Date.now();

    const adapter = new FakeAdapter({
      [`${sessionId}:${repliedToId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: repliedToId },
        session: { platform: "discord", channelId: sessionId },
        userId: "bot",
        userName: "lilac",
        text: "previous bot answer",
        ts: now - 10,
        raw: { reference: {} },
      },
      [`${sessionId}:${triggerId}`]: {
        ref: { platform: "discord", channelId: sessionId, messageId: triggerId },
        session: { platform: "discord", channelId: sessionId },
        userId: "u1",
        userName: "user1",
        text: "@otherbot should we proceed?",
        ts: now,
        raw: { reference: { messageId: repliedToId } },
      },
    });

    const router = await startBusRequestRouter({
      adapter,
      bus,
      subscriptionId: "router-test-fail-open",
      routerGate: async () => {
        throw new Error("gate failed");
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "mention",
            sessionModes: {
              [sessionId]: { mode: "mention", gate: true },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test-fail-open",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: sessionId,
      messageId: triggerId,
      userId: "u1",
      userName: "user1",
      text: "@otherbot should we proceed?",
      ts: now,
      raw: {
        discord: {
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          replyToMessageId: repliedToId,
        },
      },
    });

    expect(received.length).toBe(1);
    expect(received[0].type).toBe(lilacEventTypes.CmdRequestMessage);

    await sub.stop();
    await router.stop();
  });

  it("fails closed for active-batch gate errors", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const decision = observeRouterDecision();

    const sessionId = "chan-fail-closed";
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
      subscriptionId: "router-test-fail-closed",
      logger: decision.logger,
      routerGate: async () => {
        throw new Error("batch gate failed");
      },
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "active",
            sessionModes: {
              [sessionId]: { mode: "active", gate: true },
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
    const sub = await subscribeTopicForTest(
      bus,
      "cmd.request",
      {
        mode: "fanout",
        subscriptionId: "test-fail-closed",
        consumerId: "c1",
      },
      async (m) => {
        if (m.type === lilacEventTypes.CmdRequestMessage) {
          received.push(m);
        }
        return Result.ok(undefined);
      },
    );

    await triggerRouterDebounce(
      () =>
        bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
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
        }),
      decision.decided,
    );

    expect(received.length).toBe(0);

    await sub.stop();
    await router.stop();
  });

  it("reports Panic from a detached debounce publication through router.done", async () => {
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const sessionId = "chan-debounce-panic";
    const msgId = "m1";
    const now = Date.now();
    const panic = new Panic({ message: "debounce publication invariant failed" });
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
      subscriptionId: "router-test-debounce-panic",
      config: {
        surface: {
          discord: {
            tokenEnv: "DISCORD_TOKEN",
            allowedChannelIds: [],
            allowedGuildIds: [],
            botName: "lilac",
            outputMode: "inline",
            previewFinalOutputStyle: "embed",
          },
          router: {
            defaultMode: "active",
            sessionModes: {},
            activeDebounceMs: 1,
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
    raw.failPublicationsTo("cmd.request", panic);
    const supervised = router.done.then(
      () => new Error("router.done resolved before reporting debounce Panic"),
      (cause: unknown) => cause,
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

    expect(await supervised).toBe(panic);
    await router.stop();
  });
});
