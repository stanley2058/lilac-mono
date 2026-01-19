import type { LilacBus } from "@stanley2058/lilac-event-bus";

import type { ServerTool } from "./types";
import { Attachment, Summarize, Web, Workflow } from "./tools";

export function createDefaultToolServerTools(params?: {
  bus?: LilacBus;
}): ServerTool[] {
  const tools: ServerTool[] = [new Web(), new Summarize()];

  if (params?.bus) {
    tools.push(new Workflow({ bus: params.bus }));
    tools.push(new Attachment({ bus: params.bus }));
  }

  return tools;
}
