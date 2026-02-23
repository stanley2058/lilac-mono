import type { LilacBus } from "@stanley2058/lilac-event-bus";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";

import type { SurfaceAdapter } from "../adapter";
import type { AdapterEvent } from "../events";
import {
  toBusEvtAdapterMessageCreated,
  toBusEvtAdapterMessageDeleted,
  toBusEvtAdapterMessageUpdated,
  toBusEvtAdapterReactionAdded,
  toBusEvtAdapterReactionRemoved,
} from "../discord/discord-adapter";

export async function bridgeAdapterToBus(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  subscriptionId: string;
}) {
  const { adapter, bus } = params;
  const logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "bridge:adapter-to-bus",
  });

  const logPublish = (input: {
    adapterEventType: AdapterEvent["type"];
    busType: string;
    platform: string;
    channelId?: string;
    messageId?: string;
    userId?: string;
    requestId?: string;
    sessionId?: string;
    startedAt: number;
    ok: boolean;
    errorClass?: string;
  }) => {
    logger.debug("adapter.event.publish", {
      adapterEventType: input.adapterEventType,
      busType: input.busType,
      platform: input.platform,
      channelId: input.channelId,
      messageId: input.messageId,
      userId: input.userId,
      requestId: input.requestId,
      sessionId: input.sessionId,
      durationMs: Date.now() - input.startedAt,
      ok: input.ok,
      errorClass: input.errorClass,
    });
  };

  return await adapter.subscribe(async (evt: AdapterEvent) => {
    const startedAt = Date.now();

    switch (evt.type) {
      case "adapter.message.created": {
        try {
          await bus.publish(
            lilacEventTypes.EvtAdapterMessageCreated,
            toBusEvtAdapterMessageCreated({
              message: evt.message,
              channelName: evt.channelName,
            }),
          );
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterMessageCreated,
            platform: evt.message.ref.platform,
            channelId: evt.message.ref.channelId,
            messageId: evt.message.ref.messageId,
            userId: evt.message.userId,
            startedAt,
            ok: true,
          });
        } catch (e) {
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterMessageCreated,
            platform: evt.message.ref.platform,
            channelId: evt.message.ref.channelId,
            messageId: evt.message.ref.messageId,
            userId: evt.message.userId,
            startedAt,
            ok: false,
            errorClass: e instanceof Error ? e.name : "unknown",
          });
          throw e;
        }
        break;
      }

      case "adapter.message.updated": {
        try {
          await bus.publish(
            lilacEventTypes.EvtAdapterMessageUpdated,
            toBusEvtAdapterMessageUpdated({
              message: evt.message,
              channelName: evt.channelName,
            }),
          );
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterMessageUpdated,
            platform: evt.message.ref.platform,
            channelId: evt.message.ref.channelId,
            messageId: evt.message.ref.messageId,
            userId: evt.message.userId,
            startedAt,
            ok: true,
          });
        } catch (e) {
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterMessageUpdated,
            platform: evt.message.ref.platform,
            channelId: evt.message.ref.channelId,
            messageId: evt.message.ref.messageId,
            userId: evt.message.userId,
            startedAt,
            ok: false,
            errorClass: e instanceof Error ? e.name : "unknown",
          });
          throw e;
        }
        break;
      }

      case "adapter.message.deleted": {
        try {
          await bus.publish(
            lilacEventTypes.EvtAdapterMessageDeleted,
            toBusEvtAdapterMessageDeleted({
              messageRef: evt.messageRef,
              session: evt.session,
              channelName: evt.channelName,
              ts: evt.ts,
              raw: evt.raw,
            }),
          );
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterMessageDeleted,
            platform: evt.messageRef.platform,
            channelId: evt.messageRef.channelId,
            messageId: evt.messageRef.messageId,
            startedAt,
            ok: true,
          });
        } catch (e) {
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterMessageDeleted,
            platform: evt.messageRef.platform,
            channelId: evt.messageRef.channelId,
            messageId: evt.messageRef.messageId,
            startedAt,
            ok: false,
            errorClass: e instanceof Error ? e.name : "unknown",
          });
          throw e;
        }
        break;
      }

      case "adapter.reaction.added": {
        try {
          await bus.publish(
            lilacEventTypes.EvtAdapterReactionAdded,
            toBusEvtAdapterReactionAdded({
              messageRef: evt.messageRef,
              session: evt.session,
              channelName: evt.channelName,
              reaction: evt.reaction,
              userId: evt.userId,
              userName: evt.userName,
              ts: evt.ts,
              raw: evt.raw,
            }),
          );
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterReactionAdded,
            platform: evt.messageRef.platform,
            channelId: evt.messageRef.channelId,
            messageId: evt.messageRef.messageId,
            userId: evt.userId,
            startedAt,
            ok: true,
          });
        } catch (e) {
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterReactionAdded,
            platform: evt.messageRef.platform,
            channelId: evt.messageRef.channelId,
            messageId: evt.messageRef.messageId,
            userId: evt.userId,
            startedAt,
            ok: false,
            errorClass: e instanceof Error ? e.name : "unknown",
          });
          throw e;
        }
        break;
      }

      case "adapter.reaction.removed": {
        try {
          await bus.publish(
            lilacEventTypes.EvtAdapterReactionRemoved,
            toBusEvtAdapterReactionRemoved({
              messageRef: evt.messageRef,
              session: evt.session,
              channelName: evt.channelName,
              reaction: evt.reaction,
              userId: evt.userId,
              userName: evt.userName,
              ts: evt.ts,
              raw: evt.raw,
            }),
          );
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterReactionRemoved,
            platform: evt.messageRef.platform,
            channelId: evt.messageRef.channelId,
            messageId: evt.messageRef.messageId,
            userId: evt.userId,
            startedAt,
            ok: true,
          });
        } catch (e) {
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.EvtAdapterReactionRemoved,
            platform: evt.messageRef.platform,
            channelId: evt.messageRef.channelId,
            messageId: evt.messageRef.messageId,
            userId: evt.userId,
            startedAt,
            ok: false,
            errorClass: e instanceof Error ? e.name : "unknown",
          });
          throw e;
        }
        break;
      }

      case "adapter.request.cancel": {
        const cancelScope = evt.cancelScope ?? "active_only";
        const cancelQueued = cancelScope === "active_or_queued";

        try {
          await bus.publish(
            lilacEventTypes.CmdRequestMessage,
            {
              queue: "interrupt",
              messages: [],
              raw: {
                cancel: true,
                cancelQueued,
                requiresActive: !cancelQueued,
                source:
                  evt.source ??
                  (cancelQueued ? "discord_cancel_context_menu" : "discord_cancel_button"),
                ...(evt.userId ? { userId: evt.userId } : {}),
                ...(evt.messageId ? { messageId: evt.messageId } : {}),
              },
            },
            {
              headers: {
                request_id: evt.requestId,
                session_id: evt.sessionId,
                request_client: evt.platform,
              },
            },
          );
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.CmdRequestMessage,
            platform: evt.platform,
            messageId: evt.messageId,
            userId: evt.userId,
            requestId: evt.requestId,
            sessionId: evt.sessionId,
            startedAt,
            ok: true,
          });
        } catch (e) {
          logPublish({
            adapterEventType: evt.type,
            busType: lilacEventTypes.CmdRequestMessage,
            platform: evt.platform,
            messageId: evt.messageId,
            userId: evt.userId,
            requestId: evt.requestId,
            sessionId: evt.sessionId,
            startedAt,
            ok: false,
            errorClass: e instanceof Error ? e.name : "unknown",
          });
          throw e;
        }
        break;
      }

      default: {
        const _exhaustive: never = evt;
        return _exhaustive;
      }
    }
  });
}
