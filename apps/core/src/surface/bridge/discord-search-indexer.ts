import { createLogger } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../adapter";
import type { AdapterEvent } from "../events";
import { DiscordSearchService } from "../store/discord-search-store";

export async function startDiscordSearchIndexer(params: {
  adapter: SurfaceAdapter;
  search: DiscordSearchService;
}) {
  const logger = createLogger({
    module: "surface:discord-search-indexer",
  });

  const handleEvent = async (evt: AdapterEvent): Promise<void> => {
    if (evt.platform !== "discord") return;

    switch (evt.type) {
      case "adapter.message.created": {
        await params.search.onMessageCreated(evt.message);
        return;
      }
      case "adapter.message.updated": {
        params.search.onMessageUpdated(evt.message);
        return;
      }
      case "adapter.message.deleted": {
        params.search.onMessageDeleted({
          platform: evt.platform,
          channelId: evt.session.channelId,
          messageId: evt.messageRef.messageId,
        });
        return;
      }
      case "adapter.reaction.added":
      case "adapter.reaction.removed": {
        return;
      }
      case "adapter.request.cancel": {
        return;
      }
      default: {
        const _exhaustive: never = evt;
        return _exhaustive;
      }
    }
  };

  return await params.adapter.subscribe((evt) => {
    void handleEvent(evt).catch((e) => {
      logger.error("discord search indexer handler failed", e);
    });
  });
}
