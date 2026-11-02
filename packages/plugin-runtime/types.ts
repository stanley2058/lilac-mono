import type { ToolSet } from "ai";
import type { Result } from "better-result";

export type PluginSource = "builtin" | "external";

export type RequestContext<P extends string = string> = {
  requestId?: string;
  requestDeliveryId?: string;
  sessionId?: string;
  requestClient?: string;
  cwd?: string;
  safetyMode?: "trusted" | "restricted";
  /** Set only after matching request headers to a server-owned authenticated surface origin. */
  serverOwnedRequest?: boolean;
  /** Set only after authenticating the root-only container operator token. */
  operator?: boolean;
  requestInitiator?: { platform: P; userId: string };
  requestInitiatorSessionId?: string;
  currentTurnUserId?: string;
  toolCallId?: string;
  controlCapability?: string;
  controlPolicy?: {
    kind: "primary" | "heartbeat";
    allowedCallables: readonly string[] | null;
  };
  /** Name of the subagent run's configured permission profile. */
  subagentProfile?: string;
};

export type ServerToolPrimaryPositional = {
  field: string;
  variadic?: boolean;
};

export type ServerToolHelpEntry = {
  callableId: string;
  name: string;
  description: string;
  shortInput: string[];
  input?: string[];
  primaryPositional?: ServerToolPrimaryPositional;
  hidden?: boolean;
};

export type ServerToolListResult = ServerToolHelpEntry[];

export type ServerToolFailureKind =
  | "usage"
  | "denied"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "internal";

export type ServerToolJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly ServerToolJsonValue[]
  | { readonly [key: string]: ServerToolJsonValue };

export type ServerToolFailure = {
  readonly kind: ServerToolFailureKind;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: ServerToolJsonValue;
};

export type ServerToolResult<T = unknown> = Result<T, ServerToolFailure>;

export function serverToolFailure(failure: ServerToolFailure): ServerToolFailure {
  return failure;
}

export const serverToolExitCode = {
  internal: 1,
  usage: 2,
  denied: 3,
  not_found: 4,
  conflict: 5,
  unavailable: 6,
  timeout: 7,
  cancelled: 8,
} as const satisfies Readonly<Record<ServerToolFailureKind, number>>;

export type ServerToolCallOptions<P extends string = string> = {
  signal?: AbortSignal;
  context?: RequestContext<P>;
  messages?: readonly unknown[];
};

export interface ServerTool<P extends string = string> {
  id: string;

  init(): Promise<void>;
  destroy(): Promise<void>;
  list(): Promise<ServerToolListResult>;
  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions<P>,
  ): Promise<ServerToolResult>;
}

/** "primary" or the name of a configured subagent permission profile. */
export type Level1RunProfile = "primary" | (string & {});

export type Level1ToolFailureKind = "hard" | "soft";

export type Level1ToolFailureClass =
  | "input"
  | "policy"
  | "environment"
  | "timeout"
  | "cancelled"
  | "tool"
  | "unknown";

export type Level1ToolFailureSummary = {
  ok: boolean;
  failureKind?: Level1ToolFailureKind;
  failureClass?: Level1ToolFailureClass;
  failureCode?: string;
  retryable?: boolean;
  exitCode?: number;
  error?: string;
};

export type Level1SubagentConfig = {
  enabled: boolean;
  idleTimeoutMs: number;
  maxDepth: number;
};

export type Level1ExecutionRequestContext<P extends string = string> = {
  serverOwnedRequest?: boolean;
  requestId: string;
  requestDeliveryId?: string;
  sessionId: string;
  requestClient: string;
  subagentDepth: number;
  subagentProfile: Level1RunProfile;
  safetyMode?: "trusted" | "restricted";
  requestInitiator?: { platform: P; userId: string };
  requestInitiatorSessionId?: string;
  currentTurnUserId?: string;
  currentTurnMessageRef?: {
    platform: P;
    channelId: string;
    messageId: string;
  };
  metadata?: Readonly<Record<string, unknown>>;
};

export type Level1ToolRunContext<TRuntimeContext, P extends string = string> = {
  runtime: TRuntimeContext;
  cwd: string;
  runProfile: Level1RunProfile;
  editingToolMode: "apply_patch" | "edit_file" | "none";
  subagentDepth: number;
  subagentConfig: Level1SubagentConfig;
  requestContext?: Level1ExecutionRequestContext<P>;
};

export type Level1ToolBuildContext<
  TRuntimeContext,
  P extends string = string,
> = Level1ToolRunContext<TRuntimeContext, P> & {
  getTools(): ToolSet;
  getLevel1ToolSpecs(): ReadonlyMap<string, Level1ToolSpec<TRuntimeContext, P>>;
  resolveEditTargets(
    spec: Level1ToolSpec<TRuntimeContext, P>,
    args: unknown,
    context: { cwd: string },
  ): Promise<readonly string[]>;
  reportToolStatus?: (update: {
    toolCallId: string;
    status: "start" | "update" | "end";
    display: string;
    ok?: boolean;
    error?: string;
  }) => void | Promise<void>;
};

export interface Level1ToolSpec<TRuntimeContext, P extends string = string> {
  name: string;
  /** Enabled tools are batch-callable by default. Set false to opt out. */
  supportsBatch?: boolean;
  createTool(buildContext: Level1ToolBuildContext<TRuntimeContext, P>): unknown;
  isEnabled(runContext: Level1ToolRunContext<TRuntimeContext, P>): boolean;
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

export type Level1ContributionInfo = {
  pluginId: string;
  source: PluginSource;
};

export type Level1RegistrationContext = Level1ContributionInfo;

export type Level2ContributionInfo = Level1ContributionInfo;

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
