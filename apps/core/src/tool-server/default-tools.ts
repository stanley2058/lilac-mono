import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../surface/adapter";
import type { ServerTool } from "./types";
import { Attachment, Summarize, Surface, Web, Workflow } from "./tools";

export function createDefaultToolServerTools(params?: {
  bus?: LilacBus;
  adapter?: SurfaceAdapter;
  config?: CoreConfig;
}): ServerTool[] {
  const tools: ServerTool[] = [new Web(), new Summarize()];

  if (params?.bus) {
    tools.push(new Workflow({ bus: params.bus, config: params.config }));
    tools.push(new Attachment({ bus: params.bus }));
  }

  if (params?.adapter && params?.config) {
    tools.push(new Surface({ adapter: params.adapter, config: params.config }));
  }

  return tools;
}
