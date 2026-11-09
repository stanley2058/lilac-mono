import type { NativeAttachmentOutput } from "../tool-server/tools/attachment";
import type { SurfaceAdapter, SurfaceOperationResult } from "../surface/adapter";
import type { RequestContext } from "../tool-server/types";
import type { LilacBus } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import type {
  Level1ToolSpec,
  LilacToolPlugin,
  ServerTool,
} from "@stanley2058/lilac-plugin-runtime";

import type { SurfaceAdapterResolver } from "../surface/runtime-descriptor";
import type { NativeSearchService } from "../surface/native/search";
import type { DiscoveryService } from "../discovery/discovery-service";
import type { ConversationThreadToolService } from "../conversation/thread-service";
import type { TranscriptStore } from "../transcript/transcript-store";
import type { ToolResultArtifactStore } from "../artifacts/tool-result-artifact-store";
import type { DurableWorkflowStore } from "../workflow/durable-workflow-store";
import type { WorkflowProgressCardService } from "../workflow/workflow-progress-projector";
import type { McpRegistryApi } from "../mcp/registry-types";
import type { McpOAuthProviderService } from "../mcp/oauth-provider";
import type { McpOAuthCallbackControl } from "../mcp/oauth-callback";
import type { RegisteredSurfacePlatform } from "../surface/types";
import type { AttachmentOutputLifecycle } from "../tools/attachment-output-lifecycle";
import type { ResourceAccess } from "../resource";
import type { JobService } from "../jobs/job-service";
import type { QuestionService } from "../question/question-service";

export type CoreToolPluginRuntime = {
  dataDir?: string;
  bus?: LilacBus;
  blobStore?: BlobStore;
  attachmentOutputLifecycle?: AttachmentOutputLifecycle;
  nativeAttachmentOutput?: NativeAttachmentOutput;
  resourceAccess?: ResourceAccess;
  resourceAccessForContext?: (context: RequestContext | undefined) => ResourceAccess | undefined;
  surfaceAdapterResolver?: SurfaceAdapterResolver;
  nativeAdapterForContext?: (context: RequestContext) => SurfaceOperationResult<SurfaceAdapter>;
  config?: CoreConfig;
  getConfig?: () => Promise<CoreConfig>;
  discovery?: DiscoveryService;
  nativeSearch?: NativeSearchService;
  conversationThreads?: ConversationThreadToolService;
  transcriptStore?: TranscriptStore;
  mcpRegistry?: McpRegistryApi;
  mcpOAuthProviders?: McpOAuthProviderService;
  mcpOAuthCallback?: McpOAuthCallbackControl;
  mcpConfigPath?: string;
  toolResultArtifacts?: ToolResultArtifactStore;
  durableWorkflowStore?: DurableWorkflowStore;
  workflowProgressCards?: WorkflowProgressCardService;
  questions?: QuestionService;
  jobs?: JobService;
};

const BOUNDED_BUILTIN_OUTPUT = Symbol("bounded-builtin-output");
const AGGREGATE_OUTPUT_BUDGET_EXEMPT = Symbol("aggregate-output-budget-exempt");

export type CoreLevel1ToolSpec = Level1ToolSpec<
  CoreToolPluginRuntime,
  RegisteredSurfacePlatform
> & {
  [BOUNDED_BUILTIN_OUTPUT]?: true;
  [AGGREGATE_OUTPUT_BUDGET_EXEMPT]?: true;
};

export function markBoundedBuiltinOutput<Spec extends CoreLevel1ToolSpec>(spec: Spec): Spec {
  return { ...spec, [BOUNDED_BUILTIN_OUTPUT]: true };
}

export function hasBoundedBuiltinOutput(spec: CoreLevel1ToolSpec): boolean {
  return spec[BOUNDED_BUILTIN_OUTPUT] === true;
}

export function markAggregateOutputBudgetExempt<Spec extends CoreLevel1ToolSpec>(spec: Spec): Spec {
  return { ...spec, [AGGREGATE_OUTPUT_BUDGET_EXEMPT]: true };
}

export function isAggregateOutputBudgetExempt(spec: CoreLevel1ToolSpec): boolean {
  return spec[AGGREGATE_OUTPUT_BUDGET_EXEMPT] === true;
}

export type CoreToolPlugin = LilacToolPlugin<
  CoreToolPluginRuntime,
  CoreLevel1ToolSpec,
  ServerTool<RegisteredSurfacePlatform>
>;
