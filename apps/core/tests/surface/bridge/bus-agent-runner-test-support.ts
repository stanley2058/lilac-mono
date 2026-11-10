import { afterAll, beforeAll } from "bun:test";
import {
  buildCoreLineageManifestV2 as buildCoreLineageManifestResultV2,
  createLilacBus,
  lilacEventTypes,
  outReqTopic,
  type CoreLineageManifestV2,
  type CorePrimaryLineageV2,
  type EventDeliveryStopFailed,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import { simulateReadableStream } from "ai/test";
import { Result, type Result as ResultType } from "better-result";
import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";
import { startBusAgentRunner as startBusAgentRunnerProduction } from "../../../src/surface/bridge/bus-agent-runner";
import { createCorePrimaryClaudeRuntime as createCorePrimaryClaudeRuntimeResult } from "../../../src/agent/core-primary-continuation";
import { type BuiltLevel1Toolset, type CoreToolPluginManager } from "../../../src/plugins";
import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  computeCorePrimaryClaudeTerminalHead as computeCorePrimaryClaudeTerminalHeadResult,
  type CoreClaudeAttemptMutationError,
  type CoreClaudeBindingReadError,
  SqliteTranscriptStore,
} from "../../../src/transcript/transcript-store";
import { projectStoredMessagesV1 } from "../../../src/transcript/stored-message-materialization";
import { hashCanonicalStoredMessagesV2 } from "../../../src/transcript/transcript-persistence-codec";
import {
  type AcceptedRequestDelivery,
  type CoreAcceptedRequestWork,
} from "../../../src/surface/bridge/request-delivery";
import { normalizeDiscordRaw } from "../../../src/surface/discord/discord-raw-normalizer";
import { getBuiltinSurfaceProtocol } from "../../../src/surface/builtin-surface-protocols";
import type {
  ResolvedSurfaceProtocol,
  SurfaceProtocolResolver,
} from "../../../src/surface/runtime-descriptor";
import type {
  AdapterEventHandler,
  StartOutputOpts,
  SurfaceOperationResult,
  SurfaceOutputPart,
  SurfaceOutputStream,
} from "../../../src/surface/adapter";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSelf,
  SurfaceSession,
} from "../../../src/surface/types";
import { SurfaceAdapterTestBase } from "../../helpers/surface-adapter-test-base";
import {
  subscribeForTest,
  type TestRawMessageHandler,
  type TestRawSubscriptionHost,
} from "../../helpers/result-raw-bus";

export function createCorePrimaryClaudeRuntime(
  input: Parameters<typeof createCorePrimaryClaudeRuntimeResult>[0],
) {
  const created = createCorePrimaryClaudeRuntimeResult(input);
  if (created.status === "error") throw created.error;
  return created.value;
}

export const TEST_SURFACE_PROTOCOL_RESOLVER: SurfaceProtocolResolver = {
  resolve: (platform) => {
    const protocol = getBuiltinSurfaceProtocol(platform);
    return protocol ? ({ platform: protocol.platform, protocol } as ResolvedSurfaceProtocol) : null;
  },
};

export let TEST_BLOB_STORE: BlobStore;

export function startBusAgentRunner(
  params: Omit<Parameters<typeof startBusAgentRunnerProduction>[0], "blobStore"> & {
    blobStore?: BlobStore;
  },
) {
  return startBusAgentRunnerProduction({
    ...params,
    blobStore: params.blobStore ?? TEST_BLOB_STORE,
    surfaceProtocolResolver: params.surfaceProtocolResolver ?? TEST_SURFACE_PROTOCOL_RESOLVER,
  });
}

export function transcriptResultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

export function computeCorePrimaryClaudeTerminalHead(
  input: Parameters<typeof computeCorePrimaryClaudeTerminalHeadResult>[0],
) {
  return transcriptResultValue(computeCorePrimaryClaudeTerminalHeadResult(input));
}

export function attemptMutationValue<T>(result: ResultType<T, CoreClaudeAttemptMutationError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptTransactionConflict":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

export function bindingValue<T>(result: ResultType<T, CoreClaudeBindingReadError>): T {
  if (result.status === "ok") return result.value;
  switch (result.error._tag) {
    case "CoreClaudeBindingCorrupt":
    case "TranscriptStoreSqliteDriverFailure":
      throw result.error;
  }
}

export function getPrimaryBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCorePrimaryClaudeSessionBinding"]>[0],
) {
  return bindingValue(store.getCorePrimaryClaudeSessionBinding(input));
}

export function promotePrimaryBinding(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["promoteCorePrimaryClaudeSessionBinding"]>[0],
) {
  return attemptMutationValue(store.promoteCorePrimaryClaudeSessionBinding(input));
}

export function buildCoreLineageManifestV2(
  ...args: Parameters<typeof buildCoreLineageManifestResultV2>
) {
  return transcriptResultValue(buildCoreLineageManifestResultV2(...args));
}

export function getRequestTranscript(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getRequestTranscript"]>[0],
) {
  return transcriptResultValue(store.getRequestTranscript(input));
}

export function getCorePrimaryLineageManifest(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCorePrimaryLineageManifest"]>[0],
) {
  return transcriptResultValue(store.getCorePrimaryLineageManifest(input));
}

export function getCoreRequestAtomMetadata(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getCoreRequestAtomMetadata"]>[0],
) {
  return transcriptResultValue(store.getCoreRequestAtomMetadata(input));
}

export function getTranscriptBySurfaceMessage(
  store: SqliteTranscriptStore,
  input: Parameters<SqliteTranscriptStore["getTranscriptBySurfaceMessage"]>[0],
) {
  return transcriptResultValue(store.getTranscriptBySurfaceMessage(input));
}

export function level1TestTool(execute: () => unknown) {
  return tool({
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute,
  });
}

export function level1TestToolset(params?: {
  builtinExecute?: () => unknown;
  catalogExecute?: () => unknown;
  searchExecute?: () => unknown;
  onCatalogCreate?: () => void;
  onBatchUpdate?: (activeToolNames: ReadonlySet<string>) => void;
}): BuiltLevel1Toolset {
  params?.onCatalogCreate?.();
  const catalogTool = level1TestTool(params?.catalogExecute ?? (() => "catalog"));
  const tools = {
    builtin: level1TestTool(params?.builtinExecute ?? (() => "builtin")),
    find_tools: level1TestTool(params?.searchExecute ?? (() => "search")),
    deferred_tool: catalogTool,
  } satisfies ToolSet;
  return {
    tools,
    specs: new Map(),
    contributionInfo: new Map(),
    directToolNames: new Set(["builtin", "find_tools"]),
    catalog: [
      {
        source: "mcp",
        sourceId: "server",
        rawName: "raw_tool",
        modelName: "deferred_tool",
        title: "Deferred tool",
        description: "Deferred metadata",
        identity: {
          source: "mcp",
          sourceId: "server",
          rawToolName: "raw_tool",
        },
        stableId: "catalog-id",
        tool: catalogTool,
      },
    ],
    catalogMetadata: {
      deferred_tool: {
        sourceId: "server",
        rawName: "raw_tool",
        title: "Deferred tool",
        description: "Deferred metadata",
      },
    },
    genericOutputNormalizerBypassTools: new Set(["builtin"]),
    aggregateOutputBudgetExemptTools: new Set(),
    release: async () => Result.ok(undefined),
  };
}

export function level1ZeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

export function level1TextStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

export function level1PhasedTextStep(finalText = "Final answer.") {
  const commentaryMetadata = {
    openai: { itemId: "msg_commentary", phase: "commentary" },
  } as const;
  const finalMetadata = {
    openai: { itemId: "msg_final", phase: "final_answer" },
  } as const;
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "text-start" as const,
          id: "commentary",
          providerMetadata: commentaryMetadata,
        },
        {
          type: "text-delta" as const,
          id: "commentary",
          delta: "Commentary.",
          providerMetadata: commentaryMetadata,
        },
        {
          type: "text-end" as const,
          id: "commentary",
          providerMetadata: commentaryMetadata,
        },
        {
          type: "text-start" as const,
          id: "final",
          providerMetadata: finalMetadata,
        },
        {
          type: "text-delta" as const,
          id: "final",
          delta: finalText,
          providerMetadata: finalMetadata,
        },
        {
          type: "text-end" as const,
          id: "final",
          providerMetadata: finalMetadata,
        },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

export function level1ToolCallStep(calls: readonly { toolCallId: string; toolName: string }[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map((call) => ({
          type: "tool-call" as const,
          ...call,
          input: "{}",
        })),
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

export function level1TextAndToolCallStep(
  text: string,
  call: { toolCallId: string; toolName: string },
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        { type: "tool-call" as const, ...call, input: "{}" },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage: level1ZeroUsage(),
        },
      ],
    }),
  };
}

export function level1OfferedToolNames(options: {
  tools?: ReadonlyArray<{ name: string }>;
}): string[] {
  return (options.tools ?? []).map((entry) => entry.name);
}

export function formatExpectedLocalThreadTimeRange(start: string, end: string): string {
  const format = (value: string) => {
    const date = new Date(value);
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  };
  return `${format(start)} - ${format(end)}`;
}

export function autoInjectPlanForQuery(query: string, intentSummary: string) {
  return {
    searches: [
      {
        queries: [query],
        aboutness: {
          domains: [],
          situations: [],
          targets: [],
          entities: [],
          userWouldAskForThisAs: [query],
          intentSummary,
        },
      },
    ],
  };
}

export type RunnerTestRawBus = RawBus &
  TestRawSubscriptionHost & {
    redeliverRequest(requestId: string): Promise<void>;
    redeliverRequestEvent(eventId: string): Promise<void>;
    redeliverRequestEventWithHeaders(
      eventId: string,
      headers: Message<unknown>["headers"],
    ): Promise<void>;
    requestEventIds(requestId: string): readonly string[];
    suppressNextWorkReplay(): void;
    failNextQueuedLifecycle(): void;
    failCancelledLifecycleAfter(successfulPublications: number): void;
  };

export function createInMemoryRawBus(
  options: {
    readonly waitForActiveHandlersOnStop?: boolean;
    readonly onWorkDeliveryStarted?: () => void;
    readonly onPublish?: (eventType: string) => void;
  } = {},
): RunnerTestRawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subs = new Set<{
    topic: string;
    opts: SubscriptionOptions;
    handler: TestRawMessageHandler;
    activeHandlers: Set<Promise<void>>;
  }>();
  let rejectNextQueuedLifecycle = false;
  let cancelledLifecyclePublicationsBeforeFailure: number | null = null;
  let suppressNextWorkReplay = false;
  const raw: RunnerTestRawBus = {
    subscribe: subscribeForTest,
    publish: async <TData>(msg: Omit<Message<TData>, "id" | "ts">, opts: PublishOptions) => {
      options.onPublish?.(opts.type);
      if (
        rejectNextQueuedLifecycle &&
        opts.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        typeof msg.data === "object" &&
        msg.data !== null &&
        Reflect.get(msg.data, "state") === "queued"
      ) {
        rejectNextQueuedLifecycle = false;
        throw new Error("queued lifecycle publication failed");
      }
      if (
        cancelledLifecyclePublicationsBeforeFailure !== null &&
        opts.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        typeof msg.data === "object" &&
        msg.data !== null &&
        Reflect.get(msg.data, "state") === "cancelled"
      ) {
        if (cancelledLifecyclePublicationsBeforeFailure === 0) {
          cancelledLifecyclePublicationsBeforeFailure = null;
          throw new Error("cancelled lifecycle publication failed");
        }
        cancelledLifecyclePublicationsBeforeFailure -= 1;
      }
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

      for (const s of subs) {
        if (s.topic !== opts.topic) continue;
        if (s.opts.mode === "work") options.onWorkDeliveryStarted?.();
        const handling = s.handler(stored, id);
        s.activeHandlers.add(handling);
        void handling.then(
          () => s.activeHandlers.delete(handling),
          () => s.activeHandlers.delete(handling),
        );
        await handling;
      }
      return { id, cursor: id };
    },

    openTestSubscription: async (
      topic: string,
      opts: SubscriptionOptions,
      handler: TestRawMessageHandler,
    ) => {
      const entry = {
        topic,
        opts,
        handler,
        activeHandlers: new Set<Promise<void>>(),
      };
      subs.add(entry);

      const offset = opts.mode === "tail" ? opts.offset : undefined;
      if (suppressNextWorkReplay && topic === "cmd.request" && opts.mode === "work") {
        suppressNextWorkReplay = false;
      } else if (offset?.type === "begin" || offset?.type === "cursor") {
        const existing = topics.get(topic) ?? [];
        const replay =
          offset.type === "cursor"
            ? (() => {
                const cursorIndex = existing.findIndex((m) => m.id === offset.cursor);
                return cursorIndex >= 0 ? existing.slice(cursorIndex + 1) : existing;
              })()
            : existing;
        for (const m of replay) {
          await handler(m, m.id);
        }
      }

      return {
        stop: async () => {
          subs.delete(entry);
          if (options.waitForActiveHandlersOnStop) {
            await Promise.all(entry.activeHandlers);
          }
        },
      };
    },

    fetch: async (topic: string) => {
      const existing = topics.get(topic) ?? [];
      return {
        messages: existing.map((m) => ({
          msg: m,
          cursor: m.id,
        })),
        next: existing.length > 0 ? existing[existing.length - 1]?.id : undefined,
      };
    },

    redeliverRequest: async (requestId) => {
      for (const [topic, messages] of topics) {
        const message = messages.findLast(
          (candidate) => candidate.headers?.request_id === requestId,
        );
        if (!message) continue;
        for (const subscription of subs) {
          if (subscription.topic === topic && subscription.opts.mode === "work") {
            await subscription.handler(message, message.id);
          }
        }
        return;
      }
      throw new Error(`Missing request for redelivery: ${requestId}`);
    },

    redeliverRequestEvent: async (eventId) => {
      const messages = topics.get("cmd.request") ?? [];
      const message = messages.find((candidate) => candidate.id === eventId);
      if (!message) throw new Error(`Missing request event for redelivery: ${eventId}`);
      for (const subscription of subs) {
        if (subscription.topic === "cmd.request" && subscription.opts.mode === "work") {
          await subscription.handler(message, message.id);
        }
      }
    },

    redeliverRequestEventWithHeaders: async (eventId, headers) => {
      const messages = topics.get("cmd.request") ?? [];
      const message = messages.find((candidate) => candidate.id === eventId);
      if (!message) throw new Error(`Missing request event for redelivery: ${eventId}`);
      for (const subscription of subs) {
        if (subscription.topic === "cmd.request" && subscription.opts.mode === "work") {
          await subscription.handler({ ...message, headers }, message.id);
        }
      }
    },

    requestEventIds: (requestId) =>
      (topics.get("cmd.request") ?? [])
        .filter((message) => message.headers?.request_id === requestId)
        .map((message) => message.id),

    suppressNextWorkReplay: () => {
      suppressNextWorkReplay = true;
    },

    failNextQueuedLifecycle: () => {
      rejectNextQueuedLifecycle = true;
    },

    failCancelledLifecycleAfter: (successfulPublications) => {
      cancelledLifecyclePublicationsBeforeFailure = successfulPublications;
    },

    close: async () => {},
  };

  return raw;
}

export function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  let rejectPromise: (reason?: unknown) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export type ProductionPathOutput = {
  readonly messageId: string;
  readonly parts: SurfaceOutputPart[];
  readonly finished: Promise<void>;
};

export class ProductionPathDiscordAdapter extends SurfaceAdapterTestBase {
  readonly messages = new Map<string, SurfaceMessage>();
  readonly outputs: ProductionPathOutput[] = [];
  readonly updatedOutputMessageIds: string[] = [];
  private readonly handlers = new Set<AdapterEventHandler>();
  private outputSequence = 0;
  private timestamp = 10_000;

  async emitCreated(message: SurfaceMessage): Promise<void> {
    this.messages.set(message.ref.messageId, message);
    await Promise.all(
      [...this.handlers].map((handler) =>
        handler({
          type: "adapter.message.created",
          platform: "discord",
          ts: message.ts,
          message,
        }),
      ),
    );
  }

  private async emitOutputUpdated(message: SurfaceMessage): Promise<void> {
    this.updatedOutputMessageIds.push(message.ref.messageId);
    await Promise.all(
      [...this.handlers].map((handler) =>
        handler({
          type: "adapter.message.updated",
          platform: "discord",
          ts: message.ts,
          message,
        }),
      ),
    );
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "discord", userId: "bot", userName: "lilac" };
  }

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    throw new Error("not used");
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    this.outputSequence += 1;
    const messageId = `output-${this.outputSequence}`;
    const parts: SurfaceOutputPart[] = [];
    const finished = deferred<void>();
    let outputMessage: SurfaceMessage | null = null;
    let visibleText = "";
    const ensureOutputMessage = (): SurfaceMessage => {
      if (outputMessage) return outputMessage;
      outputMessage = {
        ref: {
          platform: "discord",
          channelId: sessionRef.channelId,
          messageId,
        },
        session: { platform: "discord", channelId: sessionRef.channelId },
        userId: "bot",
        userName: "lilac",
        text: "",
        ts: this.timestamp++,
        raw: {
          reference: opts?.replyTo
            ? {
                messageId: opts.replyTo.messageId,
                channelId: opts.replyTo.channelId,
              }
            : {},
          discord: { isChat: true },
        },
      };
      this.messages.set(messageId, outputMessage);
      opts?.onMessageCreated?.(outputMessage.ref);
      return outputMessage;
    };
    this.outputs.push({ messageId, parts, finished: finished.promise });

    return Result.ok({
      push: async (part) => {
        parts.push(part);
        const message = ensureOutputMessage();
        if (part.type === "text.delta") visibleText += part.delta;
        if (part.type === "text.set") visibleText = part.text;
        message.text = visibleText;
        await this.emitOutputUpdated(message);
        return Result.ok("visible");
      },
      finish: async () => {
        const message = ensureOutputMessage();
        finished.resolve(undefined);
        return Result.ok({ created: [message.ref], last: message.ref });
      },
      abort: async () => {
        finished.resolve(undefined);
        return Result.ok(undefined);
      },
      getFinalTextMode: () => "continuation",
    });
  }

  async sendMsg(
    _sessionRef: SessionRef,
    _content: ContentOpts,
    _opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    throw new Error("not used");
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    return Result.ok(this.messages.get(msgRef.messageId) ?? null);
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const before = opts?.beforeMessageId ? this.messages.get(opts.beforeMessageId)?.ts : undefined;
    return Result.ok(
      [...this.messages.values()]
        .filter((message) => message.session.channelId === sessionRef.channelId)
        .filter((message) => before === undefined || message.ts < before)
        .toSorted((left, right) => left.ts - right.ts)
        .slice(-(opts?.limit ?? 50)),
    );
  }

  async editMsg(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async deleteMsg(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async getReplyContext(): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    return Result.ok([]);
  }
  override async planReplyChain(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const refs: MsgRef[] = [];
    const seen = new Set<string>();
    let cursor = msgRef;

    while (!seen.has(cursor.messageId)) {
      seen.add(cursor.messageId);
      refs.push(cursor);
      const reply = normalizeDiscordRaw(this.messages.get(cursor.messageId)?.raw)?.replyReference;
      if (!reply?.messageId) break;
      const channelId = reply.channelId ?? cursor.channelId;
      if (channelId !== msgRef.channelId) break;
      cursor = { platform: "discord", channelId, messageId: reply.messageId };
    }

    return Result.ok(refs.reverse());
  }
  async addReaction(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async removeReaction(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
  async listReactions(): Promise<SurfaceOperationResult<string[]>> {
    return Result.ok([]);
  }

  async subscribe(handler: AdapterEventHandler): Promise<{ stop(): Promise<void> }> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    return Result.ok([]);
  }
  async markRead(): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
}

export async function observeRequestLifecycle(
  bus: ReturnType<typeof createLilacBus>,
  requestId: string,
) {
  const terminal = deferred<"resolved" | "cancelled" | "failed">();
  const first = deferred<string>();
  const states: string[] = [];
  const details: Array<string | undefined> = [];
  const subscriptionResult = await bus.subscribeTopic(
    "evt.request",
    { mode: "tail", offset: { type: "begin" } },
    async (message) => {
      if (
        message.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        message.headers?.request_id === requestId
      ) {
        states.push(message.data.state);
        details.push(message.data.detail);
        first.resolve(message.data.state);
        if (
          message.data.state === "resolved" ||
          message.data.state === "cancelled" ||
          message.data.state === "failed"
        ) {
          terminal.resolve(message.data.state);
        }
      }
      return Result.ok(undefined);
    },
    () => "dead-letter",
  );
  if (subscriptionResult.status === "error") throw subscriptionResult.error;
  const subscription = subscriptionResult.value;
  return {
    states,
    details,
    first: first.promise,
    terminal: terminal.promise,
    stop: async () => {
      const stopped = await subscription.stop();
      if (stopped.status === "error") throw stopped.error;
    },
  };
}

export async function observeResponseAfterOutputRelay(
  bus: ReturnType<typeof createLilacBus>,
  requestId: string,
) {
  const relayed = deferred<void>();
  let outputSubscription: {
    stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
  } | null = null;
  const lifecycleSubscriptionResult = await bus.subscribeTopic(
    "evt.request",
    { mode: "tail", offset: { type: "now" } },
    async (message) => {
      if (
        message.type === lilacEventTypes.EvtRequestLifecycleChanged &&
        message.headers?.request_id === requestId &&
        message.data.state === "resolved" &&
        outputSubscription === null
      ) {
        const outputSubscriptionResult = await bus.subscribeTopic(
          outReqTopic(requestId),
          { mode: "tail", offset: { type: "now" } },
          async (outputMessage) => {
            if (outputMessage.type === lilacEventTypes.EvtAgentOutputResponseText) {
              relayed.resolve(undefined);
            }
            return Result.ok(undefined);
          },
          () => "dead-letter",
        );
        if (outputSubscriptionResult.status === "error") throw outputSubscriptionResult.error;
        outputSubscription = outputSubscriptionResult.value;
      }
      return Result.ok(undefined);
    },
    () => "dead-letter",
  );
  if (lifecycleSubscriptionResult.status === "error") throw lifecycleSubscriptionResult.error;
  const lifecycleSubscription = lifecycleSubscriptionResult.value;
  return {
    relayed: relayed.promise,
    stop: async () => {
      const lifecycleStopped = await lifecycleSubscription.stop();
      if (lifecycleStopped.status === "error") throw lifecycleStopped.error;
      if (outputSubscription) {
        const outputStopped = await outputSubscription.stop();
        if (outputStopped.status === "error") throw outputStopped.error;
      }
    },
  };
}

export async function publishRunnerRequest(input: {
  bus: ReturnType<typeof createLilacBus>;
  requestId: string;
  sessionId: string;
  queue?: "prompt" | "followUp" | "steer" | "interrupt";
  text: string;
  messages?: readonly unknown[];
  modelOverride?: string;
  requestClient?: "discord" | "github" | "native";
  corePrimaryLineage?: CorePrimaryLineageV2;
  raw?: unknown;
  requestDeliveryId?: string;
}) {
  const requestDeliveryId = input.requestDeliveryId ?? crypto.randomUUID();
  await input.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      requestDeliveryId,
      queue: input.queue ?? "prompt",
      messages: transcriptResultValue(
        projectStoredMessagesV1(input.messages ?? [{ role: "user", content: input.text }]),
      ),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      ...(input.corePrimaryLineage ? { corePrimaryLineage: input.corePrimaryLineage } : {}),
      ...(input.raw === undefined ? {} : { raw: input.raw }),
    },
    {
      headers: {
        request_id: input.requestId,
        session_id: input.sessionId,
        request_client: input.requestClient ?? "github",
      },
    },
  );
  return requestDeliveryId;
}

export function acceptedRunnerDelivery(input: {
  readonly requestDeliveryId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly requestClient?: "discord" | "github";
  readonly queue: CoreAcceptedRequestWork["data"]["queue"];
  readonly messages: readonly StoredMessageV1[];
  readonly corePrimaryLineage?: CorePrimaryLineageV2;
  readonly inputReferences?: AcceptedRequestDelivery<CoreAcceptedRequestWork>["inputReferences"];
  readonly raw?: unknown;
}): AcceptedRequestDelivery<CoreAcceptedRequestWork> {
  const requestClient = input.requestClient ?? "github";
  const headers = {
    request_id: input.requestId,
    session_id: input.sessionId,
    request_client: requestClient,
  };
  return {
    state: "accepted",
    requestDeliveryId: input.requestDeliveryId,
    requestId: input.requestId,
    work: {
      requestDeliveryId: input.requestDeliveryId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      requestClient,
      headers,
      data: {
        requestDeliveryId: input.requestDeliveryId,
        queue: input.queue,
        messages: [...input.messages],
        ...(input.corePrimaryLineage ? { corePrimaryLineage: input.corePrimaryLineage } : {}),
        ...(input.raw === undefined ? {} : { raw: input.raw }),
      },
    },
    inputReferences: input.inputReferences ?? [],
    createdAt: 1,
    acceptedAt: 2,
  };
}

export function corePrimaryTestPluginManager(
  onBuild?: (
    requestContext: Parameters<
      CoreToolPluginManager["buildLevel1ToolsetResult"]
    >[0]["requestContext"],
  ) => void,
  toolset = level1TestToolset(),
): CoreToolPluginManager {
  return {
    init: async () => Result.ok(),
    destroy: async () => Result.ok(),
    reload: async () => Result.ok(),
    ensureFresh: async () => Result.ok(),
    getStatuses: () => [],
    getLevel2Tools: () => [],
    getLevel2ContributionInfo: () => new Map(),
    buildLevel1ToolsetResult: async (input) => {
      onBuild?.(input.requestContext);
      return Result.ok(toolset);
    },
  };
}

export function admitPrimarySurface(
  store: SqliteTranscriptStore,
  sessionId: string,
  messageId: string,
  canonicalMessages: readonly ModelMessage[],
) {
  const storedMessages = transcriptResultValue(projectStoredMessagesV1(canonicalMessages));
  store.admitCoreSurfaceProjection({
    requestClient: "discord",
    surfaceId: `discord:${sessionId}`,
    sessionId,
    messageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    canonicalMessages: storedMessages,
    sourceFacts: {
      segmentMessageIds: [messageId],
      segmentDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(storedMessages)).hash,
    },
    ownedBlobs: [],
  });
  return {
    atoms: [
      {
        kind: "surface" as const,
        requestClient: "discord",
        surfaceId: `discord:${sessionId}`,
        sessionId,
        messageId,
      },
    ],
    canonicalMessages: storedMessages,
  };
}

export function extendPrimaryManifest(input: {
  store: SqliteTranscriptStore;
  sessionId: string;
  previous: CoreLineageManifestV2;
  completedRequestId: string;
  outputMessageId: string;
  currentMessageId: string;
  currentMessages: readonly ModelMessage[];
}): CoreLineageManifestV2 {
  const transcript = getRequestTranscript(input.store, {
    requestId: input.completedRequestId,
  });
  const metadata = getCoreRequestAtomMetadata(input.store, {
    requestId: input.completedRequestId,
  });
  if (!transcript || !metadata) throw new Error("completed primary request metadata is missing");
  input.store.admitCoreSurfaceProjection({
    requestClient: "discord",
    surfaceId: `discord:${input.sessionId}`,
    sessionId: input.sessionId,
    messageId: input.outputMessageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
    canonicalMessages: transcript.messages,
    sourceFacts: {},
    ownedBlobs: [],
  });
  input.store.linkSurfaceMessagesToRequest({
    requestId: input.completedRequestId,
    created: [
      {
        platform: "discord",
        channelId: input.sessionId,
        messageId: input.outputMessageId,
      },
    ],
    last: {
      platform: "discord",
      channelId: input.sessionId,
      messageId: input.outputMessageId,
    },
  });
  const currentSegment = admitPrimarySurface(
    input.store,
    input.sessionId,
    input.currentMessageId,
    input.currentMessages,
  );
  return buildCoreLineageManifestV2(
    [
      ...input.previous.segments.map((segment) => ({
        atoms: segment.atoms,
        canonicalMessages: segment.canonicalMessages,
        ...(segment.requestSource ? { requestSource: segment.requestSource } : {}),
      })),
      {
        atoms: [{ kind: "request" as const, ...metadata }],
        canonicalMessages: transcript.messages,
        requestSource: {
          aliases: [
            {
              requestClient: "discord",
              surfaceId: `discord:${input.sessionId}`,
              sessionId: input.sessionId,
              messageId: input.outputMessageId,
            },
          ],
        },
      },
      currentSegment,
    ],
    { currentSegmentIndex: input.previous.segments.length + 1 },
  );
}

export function readGeneratedPayload(messages: readonly ModelMessage[]) {
  const message = messages[0];
  if (message?.role !== "user" || !Array.isArray(message.content))
    throw new Error("expected generated user message");
  const body = message.content[1];
  if (body?.type !== "text") throw new Error("expected generated payload");
  return JSON.parse(body.text);
}

/** Registers the shared in-memory blob store for the calling test file. */
export function useTestBlobStore(): void {
  beforeAll(async () => {
    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    TEST_BLOB_STORE = created.value;
  });

  afterAll(async () => {
    await TEST_BLOB_STORE.close({ deadlineAtMs: Date.now() + 1_000 });
  });
}
