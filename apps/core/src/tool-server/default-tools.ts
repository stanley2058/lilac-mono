import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../surface/adapter";
import type { DiscordSearchService } from "../surface/store/discord-search-store";
import type { WorkflowStore } from "../workflow/workflow-store";
import type { ServerTool } from "./types";
import type { WebSearchProvider } from "./tools";
import {
  Attachment,
  Codex,
  ImageGeneration,
  Onboarding,
  SSH,
  Skills,
  Summarize,
  Surface,
  Web,
  Workflow,
} from "./tools";

export function createDefaultToolServerTools(params?: {
  bus?: LilacBus;
  adapter?: SurfaceAdapter;
  config?: CoreConfig;
  getConfig?: () => Promise<CoreConfig>;
  workflowStore?: WorkflowStore;
  discordSearch?: DiscordSearchService;
  webSearchProviders?: readonly WebSearchProvider[];
}): ServerTool[] {
  const tools: ServerTool[] = [
    new Onboarding(),
    new SSH(),
    new Web({ searchProviders: params?.webSearchProviders, getConfig: params?.getConfig }),
    new Summarize(),
    new Skills(),
    new Codex(),
    new ImageGeneration(),
  ];

  if (params?.bus) {
    tools.push(
      new Workflow({
        bus: params.bus,
        adapter: params.adapter,
        config: params.config,
        getConfig: params.getConfig,
        workflowStore: params.workflowStore,
      }),
    );
    tools.push(new Attachment({ bus: params.bus }));
  }

  if (params?.adapter && (params?.config || params?.getConfig)) {
    tools.push(
      new Surface({
        adapter: params.adapter,
        config: params.config,
        getConfig: params.getConfig,
        discordSearch: params.discordSearch,
      }),
    );
  }

  return tools;
}
