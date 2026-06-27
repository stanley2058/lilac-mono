import type { ModelMessage } from "ai";

import {
  lilacEventTypes,
  type LilacBus,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";

import type { SurfaceAdapter } from "../../adapter";
import type { MsgRef } from "../../types";
import type { TranscriptStore } from "../../../transcript/transcript-store";
import {
  composeRecentChannelMessages,
  composeRequestMessages,
  composeSingleMessage,
} from "../request-composition";
import { buildDiscordUserAliasById, previewText, type SessionMode } from "./common";

export type PublishBusRequestInput = {
  requestId: string;
  sessionId: string;
  sessionConfigId: string;
  parentChannelId?: string;
  queue: RequestQueueMode;
  triggerType: "mention" | "reply" | "active";
  sessionMode: SessionMode;
  modelOverride?: string;
  messages: ModelMessage[];
  raw: unknown;
};

function getLastUserPreview(messages: readonly ModelMessage[]): string | undefined {
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

export async function publishBusRequest(params: {
  logger: Logger;
  bus: LilacBus;
  input: PublishBusRequestInput;
}) {
  params.logger.debug("cmd.request.message publish", {
    requestId: params.input.requestId,
    sessionId: params.input.sessionId,
    queue: params.input.queue,
    triggerType: params.input.triggerType,
    modelOverride: params.input.modelOverride,
    messageCount: params.input.messages.length,
    lastUserPreview: getLastUserPreview(params.input.messages),
  });

  await params.bus.publish(
    lilacEventTypes.CmdRequestMessage,
    {
      queue: params.input.queue,
      messages: params.input.messages,
      ...(params.input.modelOverride ? { modelOverride: params.input.modelOverride } : {}),
      raw: {
        ...(params.input.raw && typeof params.input.raw === "object"
          ? (params.input.raw as Record<string, unknown>)
          : {}),
        sessionMode: params.input.sessionMode,
        sessionConfigId: params.input.sessionConfigId,
        ...(params.input.parentChannelId ? { parentChannelId: params.input.parentChannelId } : {}),
        ...(params.input.modelOverride ? { modelOverride: params.input.modelOverride } : {}),
      },
    },
    {
      headers: {
        request_id: params.input.requestId,
        session_id: params.input.sessionId,
        request_client: "discord",
      },
    },
  );
}

export async function publishComposedRequest(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
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
    userId: string;
    sessionMode: SessionMode;
    modelOverride?: string;
    transformTriggerUserText?: (text: string) => string;
    transformUserTextForMessageId?: string;
  };
}) {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed = await composeRequestMessages(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    transcriptStore: params.transcriptStore,
    discordUserAliasById,
    transformUserText: params.input.transformTriggerUserText,
    transformUserTextForMessageId: params.input.transformUserTextForMessageId,
    trigger: {
      type: params.input.triggerType === "mention" ? "mention" : "reply",
      msgRef: params.input.msgRef,
    },
  });

  await publishBusRequest({
    logger: params.logger,
    bus: params.bus,
    input: {
      requestId: params.input.requestId,
      sessionId: params.input.sessionId,
      sessionConfigId: params.input.sessionConfigId,
      parentChannelId: params.input.parentChannelId,
      queue: params.input.queue,
      triggerType: params.input.triggerType,
      sessionMode: params.input.sessionMode,
      modelOverride: params.input.modelOverride,
      messages: composed.messages,
      raw: {
        triggerType: params.input.triggerType,
        chainMessageIds: composed.chainMessageIds,
        mergedGroups: composed.mergedGroups,
        participantUserIds: uniqueNonEmptyStrings(
          composed.mergedGroups.map((group) => group.authorId),
          { exclude: self.userId },
        ),
      },
    },
  });
}

export async function publishActiveChannelPrompt(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  cfg: CoreConfig;
  transcriptStore?: TranscriptStore;
  logger: Logger;
  input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    triggerMsgRef: MsgRef | undefined;
    triggerType: "mention" | "reply" | undefined;
    sessionMode: SessionMode;
    modelOverride?: string;
    botMentionNames?: readonly string[];
    transformTriggerUserText?: (text: string) => string;
    transformUserTextForMessageId?: string;
  };
}) {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const composed =
    params.input.triggerMsgRef && params.input.triggerType === "reply"
      ? await composeRequestMessages(params.adapter, {
          platform: "discord",
          botUserId: self.userId,
          botName: params.cfg.surface.discord.botName,
          transcriptStore: params.transcriptStore,
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
          discordUserAliasById,
          transformUserText: params.input.transformTriggerUserText,
          transformUserTextForMessageId: params.input.transformUserTextForMessageId,
          triggerMsgRef: params.input.triggerMsgRef,
          triggerType: params.input.triggerType,
        });

  await publishBusRequest({
    logger: params.logger,
    bus: params.bus,
    input: {
      requestId: params.input.requestId,
      sessionId: params.input.sessionId,
      sessionConfigId: params.input.sessionConfigId,
      parentChannelId: params.input.parentChannelId,
      queue: "prompt",
      triggerType: params.input.triggerType ?? "active",
      sessionMode: params.input.sessionMode,
      modelOverride: params.input.modelOverride,
      messages: composed.messages,
      raw: {
        triggerType: params.input.triggerType ?? "active",
        chainMessageIds: composed.chainMessageIds,
        mergedGroups: composed.mergedGroups,
        participantUserIds: uniqueNonEmptyStrings(
          composed.mergedGroups.map((group) => group.authorId),
          { exclude: self.userId },
        ),
      },
    },
  });
}

export async function publishSingleMessageToActiveRequest(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  cfg: CoreConfig;
  logger: Logger;
  input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    queue: "followUp" | "steer" | "interrupt";
    msgRef: MsgRef;
    sessionMode: SessionMode;
    transformUserText?: (text: string) => string;
  };
}) {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const msg = await composeSingleMessage(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    msgRef: params.input.msgRef,
    discordUserAliasById,
    transformUserText: params.input.transformUserText,
  });

  if (!msg) return;

  const surfaceMessage = await params.adapter.readMsg(params.input.msgRef);

  await publishBusRequest({
    logger: params.logger,
    bus: params.bus,
    input: {
      requestId: params.input.requestId,
      sessionId: params.input.sessionId,
      sessionConfigId: params.input.sessionConfigId,
      parentChannelId: params.input.parentChannelId,
      queue: params.input.queue,
      triggerType: "active",
      sessionMode: params.input.sessionMode,
      messages: [msg],
      raw: {
        triggerType: "active",
        participantUserIds: uniqueNonEmptyStrings([surfaceMessage?.userId], {
          exclude: self.userId,
        }),
      },
    },
  });
}

export async function publishSingleMessagePrompt(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  cfg: CoreConfig;
  logger: Logger;
  input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    msgRef: MsgRef;
    sessionMode: SessionMode;
    modelOverride?: string;
    transformUserText?: (text: string) => string;
    raw?: Record<string, unknown>;
  };
}) {
  const self = await params.adapter.getSelf();
  const discordUserAliasById = buildDiscordUserAliasById(params.cfg);

  const msg = await composeSingleMessage(params.adapter, {
    platform: "discord",
    botUserId: self.userId,
    botName: params.cfg.surface.discord.botName,
    msgRef: params.input.msgRef,
    discordUserAliasById,
    transformUserText: params.input.transformUserText,
  });

  if (!msg) return;

  const surfaceMessage = await params.adapter.readMsg(params.input.msgRef);

  await publishBusRequest({
    logger: params.logger,
    bus: params.bus,
    input: {
      requestId: params.input.requestId,
      sessionId: params.input.sessionId,
      sessionConfigId: params.input.sessionConfigId,
      parentChannelId: params.input.parentChannelId,
      queue: "prompt",
      triggerType: "active",
      sessionMode: params.input.sessionMode,
      modelOverride: params.input.modelOverride,
      messages: [msg],
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
}

export async function publishSurfaceOutputReanchor(input: {
  bus: LilacBus;
  requestId: string;
  sessionId: string;
  inheritReplyTo: boolean;
  replyTo?: MsgRef;
  mode?: "steer" | "interrupt";
}) {
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
  );
}
