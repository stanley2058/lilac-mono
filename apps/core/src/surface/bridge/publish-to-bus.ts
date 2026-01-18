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

      case "adapter.request": {
        await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            messages: evt.messages,
            raw: evt.raw,
          },
          {
            headers: {
              request_id: evt.requestId,
              session_id: evt.channelId,
              request_client: "discord",
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
