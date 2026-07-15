import { createLogger, type CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../adapter";
import type { AdapterEvent } from "../events";
import type { DiscordSearchService } from "../store/discord-search-store";

type DiscordSearchIndexerService = Pick<
  DiscordSearchService,
  "onMessageCreated" | "onMessageUpdated" | "onMessageDeleted"
>;

export async function startDiscordSearchIndexer(params: {
  adapter: SurfaceAdapter;
  search: DiscordSearchIndexerService;
  getConfig: () => Promise<CoreConfig>;
  conversationThreads?: {
    refreshThreads(cfg?: CoreConfig): { channels: number; threads: number; messages: number };
  };
}) {
  const logger = createLogger({
    module: "surface:discord-search-indexer",
  });

  const handleEvent = async (evt: AdapterEvent): Promise<void> => {
    if (evt.platform !== "discord") return;

    const refreshThreads = async () => {
      if (!params.conversationThreads) return;
      try {
        params.conversationThreads.refreshThreads(await params.getConfig());
      } catch (e) {
        logger.error("conversation thread refresh after discord indexing failed", e);
      }
    };

    switch (evt.type) {
      case "adapter.message.created": {
        await params.search.onMessageCreated(evt.message);
        await refreshThreads();
        return;
      }
      case "adapter.message.updated": {
        params.search.onMessageUpdated(evt.message);
        await refreshThreads();
        return;
      }
      case "adapter.message.deleted": {
        params.search.onMessageDeleted({
          platform: evt.platform,
          channelId: evt.session.channelId,
          messageId: evt.messageRef.messageId,
        });
        await refreshThreads();
        return;
      }
      case "adapter.reaction.added":
      case "adapter.reaction.removed": {
        return;
      }
      case "adapter.request.cancel": {
        return;
      }
      case "adapter.command.invoked": {
        return;
      }
      case "adapter.action.invoked": {
        return;
      }
      default: {
        const _exhaustive: never = evt;
        return _exhaustive;
      }
    }
  };

  return await params.adapter.subscribe((evt) => {
    return handleEvent(evt).catch((e) => {
      logger.error("discord search indexer handler failed", e);
    });
  });
}
