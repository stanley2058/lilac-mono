import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type {
  Level1ToolSpec,
  LilacToolPlugin,
  ServerTool,
} from "@stanley2058/lilac-plugin-runtime";

import type { SurfaceAdapter } from "../surface/adapter";
import type { DiscoveryService } from "../discovery/discovery-service";
import type { ConversationThreadToolService } from "../conversation/thread-service";
import type { DiscordSearchService } from "../surface/store/discord-search-store";
import type { TranscriptStore } from "../transcript/transcript-store";
import type { WorkflowStore } from "../workflow/workflow-store";

export type CoreToolPluginRuntime = {
  bus?: LilacBus;
  adapter?: SurfaceAdapter;
  config?: CoreConfig;
  getConfig?: () => Promise<CoreConfig>;
  workflowStore?: WorkflowStore;
  discovery?: DiscoveryService;
  conversationThreads?: ConversationThreadToolService;
  discordSearch?: DiscordSearchService;
  transcriptStore?: TranscriptStore;
};

export type CoreLevel1ToolSpec = Level1ToolSpec<CoreToolPluginRuntime>;

export type CoreToolPlugin = LilacToolPlugin<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>;
