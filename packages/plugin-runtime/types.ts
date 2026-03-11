import type { ToolSet } from "ai";

export type PluginSource = "builtin" | "external";

export type RequestContext = {
  requestId?: string;
  sessionId?: string;
  requestClient?: string;
  cwd?: string;
};

export type ServerToolHelpEntry = {
  callableId: string;
  name: string;
  description: string;
  shortInput: string[];
  input?: string[];
  hidden?: boolean;
};

export type ServerToolListResult = ServerToolHelpEntry[];

export interface ServerTool {
  id: string;

  init(): Promise<void>;
  destroy(): Promise<void>;
  list(): Promise<ServerToolListResult>;
  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
      messages?: readonly unknown[];
    },
  ): Promise<unknown>;
}

export type Level1RunProfile = "primary" | "explore" | "general" | "self";

export type Level1ToolFailureKind = "hard" | "soft";

export type Level1ToolFailureSummary = {
  ok: boolean;
  failureKind?: Level1ToolFailureKind;
  error?: string;
};

export type Level1SubagentConfig = {
  enabled: boolean;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxDepth: number;
};

export type Level1ExecutionRequestContext = {
  requestId: string;
  sessionId: string;
  requestClient: string;
  subagentDepth: number;
  subagentProfile: Level1RunProfile;
};

export type Level1ToolRunContext<TRuntimeContext> = {
  runtime: TRuntimeContext;
  cwd: string;
  runProfile: Level1RunProfile;
  editingToolMode: "apply_patch" | "edit_file" | "none";
  subagentDepth: number;
  subagentConfig: Level1SubagentConfig;
  requestContext?: Level1ExecutionRequestContext;
};

export type Level1ToolBuildContext<TRuntimeContext> = Level1ToolRunContext<TRuntimeContext> & {
  getTools(): ToolSet;
  getLevel1ToolSpecs(): ReadonlyMap<string, Level1ToolSpec<TRuntimeContext>>;
  reportToolStatus?: (update: {
    toolCallId: string;
    status: "start" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => void | Promise<void>;
};

export interface Level1ToolSpec<TRuntimeContext> {
  name: string;
  supportsBatch?: boolean;
  createTool(buildContext: Level1ToolBuildContext<TRuntimeContext>): unknown;
  isEnabled(runContext: Level1ToolRunContext<TRuntimeContext>): boolean;
  editTargets?(
    args: unknown,
    context: { cwd: string },
  ): Iterable<string> | Promise<Iterable<string>>;
  formatArgs?(args: unknown): string;
  summarizeFailure?(params: { isError: boolean; result: unknown }): Level1ToolFailureSummary;
}

export type ToolPluginMeta = {
  id: string;
  name?: string;
  version?: string;
};

export type ToolPluginCreateContext<TRuntimeContext> = {
  runtime: TRuntimeContext;
  dataDir: string;
  pluginConfig: unknown;
  source: PluginSource;
  pluginDir?: string;
  entrypointPath?: string;
  logger?: PluginLogger;
};

export type ToolPluginInstance<TLevel1, TLevel2> = {
  level1?: readonly TLevel1[];
  level2?: readonly TLevel2[];
  init?(): Promise<void>;
  destroy?(): Promise<void>;
};

export interface LilacToolPlugin<TRuntimeContext, TLevel1, TLevel2> {
  meta: ToolPluginMeta;
  create(
    context: ToolPluginCreateContext<TRuntimeContext>,
  ): Promise<ToolPluginInstance<TLevel1, TLevel2>> | ToolPluginInstance<TLevel1, TLevel2>;
}

export type PluginLogger = {
  debug?(message: string, ...args: readonly unknown[]): void;
  info?(message: string, ...args: readonly unknown[]): void;
  warn?(message: string, ...args: readonly unknown[]): void;
  error?(message: string, ...args: readonly unknown[]): void;
};

export type ToolPluginState = "loaded" | "disabled" | "skipped" | "failed";

export type ToolPluginStatus = {
  pluginId: string;
  source: PluginSource;
  state: ToolPluginState;
  reason?: string;
  pluginDir?: string;
  entrypointPath?: string;
  level1Names: string[];
  level2Ids: string[];
};

export type LoadedToolPlugin<TLevel1, TLevel2> = {
  plugin: LilacToolPlugin<unknown, TLevel1, TLevel2>;
  instance: ToolPluginInstance<TLevel1, TLevel2>;
  meta: ToolPluginMeta;
  source: PluginSource;
  pluginDir?: string;
  entrypointPath?: string;
  level1: readonly TLevel1[];
  level2: readonly TLevel2[];
};
