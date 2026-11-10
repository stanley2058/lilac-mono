import { describe, expect, it, spyOn } from "bun:test";
import { createLilacBus, lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV1ToUniversal, type CoreConfig } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import {
  SurfaceInvalidInput,
  SurfacePlatformMismatch,
  SurfaceSessionMismatch,
  type SurfaceAdapter,
  type SurfaceOperationError,
} from "../../src/surface/adapter";
import {
  BUILTIN_SURFACE_PROTOCOLS,
  inferBuiltinSurfaceToolRequestTarget,
  projectBuiltinSurfaceMessageRef,
  resolveBuiltinSurfaceRequestMessageRef,
} from "../../src/surface/builtin-surface-protocols";
import { bridgeBusToAdapter } from "../../src/surface/bridge/subscribe-from-bus";
import { DiscordAdapter } from "../../src/surface/discord/discord-adapter";
import {
  createDiscordRelayPolicy,
  createDiscordSurfaceRuntimeDescriptor,
} from "../../src/surface/discord/discord-runtime-descriptor";
import { GithubApiError } from "../../src/github/github-api";
import { GithubAdapter, type GithubAdapterApi } from "../../src/surface/github/github-adapter";
import {
  createGithubRelayPolicy,
  createGithubSurfaceRuntimeDescriptor,
} from "../../src/surface/github/github-runtime-descriptor";
import {
  SurfaceRuntimeRegistry,
  type RegisteredBoundSurfaceRuntimeDescriptor,
  type RegisteredSurfacePlatform,
  type RegisteredSurfaceRuntimeDescriptor,
} from "../../src/surface/runtime-descriptor";
import type { MsgRef, SessionRef } from "../../src/surface/types";
import type { ReplyTargetResolution } from "../../src/surface/protocol";
import { DiscordOutputStream } from "../../src/surface/discord/output/discord-output-stream";
import { GithubOutputStream } from "../../src/surface/github/output/github-output-stream";
import { clearGithubAck, getGithubAck, setGithubAck } from "../../src/github/github-state";
import { createInMemoryDeliveryBus } from "../helpers/in-memory-delivery-bus";
import { getTestBlobStore } from "../helpers/blob-store";

type ProtocolLog = {
  readonly creates: string[];
  readonly edits: string[];
  readonly deletes: string[];
};

type ReferenceContract = {
  readonly platform: RegisteredSurfacePlatform;
  readonly protocol: (typeof BUILTIN_SURFACE_PROTOCOLS)[RegisteredSurfacePlatform];
  readonly sessionId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly missingMessageId: string;
  readonly expectedListSessionsError: SurfaceOperationError["_tag"];
  readonly expectedProviderOperation: "finish-output" | "send-message";
  createSessionRef(): SessionRef;
  createMessageRef(messageId?: string): MsgRef;
  readonly foreignSessionRef: SessionRef;
  readonly foreignMessageRef: MsgRef;
  resolveProtocolRequestMessageRef(): ReplyTargetResolution<MsgRef>;
  createAdapter(log?: ProtocolLog): SurfaceAdapter;
  createProviderFailureAdapter(): SurfaceAdapter;
  createDescriptor(adapter: SurfaceAdapter): RegisteredSurfaceRuntimeDescriptor;
  createRelayPolicy(adapter: SurfaceAdapter): {
    readonly refs: {
      resolveInitialReplyTarget(input: {
        readonly requestId: string;
        readonly sessionId: string;
      }): ReplyTargetResolution<MsgRef>;
      readonly decodeReanchorTarget: unknown;
    };
  };
  createBridge(adapter: SurfaceAdapter, bus: LilacBus): ReturnType<typeof bridgeBusToAdapter>;
  observeOutputAborts(abortReasons: Array<string | undefined>): () => void;
  assertOutputCreated(
    created: readonly MsgRef[],
    finished: { readonly created: readonly MsgRef[] },
  ): void;
  assertFinalization(adapter: SurfaceAdapter, log: ProtocolLog): Promise<void>;
  assertActionRendered(log: ProtocolLog): void;
};

function discordConfig(): CoreConfig {
  const parsed = parseCoreConfigV1ToUniversal({
    surface: {
      discord: {
        botName: "lilac-test",
        allowedChannelIds: ["channel-1"],
      },
    },
  });
  return { ...parsed, agent: { ...parsed.agent, systemPrompt: "test" } };
}

function createProtocolLog(): ProtocolLog {
  return { creates: [], edits: [], deletes: [] };
}

function createGithubApi(
  log: ProtocolLog,
  input: { readonly createFailure?: GithubApiError } = {},
): GithubAdapterApi {
  let nextId = 100;
  return {
    getIssue: async () => ({ title: "Issue", body: "Body" }),
    listIssueComments: async () => [],
    createIssueComment: async ({ body }) => {
      if (input.createFailure) throw input.createFailure;
      log.creates.push(body);
      return { id: nextId++ };
    },
    getIssueComment: async ({ commentId }) => {
      if (commentId === 404) throw new GithubApiError(404, "/comments/404", "missing");
      return { id: commentId, body: "Comment" };
    },
    editIssueComment: async ({ body }) => {
      log.edits.push(body);
    },
    deleteIssueComment: async ({ commentId }) => {
      log.deletes.push(String(commentId));
    },
    createIssueReaction: async () => ({ id: 1 }),
    createIssueCommentReaction: async () => ({ id: 1 }),
    listIssueReactions: async () => [],
    listIssueCommentReactions: async () => [],
    deleteIssueReactionById: async () => undefined,
    deleteIssueCommentReactionById: async () => undefined,
    getGithubAppSlugOrNull: async () => "lilac-test",
  };
}

function reflectedString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Reflect.get(value, key);
  return typeof field === "string" ? field : undefined;
}

function reflectedArray(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const field = Reflect.get(value, key);
  return Array.isArray(field) ? field : [];
}

function createDiscordClient(
  log: ProtocolLog,
  input: { readonly channelFetchFailure?: object } = {},
) {
  let nextId = 100;
  const messages = new Map<string, object>();

  const createMessage = (options: unknown, forcedId?: string) => {
    const id = forcedId ?? String(nextId++);
    const message = {
      id,
      channelId: "channel-1",
      author: { id: "discord-bot" },
      content: reflectedString(options, "content") ?? "",
      embeds: reflectedArray(options, "embeds"),
      attachments: new Map<string, unknown>(),
      edit: async (next: unknown) => {
        log.edits.push(JSON.stringify(next));
        message.content = reflectedString(next, "content") ?? message.content;
        const embeds = reflectedArray(next, "embeds");
        if (embeds.length > 0) message.embeds = embeds;
        return message;
      },
      reply: async (next: unknown) => {
        log.creates.push(JSON.stringify(next));
        return createMessage(next);
      },
      delete: async () => {
        log.deletes.push(id);
      },
    };
    messages.set(id, message);
    return message;
  };

  const channel = {
    send: async (options: unknown) => {
      log.creates.push(JSON.stringify(options));
      return createMessage(options);
    },
    messages: {
      fetch: async (input: unknown) => {
        const messageId =
          typeof input === "string" ? input : (reflectedString(input, "message") ?? "missing");
        if (messageId === "missing") throw { code: 10_008 };
        return messages.get(messageId) ?? createMessage({}, messageId);
      },
    },
  };

  return {
    user: { id: "discord-bot" },
    channels: {
      fetch: async () => {
        if (input.channelFetchFailure) throw input.channelFetchFailure;
        return channel;
      },
    },
    destroy: async () => undefined,
  };
}

function createDiscordAdapter(
  log = createProtocolLog(),
  input: { readonly channelFetchFailure?: object } = {},
): DiscordAdapter {
  const adapter = new DiscordAdapter({
    config: discordConfig(),
    reportFatalPanic: () => undefined,
  });
  Reflect.set(adapter, "client", createDiscordClient(log, input));
  Reflect.set(adapter, "cfg", discordConfig());
  return adapter;
}

const DISCORD_REFERENCE: ReferenceContract = {
  platform: "discord",
  protocol: BUILTIN_SURFACE_PROTOCOLS.discord,
  sessionId: "channel-1",
  requestId: "discord:channel-1:origin",
  messageId: "origin",
  missingMessageId: "missing",
  expectedListSessionsError: "SurfaceUnavailable",
  expectedProviderOperation: "finish-output",
  createSessionRef: () => BUILTIN_SURFACE_PROTOCOLS.discord.refs.createSessionRef("channel-1"),
  createMessageRef: (messageId = "origin") =>
    BUILTIN_SURFACE_PROTOCOLS.discord.refs.createMessageRef(
      BUILTIN_SURFACE_PROTOCOLS.discord.refs.createSessionRef("channel-1"),
      messageId,
    ),
  foreignSessionRef: { platform: "github", channelId: "channel-1" },
  foreignMessageRef: {
    platform: "github",
    channelId: "channel-1",
    messageId: "wrong",
  },
  resolveProtocolRequestMessageRef: () =>
    BUILTIN_SURFACE_PROTOCOLS.discord.refs.resolveRequestMessageRef({
      requestId: "discord:channel-1:origin",
      sessionRef: BUILTIN_SURFACE_PROTOCOLS.discord.refs.createSessionRef("channel-1"),
    }),
  createAdapter: (log = createProtocolLog()) => createDiscordAdapter(log),
  createProviderFailureAdapter: () =>
    createDiscordAdapter(createProtocolLog(), { channelFetchFailure: { status: 503 } }),
  createDescriptor: (adapter) =>
    createDiscordSurfaceRuntimeDescriptor({
      adapter,
      adapterIngress: {
        start: async () => {
          throw new Error("Reference descriptor lifecycle is unused");
        },
      },
      createRelay: (guardedAdapter) => ({
        ...createDiscordRelayPolicy(guardedAdapter),
        lifecycle: {
          platform: "discord",
          start: async () => {
            throw new Error("Reference descriptor lifecycle is unused");
          },
        },
      }),
    }),
  createRelayPolicy: (adapter) => createDiscordRelayPolicy(adapter),
  createBridge: async (adapter, bus) =>
    bridgeBusToAdapter({
      adapter,
      blobStore: await getTestBlobStore(),
      bus,
      platform: "discord",
      policy: createDiscordRelayPolicy(adapter),
      subscriptionId: `reference-discord-${crypto.randomUUID()}`,
      idleTimeoutMs: 10_000,
    }),
  observeOutputAborts: (abortReasons) => {
    const abort = DiscordOutputStream.prototype.abort;
    const observed = spyOn(DiscordOutputStream.prototype, "abort").mockImplementation(
      function (this: DiscordOutputStream, reason) {
        abortReasons.push(reason);
        return abort.call(this, reason);
      },
    );
    return () => observed.mockRestore();
  },
  assertOutputCreated: (created, finished) => {
    expect(created).toEqual(finished.created);
  },
  assertFinalization: async (adapter, log) => {
    const skippedCleanup = createDiscordRelayPolicy(adapter).finalization?.cleanupSkippedOutput;
    if (!skippedCleanup) throw new Error("Discord skip cleanup is missing");
    await expect(
      skippedCleanup({
        ref: { platform: "discord", channelId: "channel-1", messageId: "skip" },
      }),
    ).resolves.toBeUndefined();
    expect(log.deletes).toContain("skip");
  },
  assertActionRendered: (log) => {
    expect(log.creates.some((entry) => entry.includes("Cancel"))).toBe(true);
  },
};

const GITHUB_REFERENCE: ReferenceContract = {
  platform: "github",
  protocol: BUILTIN_SURFACE_PROTOCOLS.github,
  sessionId: "octo/repo#1",
  requestId: "github:octo/repo#1:origin",
  messageId: "origin",
  missingMessageId: "404",
  expectedListSessionsError: "SurfaceOperationUnsupported",
  expectedProviderOperation: "send-message",
  createSessionRef: () => BUILTIN_SURFACE_PROTOCOLS.github.refs.createSessionRef("octo/repo#1"),
  createMessageRef: (messageId = "origin") =>
    BUILTIN_SURFACE_PROTOCOLS.github.refs.createMessageRef(
      BUILTIN_SURFACE_PROTOCOLS.github.refs.createSessionRef("octo/repo#1"),
      messageId,
    ),
  foreignSessionRef: { platform: "discord", channelId: "octo/repo#1" },
  foreignMessageRef: {
    platform: "discord",
    channelId: "octo/repo#1",
    messageId: "wrong",
  },
  resolveProtocolRequestMessageRef: () =>
    BUILTIN_SURFACE_PROTOCOLS.github.refs.resolveRequestMessageRef({
      requestId: "github:octo/repo#1:origin",
      sessionRef: BUILTIN_SURFACE_PROTOCOLS.github.refs.createSessionRef("octo/repo#1"),
    }),
  createAdapter: (log = createProtocolLog()) => new GithubAdapter({ api: createGithubApi(log) }),
  createProviderFailureAdapter: () =>
    new GithubAdapter({
      api: createGithubApi(createProtocolLog(), {
        createFailure: new GithubApiError(503, "/repos/octo/repo/issues/1/comments", "unavailable"),
      }),
    }),
  createDescriptor: (adapter) =>
    createGithubSurfaceRuntimeDescriptor({
      adapter,
      createRelay: () => ({
        ...createGithubRelayPolicy(),
        lifecycle: {
          platform: "github",
          start: async () => {
            throw new Error("Reference descriptor lifecycle is unused");
          },
        },
      }),
    }),
  createRelayPolicy: () => createGithubRelayPolicy(),
  createBridge: async (adapter, bus) =>
    bridgeBusToAdapter({
      adapter,
      blobStore: await getTestBlobStore(),
      bus,
      platform: "github",
      policy: createGithubRelayPolicy(),
      subscriptionId: `reference-github-${crypto.randomUUID()}`,
      idleTimeoutMs: 10_000,
    }),
  observeOutputAborts: (abortReasons) => {
    const abort = GithubOutputStream.prototype.abort;
    const observed = spyOn(GithubOutputStream.prototype, "abort").mockImplementation(
      function (this: GithubOutputStream, reason) {
        abortReasons.push(reason);
        return abort.call(this, reason);
      },
    );
    return () => observed.mockRestore();
  },
  assertOutputCreated: (created) => {
    expect(created).toEqual([]);
  },
  assertFinalization: async () => {
    expect(createGithubRelayPolicy().finalization?.cleanupSkippedOutput).toBeUndefined();
    const requestId = `github-ack-${crypto.randomUUID()}`;
    const deleted: number[] = [];
    setGithubAck(requestId, {
      target: { kind: "issue", issueNumber: 1 },
      reactionId: 42,
    });
    try {
      const cleanup = createGithubRelayPolicy({
        acknowledgementApi: {
          deleteIssueReactionById: async ({ reactionId }) => {
            deleted.push(reactionId);
          },
          deleteIssueCommentReactionById: async () => undefined,
        },
      }).finalization?.clearIngressAcknowledgement;
      if (!cleanup) throw new Error("GitHub acknowledgement cleanup is missing");
      expect(await cleanup({ requestId, sessionId: "octo/repo#1" })).toEqual(Result.ok(undefined));
      expect(deleted).toEqual([42]);
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  },
  assertActionRendered: (log) => {
    expect(log.edits.some((entry) => entry.includes("Cancel"))).toBe(true);
  },
};

const REFERENCE_CASES = [
  ["Discord", DISCORD_REFERENCE],
  ["GitHub", GITHUB_REFERENCE],
] as const;

function registryFor(descriptors: readonly RegisteredSurfaceRuntimeDescriptor[]) {
  const created = SurfaceRuntimeRegistry.create(descriptors);
  if (created.status === "error") throw created.error;
  return created.value;
}

function bindReferenceDescriptor(
  reference: ReferenceContract,
  adapter: SurfaceAdapter,
): RegisteredBoundSurfaceRuntimeDescriptor {
  const [descriptor] = registryFor([reference.createDescriptor(adapter)]).entries();
  if (!descriptor) throw new Error("Reference descriptor is missing");
  return descriptor;
}

function operationError<T>(result: ResultType<T, SurfaceOperationError>): SurfaceOperationError {
  expect(result.status).toBe("error");
  if (result.status === "ok") throw new Error("Expected a surface operation error");
  return result.error;
}

describe("shared Discord/GitHub adapter and descriptor contract", () => {
  it("projects persisted message triples through the built-in protocol catalog", () => {
    for (const protocol of Object.values(BUILTIN_SURFACE_PROTOCOLS)) {
      expect(
        projectBuiltinSurfaceMessageRef({
          platform: protocol.platform,
          channelId: "channel",
          messageId: "message",
        }),
      ).toEqual({ platform: protocol.platform, channelId: "channel", messageId: "message" });
    }
    expect(
      projectBuiltinSurfaceMessageRef({
        platform: "unknown",
        channelId: "channel",
        messageId: "message",
      }),
    ).toBeNull();
  });

  it("classifies foreign request IDs through catalog composition", () => {
    const discordSession = BUILTIN_SURFACE_PROTOCOLS.discord.refs.createSessionRef("channel");
    const githubSession = BUILTIN_SURFACE_PROTOCOLS.github.refs.createSessionRef("octo/repo#1");

    expect(
      BUILTIN_SURFACE_PROTOCOLS.discord.refs.resolveRequestMessageRef({
        requestId: "github:octo/repo#1:10",
        sessionRef: discordSession,
      }),
    ).toEqual({ kind: "none" });
    expect(
      resolveBuiltinSurfaceRequestMessageRef({
        protocol: BUILTIN_SURFACE_PROTOCOLS.discord,
        requestId: "github:octo/repo#1:10",
        sessionRef: discordSession,
      }),
    ).toMatchObject({ kind: "invalid", error: { reason: "platform-mismatch" } });
    expect(
      resolveBuiltinSurfaceRequestMessageRef({
        protocol: BUILTIN_SURFACE_PROTOCOLS.github,
        requestId: "discord:channel:message",
        sessionRef: githubSession,
      }),
    ).toMatchObject({ kind: "invalid", error: { reason: "platform-mismatch" } });
  });

  it("infers tool defaults by scanning protocol-local request ID parsers", () => {
    expect(inferBuiltinSurfaceToolRequestTarget("discord:channel:message")).toEqual({
      sessionId: "channel",
      messageId: "message",
    });
    expect(inferBuiltinSurfaceToolRequestTarget("github:octo/repo#1:10")).toEqual({
      sessionId: "octo/repo#1",
      messageId: "10",
    });
    expect(inferBuiltinSurfaceToolRequestTarget("req:generic")).toBeNull();
  });

  it.each(REFERENCE_CASES)(
    "%s uses the catalog as the sole ref-routing implementation",
    (_name, reference) => {
      const session = reference.createSessionRef();
      const message = reference.createMessageRef();
      const policy = reference.createRelayPolicy(reference.createAdapter());

      expect(session).toEqual({ platform: reference.platform, channelId: reference.sessionId });
      expect(message).toEqual({
        platform: reference.platform,
        channelId: reference.sessionId,
        messageId: reference.messageId,
      });
      expect(
        policy.refs.resolveInitialReplyTarget({
          requestId: reference.requestId,
          sessionId: reference.sessionId,
        }) as ReplyTargetResolution<MsgRef>,
      ).toEqual(reference.resolveProtocolRequestMessageRef());
      expect(policy.refs.decodeReanchorTarget).toBe(reference.protocol.refs.decodeMessageRef);
    },
  );

  it.each(REFERENCE_CASES)(
    "%s reanchors and cancels through shared relay bus handlers",
    async (_name, reference) => {
      const abortReasons: Array<string | undefined> = [];
      const restoreAbortObserver = reference.observeOutputAborts(abortReasons);
      const bus = createLilacBus(createInMemoryDeliveryBus());
      const descriptor = bindReferenceDescriptor(reference, reference.createAdapter());
      const bridge = await reference.createBridge(descriptor.adapter, bus);
      try {
        await bus.publish(
          lilacEventTypes.EvtRequestReply,
          {},
          {
            headers: {
              request_id: reference.requestId,
              session_id: reference.sessionId,
              request_client: reference.platform,
            },
          },
        );
        await bus.publish(
          lilacEventTypes.EvtAgentOutputDeltaText,
          { delta: "before" },
          { headers: { request_id: reference.requestId } },
        );
        await bus.publish(
          lilacEventTypes.CmdSurfaceOutputReanchor,
          { inheritReplyTo: true },
          {
            headers: {
              request_id: reference.requestId,
              session_id: reference.sessionId,
              request_client: reference.platform,
            },
          },
        );
        expect(abortReasons).toContain("reanchor");

        await bus.publish(
          lilacEventTypes.EvtAgentOutputDeltaText,
          { delta: " after" },
          { headers: { request_id: reference.requestId } },
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
              request_id: reference.requestId,
              session_id: reference.sessionId,
              request_client: reference.platform,
            },
          },
        );
        expect(abortReasons).toContain("cancel");
      } finally {
        restoreAbortObserver();
        await bridge.stop();
        await bus.close();
      }
    },
  );

  it.each(REFERENCE_CASES)(
    "%s returns the closed operation algebra, validates nested refs, and declares optional behavior",
    async (_name, reference) => {
      const adapter = reference.createAdapter();
      const primary = operationError(await adapter.startOutput(reference.foreignSessionRef));
      expect(primary).toBeInstanceOf(SurfacePlatformMismatch);

      const nestedPlatform = operationError(
        await adapter.startOutput(reference.createSessionRef(), {
          replyTo: reference.foreignMessageRef,
        }),
      );
      expect(nestedPlatform).toBeInstanceOf(SurfacePlatformMismatch);

      const nestedSession = operationError(
        await adapter.markRead(reference.createSessionRef(), {
          ...reference.createMessageRef(),
          channelId: `${reference.sessionId}-other`,
        }),
      );
      expect(nestedSession).toBeInstanceOf(SurfaceSessionMismatch);

      const invalid = operationError(
        await adapter.sendMsg(reference.createSessionRef(), { text: "   " }),
      );
      expect(invalid).toBeInstanceOf(SurfaceInvalidInput);

      const declared = operationError(await adapter.listSessions());
      expect(declared._tag).toBe(reference.expectedListSessionsError);

      const provider = await reference
        .createProviderFailureAdapter()
        .sendMsg(reference.createSessionRef(), { text: "provider failure" });
      expect(provider.status).toBe("error");
      if (provider.status === "ok") throw new Error("Expected provider failure");
      expect(provider.error._tag).toBe("SurfaceUnavailable");
      if (provider.error._tag !== "SurfaceUnavailable") throw provider.error;
      expect(provider.error.platform).toBe(reference.platform);
      expect(provider.error.operation).toBe(reference.expectedProviderOperation);
    },
  );

  it.each(REFERENCE_CASES)(
    "%s owns output creation, finalization, skip, and cleanup outcomes",
    async (_name, reference) => {
      const log = createProtocolLog();
      const adapter = reference.createAdapter(log);
      const descriptor = bindReferenceDescriptor(reference, adapter);
      const created: MsgRef[] = [];
      const started = await descriptor.adapter.startOutput(reference.createSessionRef(), {
        onMessageCreated: (ref) => created.push(ref),
      });
      if (started.status === "error") throw started.error;
      const finished = await started.value.finish();
      if (finished.status === "error") throw finished.error;
      expect(finished.value.created.length).toBeGreaterThan(0);
      expect(finished.value.created.every((ref) => ref.platform === reference.platform)).toBe(true);
      expect(finished.value.last.platform).toBe(reference.platform);
      reference.assertOutputCreated(created, finished.value);

      const relay = descriptor.relay;
      if (!relay) throw new Error("Reference relay is missing");
      const valid = relay.refs.decodeReanchorTarget({
        ref: reference.createMessageRef(),
        expectedSessionId: reference.sessionId,
      });
      expect(valid.status).toBe("ok");
      const crossPlatform = relay.refs.decodeReanchorTarget({
        ref: reference.foreignMessageRef,
        expectedSessionId: reference.sessionId,
      });
      expect(crossPlatform.status).toBe("error");

      const initial = relay.refs.resolveInitialReplyTarget({
        requestId: reference.requestId,
        sessionId: reference.sessionId,
      });
      expect(initial.kind).toBe("target");
      await reference.assertFinalization(adapter, log);
    },
  );

  it.each(REFERENCE_CASES)(
    "%s workflow progress checks, sends, edits, and preserves actions",
    async (_name, reference) => {
      const log = createProtocolLog();
      const descriptor = bindReferenceDescriptor(reference, reference.createAdapter(log));
      const port = descriptor.workflowProgress;
      if (!port) throw new Error("Reference workflow progress port is missing");

      expect(
        await port.checkMessage({
          channelId: reference.sessionId,
          messageId: reference.missingMessageId,
        }),
      ).toEqual(Result.ok("missing"));
      const sent = await port.send({
        channelId: reference.sessionId,
        replyToMessageId: reference.messageId,
        silent: true,
        content: {
          text: "Queued",
          actions: [{ actionId: "cancel", label: "Cancel", style: "danger" }],
        },
      });
      if (sent.status === "error") throw new Error(`Unexpected ${reference.platform} send failure`);
      expect(sent.value.platform).toBe(reference.platform);
      reference.assertActionRendered(log);

      const edited = await port.edit(
        { channelId: reference.sessionId, messageId: sent.value.messageId },
        { text: "Running" },
      );
      expect(edited.status).toBe("ok");
    },
  );
});
