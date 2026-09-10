import {
  lilacEventTypes,
  type LilacBus,
  type BusMessageV2,
  type CmdRequestMessageData,
  type CorePrimaryLineageV2,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import type { BlobHandleV1, BlobStore } from "@stanley2058/lilac-blob-storage";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import type { SurfaceAdapter } from "../../adapter";
import type { MsgRef, SurfaceMessage } from "../../types";
import type { TranscriptStore } from "../../../transcript/transcript-store";
import type { ResourceRegistry } from "../../../resource";
import { adaptEventPublishResultToHost } from "../../../shared/event-bus-result";
import type { DiscordAttachmentCacheAccess } from "../discord-attachment";
import type { DiscordMessageCacheAccess } from "../../store/discord-search-store";
import {
  collectCoreRequestInputHandles,
  corePreparedEnvelopeFromCommand,
  type CorePreparedRequestEnvelope,
} from "../../bridge/request-delivery";
import {
  composeRecentChannelMessages,
  composeRequestMessages,
  composeSingleMessageWithLineage,
  type RequestCompositionError,
} from "../../bridge/request-composition";
import {
  deleteDiscordRequestBlobHandles,
  type DiscordRequestBlobCleanupFailed,
} from "../../bridge/request-composition/attachments";
import { buildDiscordUserAliasById, previewText, type SessionMode } from "./common";

export type PublishBusRequestInput = {
  requestDeliveryId: string;
  requestId: string;
  sessionId: string;
  sessionConfigId: string;
  parentChannelId?: string;
  queue: RequestQueueMode;
  triggerType: "mention" | "reply" | "active";
  sessionMode: SessionMode;
  modelOverride?: string;
  messages: BusMessageV2[];
  inputHandles: readonly BlobHandleV1[];
  corePrimaryLineage: CorePrimaryLineageV2;
  originMessage: SurfaceMessage | null;
  raw: unknown;
};

export class DiscordRequestDeliveryFailed extends TaggedError("DiscordRequestDeliveryFailed")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class DiscordRequestPublishAndCleanupFailed extends TaggedError(
  "DiscordRequestPublishAndCleanupFailed",
)<{
  readonly primary: RequestCompositionError | DiscordRequestDeliveryFailed;
  readonly cleanup: DiscordRequestBlobCleanupFailed;
  readonly message: string;
}> {}

export type DiscordRequestDeliveryPort = {
  prepareAndPublish(input: {
    readonly requestDeliveryId: string;
    readonly requestId: string;
    readonly envelope: CorePreparedRequestEnvelope;
    readonly inputHandles: readonly BlobHandleV1[];
  }): Promise<ResultType<void, DiscordRequestDeliveryFailed>>;
};

export type DiscordRequestPublishError =
  | RequestCompositionError
  | DiscordRequestDeliveryFailed
  | DiscordRequestPublishAndCleanupFailed;

type DiscordRequestCompositionDependencies = {
  readonly blobStore: BlobStore;
  readonly resourceRegistry: ResourceRegistry;
  readonly attachmentCache?: DiscordAttachmentCacheAccess;
  readonly messageCache?: DiscordMessageCacheAccess;
  readonly requestDelivery: DiscordRequestDeliveryPort;
};

function isExactMessageRef(message: SurfaceMessage, ref: MsgRef): boolean {
  return (
    message.ref.platform === ref.platform &&
    message.ref.channelId === ref.channelId &&
    message.ref.messageId === ref.messageId
  );
}

export async function resolveCorrelatedOriginMessage(input: {
  adapter: SurfaceAdapter;
  ref: MsgRef;
  ingressMessages?: readonly SurfaceMessage[];
}): Promise<ResultType<SurfaceMessage | null, RequestCompositionError>> {
  const ingress = input.ingressMessages?.find((message) => isExactMessageRef(message, input.ref));
  return ingress ? Result.ok(ingress) : input.adapter.readMsg(input.ref);
}

function getLastUserPreview(messages: readonly BusMessageV2[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return previewText(message.content);
  }
  return undefined;
}

function uniqueNonEmptyStrings(
  values: readonly (string | undefined)[],
  options: { exclude?: string } = {},
): string[] {
  const exclude = options.exclude?.trim();
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => !!value && value !== exclude),
    ),
  ];
}

async function failDiscordRequestAfterHandleCleanup(input: {
  readonly blobStore: Pick<BlobStore, "delete">;
  readonly handles: readonly BlobHandleV1[];
  readonly primary: RequestCompositionError | DiscordRequestDeliveryFailed;
}): Promise<ResultType<never, DiscordRequestPublishError>> {
  const cleanup = await deleteDiscordRequestBlobHandles(input.blobStore, input.handles);
  return cleanup.match<ResultType<never, DiscordRequestPublishError>>({
    ok: () => Result.err(input.primary),
    err: (cleanupError) =>
      Result.err(
        new DiscordRequestPublishAndCleanupFailed({
          primary: input.primary,
          cleanup: cleanupError,
          message: "Discord request publication prerequisite and input handle cleanup failed",
        }),
      ),
  });
}

export async function publishBusRequest(params: {
  logger: Logger;
  blobStore: Pick<BlobStore, "delete">;
  requestDelivery: DiscordRequestDeliveryPort;
  input: PublishBusRequestInput;
}): Promise<
  ResultType<void, DiscordRequestDeliveryFailed | DiscordRequestPublishAndCleanupFailed>
> {
  params.logger.debug("cmd.request.message publish", {
    requestId: params.input.requestId,
    sessionId: params.input.sessionId,
    queue: params.input.queue,
    triggerType: params.input.triggerType,
    modelOverride: params.input.modelOverride,
    messageCount: params.input.messages.length,
    lastUserPreview: getLastUserPreview(params.input.messages),
  });

  const data = {
    requestDeliveryId: params.input.requestDeliveryId,
    queue: params.input.queue,
    messages: params.input.messages,
    corePrimaryLineage: params.input.corePrimaryLineage,
    ...(params.input.modelOverride ? { modelOverride: params.input.modelOverride } : {}),
    raw: {
      ...(params.input.raw && typeof params.input.raw === "object" ? params.input.raw : {}),
      authenticatedOrigin: params.input.originMessage
        ? {
            platform: "discord",
            userId: params.input.originMessage.userId,
            messageRef: params.input.originMessage.ref,
          }
        : undefined,
      sessionMode: params.input.sessionMode,
      sessionConfigId: params.input.sessionConfigId,
      ...(params.input.parentChannelId ? { parentChannelId: params.input.parentChannelId } : {}),
      ...(params.input.modelOverride ? { modelOverride: params.input.modelOverride } : {}),
    },
  } satisfies CmdRequestMessageData;
  const envelope = corePreparedEnvelopeFromCommand({
    data,
    headers: {
      request_id: params.input.requestId,
      session_id: params.input.sessionId,
      request_client: "discord",
    },
  });
  const continueEnvelope = envelope.match<
    () => Promise<
      ResultType<void, DiscordRequestDeliveryFailed | DiscordRequestPublishAndCleanupFailed>
    >
  >({
    err: (cause) => async () => {
      const primary = new DiscordRequestDeliveryFailed({
        cause,
        message: "Discord request failed its prepared delivery envelope codec",
      });
      const cleanup = await deleteDiscordRequestBlobHandles(
        params.blobStore,
        params.input.inputHandles,
      );
      return cleanup.match<
        ResultType<void, DiscordRequestDeliveryFailed | DiscordRequestPublishAndCleanupFailed>
      >({
        ok: () => Result.err(primary),
        err: (cleanupError) =>
          Result.err(
            new DiscordRequestPublishAndCleanupFailed({
              primary,
              cleanup: cleanupError,
              message: "Discord request envelope validation and input handle cleanup failed",
            }),
          ),
      });
    },
    ok: (preparedEnvelope) => async () =>
      params.requestDelivery.prepareAndPublish({
        requestDeliveryId: params.input.requestDeliveryId,
        requestId: params.input.requestId,
        envelope: preparedEnvelope,
        inputHandles: collectCoreRequestInputHandles(preparedEnvelope),
      }),
  });
  return continueEnvelope();
}

export async function publishComposedRequest(
  params: {
    adapter: SurfaceAdapter;
    cfg: CoreConfig;
    transcriptStore?: TranscriptStore;
    logger: Logger;
    input: {
      requestId: string;
      sessionId: string;
      sessionConfigId: string;
      parentChannelId?: string;
      queue: RequestQueueMode;
      triggerType: "mention" | "reply" | "active";
      msgRef: MsgRef;
      ingressMessages?: readonly SurfaceMessage[];
      sessionMode: SessionMode;
      modelOverride?: string;
      currentMessageIds?: readonly string[];
      transformTriggerUserText?: (text: string) => string;
      transformUserTextForMessageId?: string;
    };
  } & DiscordRequestCompositionDependencies,
): Promise<ResultType<void, DiscordRequestPublishError>> {
  const requestDeliveryId = crypto.randomUUID();
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed = await composeRequestMessages(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    transcriptStore: params.transcriptStore,
    blobStore: params.blobStore,
    resourceRegistry: params.resourceRegistry,
    attachmentCache: params.attachmentCache,
    attachmentCacheTtl: params.cfg.surface.discord.attachmentCache.ttlMs,
    messageCache: params.messageCache,
    ingressMessages: params.input.ingressMessages,
    currentRequestId: params.input.requestId,
    currentMessageIds: params.input.currentMessageIds ?? [params.input.msgRef.messageId],
    discordUserAliasById,
    transformUserText: params.input.transformTriggerUserText,
    transformUserTextForMessageId: params.input.transformUserTextForMessageId,
    trigger: {
      type: params.input.triggerType === "mention" ? "mention" : "reply",
      msgRef: params.input.msgRef,
    },
  });
  const continuePublish = composed.match<
    () => Promise<ResultType<void, DiscordRequestPublishError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      const originMessageResult = await resolveCorrelatedOriginMessage({
        adapter: params.adapter,
        ref: params.input.msgRef,
        ingressMessages: params.input.ingressMessages,
      });
      const continueOrigin = originMessageResult.match<
        () => Promise<ResultType<void, DiscordRequestPublishError>>
      >({
        err: (error) => async () =>
          failDiscordRequestAfterHandleCleanup({
            blobStore: params.blobStore,
            handles: composition.inputHandles,
            primary: error,
          }),
        ok: (originMessage) => async () =>
          publishBusRequest({
            logger: params.logger,
            blobStore: params.blobStore,
            requestDelivery: params.requestDelivery,
            input: {
              requestDeliveryId,
              requestId: params.input.requestId,
              sessionId: params.input.sessionId,
              sessionConfigId: params.input.sessionConfigId,
              parentChannelId: params.input.parentChannelId,
              queue: params.input.queue,
              triggerType: params.input.triggerType,
              sessionMode: params.input.sessionMode,
              modelOverride: params.input.modelOverride,
              messages: composition.messages,
              inputHandles: composition.inputHandles,
              corePrimaryLineage: composition.corePrimaryLineage,
              originMessage,
              raw: {
                triggerType: params.input.triggerType,
                chainMessageIds: composition.chainMessageIds,
                mergedGroups: composition.mergedGroups,
                participantUserIds: uniqueNonEmptyStrings(
                  composition.mergedGroups.map((group) => group.authorId),
                  { exclude: self.userId },
                ),
              },
            },
          }),
      });
      return continueOrigin();
    },
  });
  return continuePublish();
}

export async function publishActiveChannelPrompt(
  params: {
    adapter: SurfaceAdapter;
    cfg: CoreConfig;
    transcriptStore?: TranscriptStore;
    logger: Logger;
    input: {
      requestId: string;
      sessionId: string;
      sessionConfigId: string;
      parentChannelId?: string;
      triggerMsgRef: MsgRef | undefined;
      ingressMessages?: readonly SurfaceMessage[];
      triggerType: "mention" | "reply" | undefined;
      sessionMode: SessionMode;
      modelOverride?: string;
      currentMessageIds?: readonly string[];
      botMentionNames?: readonly string[];
      transformTriggerUserText?: (text: string) => string;
      transformUserTextForMessageId?: string;
    };
  } & DiscordRequestCompositionDependencies,
): Promise<ResultType<void, DiscordRequestPublishError>> {
  const requestDeliveryId = crypto.randomUUID();
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed =
    params.input.triggerMsgRef && params.input.triggerType === "reply"
      ? await composeRequestMessages(params.adapter, {
          platform: "discord",
          botUserId: self.userId,
          botName: params.cfg.surface.discord.botName,
          transcriptStore: params.transcriptStore,
          blobStore: params.blobStore,
          resourceRegistry: params.resourceRegistry,
          attachmentCache: params.attachmentCache,
          attachmentCacheTtl: params.cfg.surface.discord.attachmentCache.ttlMs,
          messageCache: params.messageCache,
          ingressMessages: params.input.ingressMessages,
          currentRequestId: params.input.requestId,
          currentMessageIds:
            params.input.currentMessageIds ??
            (params.input.triggerMsgRef ? [params.input.triggerMsgRef.messageId] : []),
          discordUserAliasById,
          transformUserText: params.input.transformTriggerUserText,
          transformUserTextForMessageId: params.input.transformUserTextForMessageId,
          trigger: {
            type: "reply",
            msgRef: params.input.triggerMsgRef,
          },
        })
      : await composeRecentChannelMessages(params.adapter, {
          platform: "discord",
          sessionId: params.input.sessionId,
          botUserId: self.userId,
          botName: params.cfg.surface.discord.botName,
          botMentionNames: params.input.botMentionNames,
          limit: 8,
          transcriptStore: params.transcriptStore,
          blobStore: params.blobStore,
          resourceRegistry: params.resourceRegistry,
          attachmentCache: params.attachmentCache,
          attachmentCacheTtl: params.cfg.surface.discord.attachmentCache.ttlMs,
          messageCache: params.messageCache,
          ingressMessages: params.input.ingressMessages,
          currentRequestId: params.input.requestId,
          currentMessageIds:
            params.input.currentMessageIds ??
            (params.input.triggerMsgRef ? [params.input.triggerMsgRef.messageId] : []),
          discordUserAliasById,
          transformUserText: params.input.transformTriggerUserText,
          transformUserTextForMessageId: params.input.transformUserTextForMessageId,
          triggerMsgRef: params.input.triggerMsgRef,
          triggerType: params.input.triggerType,
        });
  const continueComposition = composed.match<
    () => Promise<ResultType<void, DiscordRequestPublishError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      const originMessageResult: ResultType<SurfaceMessage | null, RequestCompositionError> = params
        .input.triggerMsgRef
        ? await resolveCorrelatedOriginMessage({
            adapter: params.adapter,
            ref: params.input.triggerMsgRef,
            ingressMessages: params.input.ingressMessages,
          })
        : Result.ok<SurfaceMessage | null>(null);
      const continueOrigin = originMessageResult.match<
        () => Promise<ResultType<void, DiscordRequestPublishError>>
      >({
        err: (error) => async () => {
          return failDiscordRequestAfterHandleCleanup({
            blobStore: params.blobStore,
            handles: composition.inputHandles,
            primary: error,
          });
        },
        ok: (originMessage) => async () => {
          return publishBusRequest({
            logger: params.logger,
            blobStore: params.blobStore,
            requestDelivery: params.requestDelivery,
            input: {
              requestDeliveryId,
              requestId: params.input.requestId,
              sessionId: params.input.sessionId,
              sessionConfigId: params.input.sessionConfigId,
              parentChannelId: params.input.parentChannelId,
              queue: "prompt",
              triggerType: params.input.triggerType ?? "active",
              sessionMode: params.input.sessionMode,
              modelOverride: params.input.modelOverride,
              messages: composition.messages,
              inputHandles: composition.inputHandles,
              corePrimaryLineage: composition.corePrimaryLineage,
              originMessage,
              raw: {
                triggerType: params.input.triggerType ?? "active",
                chainMessageIds: composition.chainMessageIds,
                mergedGroups: composition.mergedGroups,
                participantUserIds: uniqueNonEmptyStrings(
                  composition.mergedGroups.map((group) => group.authorId),
                  { exclude: self.userId },
                ),
              },
            },
          });
        },
      });
      return continueOrigin();
    },
  });
  return continueComposition();
}

export async function publishSingleMessageToActiveRequest(
  params: {
    adapter: SurfaceAdapter;
    cfg: CoreConfig;
    transcriptStore?: TranscriptStore;
    logger: Logger;
    input: {
      requestId: string;
      sessionId: string;
      sessionConfigId: string;
      parentChannelId?: string;
      queue: "followUp" | "steer" | "interrupt";
      msgRef: MsgRef;
      ingressMessage?: SurfaceMessage;
      sessionMode: SessionMode;
      modelOverride?: string;
      transformUserText?: (text: string) => string;
    };
  } & DiscordRequestCompositionDependencies,
): Promise<ResultType<void, DiscordRequestPublishError>> {
  const requestDeliveryId = crypto.randomUUID();
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);
  const ingressMessage =
    params.input.ingressMessage &&
    isExactMessageRef(params.input.ingressMessage, params.input.msgRef)
      ? params.input.ingressMessage
      : undefined;

  const composed = await composeSingleMessageWithLineage(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    msgRef: params.input.msgRef,
    discordUserAliasById,
    transcriptStore: params.transcriptStore,
    blobStore: params.blobStore,
    resourceRegistry: params.resourceRegistry,
    attachmentCache: params.attachmentCache,
    attachmentCacheTtl: params.cfg.surface.discord.attachmentCache.ttlMs,
    messageCache: params.messageCache,
    ingressMessages: ingressMessage ? [ingressMessage] : undefined,
    transformUserText: params.input.transformUserText,
  });
  const continueComposition = composed.match<
    () => Promise<ResultType<void, DiscordRequestPublishError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      if (!composition) return Result.ok(undefined);
      const surfaceMessageResult = ingressMessage
        ? Result.ok(ingressMessage)
        : await params.adapter.readMsg(params.input.msgRef);
      const continueMessage = surfaceMessageResult.match<
        () => Promise<ResultType<void, DiscordRequestPublishError>>
      >({
        err: (error) => async () => {
          return failDiscordRequestAfterHandleCleanup({
            blobStore: params.blobStore,
            handles: composition.inputHandles,
            primary: error,
          });
        },
        ok: (surfaceMessage) => async () => {
          return publishBusRequest({
            logger: params.logger,
            blobStore: params.blobStore,
            requestDelivery: params.requestDelivery,
            input: {
              requestDeliveryId,
              requestId: params.input.requestId,
              sessionId: params.input.sessionId,
              sessionConfigId: params.input.sessionConfigId,
              parentChannelId: params.input.parentChannelId,
              queue: params.input.queue,
              triggerType: "active",
              sessionMode: params.input.sessionMode,
              modelOverride: params.input.modelOverride,
              messages: composition.messages,
              inputHandles: composition.inputHandles,
              corePrimaryLineage: composition.corePrimaryLineage,
              originMessage: surfaceMessage,
              raw: {
                triggerType: "active",
                participantUserIds: uniqueNonEmptyStrings([surfaceMessage?.userId], {
                  exclude: self.userId,
                }),
              },
            },
          });
        },
      });
      return continueMessage();
    },
  });
  return continueComposition();
}

export async function publishSingleMessagePrompt(
  params: {
    adapter: SurfaceAdapter;
    cfg: CoreConfig;
    transcriptStore?: TranscriptStore;
    logger: Logger;
    input: {
      requestId: string;
      sessionId: string;
      sessionConfigId: string;
      parentChannelId?: string;
      msgRef: MsgRef;
      ingressMessage?: SurfaceMessage;
      sessionMode: SessionMode;
      modelOverride?: string;
      transformUserText?: (text: string) => string;
      raw?: Record<string, unknown>;
    };
  } & DiscordRequestCompositionDependencies,
): Promise<ResultType<void, DiscordRequestPublishError>> {
  const requestDeliveryId = crypto.randomUUID();
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);
  const ingressMessage =
    params.input.ingressMessage &&
    isExactMessageRef(params.input.ingressMessage, params.input.msgRef)
      ? params.input.ingressMessage
      : undefined;

  const composed = await composeSingleMessageWithLineage(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    msgRef: params.input.msgRef,
    discordUserAliasById,
    transcriptStore: params.transcriptStore,
    blobStore: params.blobStore,
    resourceRegistry: params.resourceRegistry,
    attachmentCache: params.attachmentCache,
    attachmentCacheTtl: params.cfg.surface.discord.attachmentCache.ttlMs,
    messageCache: params.messageCache,
    ingressMessages: ingressMessage ? [ingressMessage] : undefined,
    transformUserText: params.input.transformUserText,
  });
  const continueComposition = composed.match<
    () => Promise<ResultType<void, DiscordRequestPublishError>>
  >({
    err: (error) => async () => Result.err(error),
    ok: (composition) => async () => {
      if (!composition) return Result.ok(undefined);
      const surfaceMessageResult = ingressMessage
        ? Result.ok(ingressMessage)
        : await params.adapter.readMsg(params.input.msgRef);
      const continueMessage = surfaceMessageResult.match<
        () => Promise<ResultType<void, DiscordRequestPublishError>>
      >({
        err: (error) => async () => {
          return failDiscordRequestAfterHandleCleanup({
            blobStore: params.blobStore,
            handles: composition.inputHandles,
            primary: error,
          });
        },
        ok: (surfaceMessage) => async () => {
          return publishBusRequest({
            logger: params.logger,
            blobStore: params.blobStore,
            requestDelivery: params.requestDelivery,
            input: {
              requestDeliveryId,
              requestId: params.input.requestId,
              sessionId: params.input.sessionId,
              sessionConfigId: params.input.sessionConfigId,
              parentChannelId: params.input.parentChannelId,
              queue: "prompt",
              triggerType: "active",
              sessionMode: params.input.sessionMode,
              modelOverride: params.input.modelOverride,
              messages: composition.messages,
              inputHandles: composition.inputHandles,
              corePrimaryLineage: composition.corePrimaryLineage,
              originMessage: surfaceMessage,
              raw: {
                triggerType: "active",
                chainMessageIds: [params.input.msgRef.messageId],
                participantUserIds: uniqueNonEmptyStrings([surfaceMessage?.userId], {
                  exclude: self.userId,
                }),
                ...params.input.raw,
              },
            },
          });
        },
      });
      return continueMessage();
    },
  });
  return continueComposition();
}

export async function publishSurfaceOutputReanchor(input: {
  bus: LilacBus;
  requestId: string;
  sessionId: string;
  inheritReplyTo: boolean;
  replyTo?: MsgRef;
  mode?: "steer" | "interrupt";
}) {
  adaptEventPublishResultToHost(
    await input.bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      {
        inheritReplyTo: input.inheritReplyTo,
        mode: input.mode,
        replyTo: input.replyTo
          ? {
              platform: input.replyTo.platform,
              channelId: input.replyTo.channelId,
              messageId: input.replyTo.messageId,
            }
          : undefined,
      },
      {
        headers: {
          request_id: input.requestId,
          session_id: input.sessionId,
          request_client: "discord",
        },
      },
    ),
  );
}
