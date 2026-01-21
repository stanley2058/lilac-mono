import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../surface/adapter";
import type { ServerTool } from "./types";
import {
  Attachment,
  Codex,
  ImageGeneration,
  Onboarding,
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
}): ServerTool[] {
  const tools: ServerTool[] = [
    new Onboarding(),
    new Web(),
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
      }),
    );
  }

  return tools;
}
