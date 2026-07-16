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
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import type { DurableWorkflowStore } from "../workflow/durable-workflow-store";
import type { WorkflowProgressCardService } from "../workflow/workflow-progress-projector";

export type CoreToolPluginRuntime = {
  dataDir?: string;
  bus?: LilacBus;
  adapter?: SurfaceAdapter;
  config?: CoreConfig;
  getConfig?: () => Promise<CoreConfig>;
  discovery?: DiscoveryService;
  conversationThreads?: ConversationThreadToolService;
  discordSearch?: DiscordSearchService;
  transcriptStore?: TranscriptStore;
  toolResultArtifacts?: ToolResultArtifactStore;
  durableWorkflowStore?: DurableWorkflowStore;
  workflowProgressCards?: WorkflowProgressCardService;
};

const BOUNDED_BUILTIN_OUTPUT = Symbol("bounded-builtin-output");

export type CoreLevel1ToolSpec = Level1ToolSpec<CoreToolPluginRuntime> & {
  [BOUNDED_BUILTIN_OUTPUT]?: true;
};

export function markBoundedBuiltinOutput(spec: CoreLevel1ToolSpec): CoreLevel1ToolSpec {
  return { ...spec, [BOUNDED_BUILTIN_OUTPUT]: true };
}

export function hasBoundedBuiltinOutput(spec: CoreLevel1ToolSpec): boolean {
  return spec[BOUNDED_BUILTIN_OUTPUT] === true;
}

export type CoreToolPlugin = LilacToolPlugin<CoreToolPluginRuntime, CoreLevel1ToolSpec, ServerTool>;
