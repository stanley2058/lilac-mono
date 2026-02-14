import type { LilacBus } from "@stanley2058/lilac-event-bus";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";

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

  return await adapter.subscribe(async (evt: AdapterEvent) => {
    switch (evt.type) {
      case "adapter.message.created": {
        await bus.publish(
          lilacEventTypes.EvtAdapterMessageCreated,
          toBusEvtAdapterMessageCreated({
            message: evt.message,
            channelName: evt.channelName,
          }),
        );
        break;
      }

      case "adapter.message.updated": {
        await bus.publish(
          lilacEventTypes.EvtAdapterMessageUpdated,
          toBusEvtAdapterMessageUpdated({
            message: evt.message,
            channelName: evt.channelName,
          }),
        );
        break;
      }

      case "adapter.message.deleted": {
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
        break;
      }

      case "adapter.reaction.added": {
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
        break;
      }

      case "adapter.reaction.removed": {
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
        break;
      }

      case "adapter.request.cancel": {
        const cancelScope = evt.cancelScope ?? "active_only";
        const cancelQueued = cancelScope === "active_or_queued";

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
        break;
      }

      default: {
        const _exhaustive: never = evt;
        return _exhaustive;
      }
    }
  });
}
