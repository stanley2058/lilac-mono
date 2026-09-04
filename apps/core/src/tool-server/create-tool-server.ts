import { captureError } from "../shared/error-capture";
import Elysia, { NotFoundError } from "elysia";
import {
  createLogger,
  formatTaggedErrorForLog,
  getBuildInfo,
  isPanic,
  isRecord,
  isNativeSubagentProfile,
  type CoreConfig,
  type NativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import {
  invokeLevel2Call,
  invokeLevel2Destroy,
  invokeLevel2Init,
  invokeLevel2List,
  isPluginPanic,
  opaquePluginExceptionMessage,
  safePluginExceptionCause,
  serverToolFailure,
  type Level2ContributionInfo,
  type ServerToolCapabilitySnapshot,
  type ServerToolFailure,
  type ServerToolListResult,
  type ServerToolResult,
  type ToolPluginCleanupError,
  type ToolPluginManagerError,
  type ToolPluginStatus,
} from "@stanley2058/lilac-plugin-runtime";
import type { Logger } from "@stanley2058/simple-module-logger";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { isLevel2ContributionAllowedForNativeProfile } from "../plugins/profile-authority";

import {
  BridgeFnRequest,
  BridgeFnResponse,
  BridgeListResponse,
  BridgeVersionResponse,
} from "./schema";
import {
  createToolServerHealthState,
  type ToolServerActiveLevel1Work,
  type ToolServerHealthCheck,
  type ToolServerHealthConfig,
  type ToolServerHealthProviderResult,
  type ToolServerHealthSnapshot,
  type ToolServerLagIncident,
} from "./health-state";
import type { RequestContext, ServerTool } from "./types";
import { bindRequestInvocationCwd } from "./request-invocation-cwd";
import type { AuthenticatedSurfaceOrigin, SurfacePrincipal } from "../surface/types";
import { resolveAuthenticatedRequestSafetyMode } from "../surface/builtin-surface-protocols";
import { resolveSessionSafetyMode } from "../surface/session-policy";
import type { AuthenticatedRequestOrigin } from "./request-message-cache";

type ToolPluginManagerLike = {
  init(): Promise<Result<void, ToolPluginManagerError>>;
  destroy(): Promise<Result<void, ToolPluginCleanupError>>;
  reload(): Promise<Result<void, ToolPluginManagerError>>;
  getLevel2Tools(): readonly ServerTool[];
  getLevel2ContributionInfo?(): ReadonlyMap<ServerTool, Level2ContributionInfo>;
  getLevel2Capabilities?(): ReadonlyMap<ServerTool, ServerToolCapabilitySnapshot>;
  getStatuses?(): readonly ToolPluginStatus[];
};

type ToolCallTimeoutOptions = {
  defaultTimeoutMs?: number;
  perToolMs?: Record<string, number>;
};

type ToolJsonValue = string | number | boolean | null | ToolJsonValue[] | ToolJsonObject;
type ToolJsonObject = { readonly [key: string]: ToolJsonValue };
type FatalToolCallDefect = Panic | Error;
type ToolServerCleanupFailure = {
  readonly label: string;
  readonly cause: Error;
};

function removeOwnedUnixSocket(socketPath: string): ResultType<void, Error> {
  if (!existsSync(socketPath)) return Result.ok(undefined);
  const statResult = Result.try({
    try: () => lstatSync(socketPath),
    catch: captureError,
  }).mapError((error) => error.cause);
  return statResult.andThen((stat) => {
    if (!stat.isSocket()) {
      return Result.err(new Error(`Refusing to remove non-socket tool server path: ${socketPath}`));
    }
    const effectiveUid = process.geteuid?.();
    if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
      return Result.err(
        new Error(`Refusing to remove tool server socket owned by another user: ${socketPath}`),
      );
    }
    return Result.try({
      try: () => unlinkSync(socketPath),
      catch: captureError,
    }).mapError((error) => error.cause);
  });
}

type ToolRequestHeaders = {
  readonly operatorToken?: string;
  readonly requestId?: string;
  readonly requestDeliveryId?: string;
  readonly sessionId?: string;
  readonly requestClient?: string;
  readonly cwd?: string;
  readonly toolCallId?: string;
  readonly controlCapability?: string;
  readonly subagentProfile?: string;
  readonly safetyMode?: string;
  readonly currentTurnUserId?: string;
};

type AuthenticatedToolRequest = {
  readonly context: RequestContext;
  readonly messages: readonly unknown[] | undefined;
};

const toolJsonValueSchema: z.ZodType<ToolJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(toolJsonValueSchema),
    z.record(z.string(), toolJsonValueSchema),
  ]),
);
const toolPayloadSchema: z.ZodType<ToolJsonObject> = z.record(z.string(), toolJsonValueSchema);
const toolRequestHeadersSchema = z.object({
  "x-lilac-operator-token": z.string().optional(),
  "x-lilac-request-id": z.string().optional(),
  "x-lilac-request-delivery-id": z.string().optional(),
  "x-lilac-session-id": z.string().optional(),
  "x-lilac-request-client": z.string().optional(),
  "x-lilac-cwd": z.string().optional(),
  "x-lilac-tool-call-id": z.string().optional(),
  "x-lilac-control-capability": z.string().optional(),
  "x-lilac-subagent-profile": z.string().optional(),
  "x-lilac-safety-mode": z.string().optional(),
  "x-lilac-current-turn-user-id": z.string().optional(),
});

const SENSITIVE_PREVIEW_KEYS = new Set([
  "authorization",
  "Authorization",
  "apiKey",
  "apikey",
  "token",
  "access",
  "refresh",
  "idToken",
  "code",
  "pkceVerifier",
  "privateKey",
  "privateKeyPem",
  "private_key",
  "pem",
  "keyPath",
  "password",
]);

class ToolServerOptionsInvalid extends TaggedError("ToolServerOptionsInvalid")<{
  readonly message: string;
}> {}

class ToolRequestHeadersInvalid extends TaggedError("ToolRequestHeadersInvalid")<{
  readonly message: string;
}> {}

class ToolPayloadInvalid extends TaggedError("ToolPayloadInvalid")<{
  readonly message: string;
}> {}

class ToolRequestAuthenticationError extends TaggedError("ToolRequestAuthenticationError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

class ToolSafetyModeResolutionError extends TaggedError("ToolSafetyModeResolutionError")<{
  readonly source: "server-provider" | "config";
  readonly sessionId?: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

class ToolRouteNotFound extends TaggedError("ToolRouteNotFound")<{
  readonly callableId: string;
  readonly message: string;
}> {}

function projectToolPayloadForPreview(value: ToolJsonValue): ToolJsonValue {
  if (Array.isArray(value)) return value.map(projectToolPayloadForPreview);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]): [string, ToolJsonValue] => [
      key,
      SENSITIVE_PREVIEW_KEYS.has(key) ? "<redacted>" : projectToolPayloadForPreview(nested),
    ]),
  );
}

function safeJsonPreview(value: ToolJsonObject, maxChars = 2000): string {
  const raw = JSON.stringify(projectToolPayloadForPreview(value));
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}...` : raw;
}

function safeToolInputPreview(callableId: string, input: ToolJsonObject): string {
  if (callableId === "mcp.add") return "<redacted mcp.add input>";
  if (callableId.startsWith("workflow.")) return "<redacted workflow input>";
  return safeJsonPreview(input);
}

function frameworkErrorLogProjection<TError>(error: TError): Readonly<Record<string, string>> {
  {
    const attempt = Result.try({
      try: () => {
        if (TaggedError.is(error)) return formatTaggedErrorForLog(error);
        return { errorMessage: opaquePluginExceptionMessage(error) };
      },
      catch: captureError,
    });

    if (attempt.isErr()) {
      return { errorMessage: "Unknown framework error" };
    }
    return attempt.value;
  }
}

function toolServerTaggedErrorLogProjection(
  error: ToolPluginManagerError | ToolPluginCleanupError | ToolSafetyModeResolutionError,
  context: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { ...context, ...formatTaggedErrorForLog(error) };
}

function headerStr(header: string | undefined): string | undefined {
  return header && header.length > 0 ? header : undefined;
}

function decodeToolRequestHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): ResultType<ToolRequestHeaders, ToolRequestHeadersInvalid> {
  const decoded = toolRequestHeadersSchema.safeParse(headers);
  if (!decoded.success) {
    return Result.err(
      new ToolRequestHeadersInvalid({ message: "Tool request headers are invalid" }),
    );
  }
  return Result.ok({
    operatorToken: headerStr(decoded.data["x-lilac-operator-token"]),
    requestId: headerStr(decoded.data["x-lilac-request-id"]),
    requestDeliveryId: headerStr(decoded.data["x-lilac-request-delivery-id"]),
    sessionId: headerStr(decoded.data["x-lilac-session-id"]),
    requestClient: headerStr(decoded.data["x-lilac-request-client"]),
    cwd: headerStr(decoded.data["x-lilac-cwd"]),
    toolCallId: headerStr(decoded.data["x-lilac-tool-call-id"]),
    controlCapability: headerStr(decoded.data["x-lilac-control-capability"]),
    subagentProfile: headerStr(decoded.data["x-lilac-subagent-profile"]),
    safetyMode: headerStr(decoded.data["x-lilac-safety-mode"]),
    currentTurnUserId: headerStr(decoded.data["x-lilac-current-turn-user-id"]),
  });
}

function decodeToolPayload(
  input: Readonly<Record<string, unknown>>,
): ResultType<ToolJsonObject, ToolPayloadInvalid> {
  const decoded = toolPayloadSchema.safeParse(input);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(new ToolPayloadInvalid({ message: "Tool input must contain JSON values" }));
}

function parseRequestContext(headers: ToolRequestHeaders): RequestContext {
  return {
    requestId: headers.requestId,
    requestDeliveryId: headers.requestDeliveryId,
    sessionId: headers.sessionId,
    requestClient: headers.requestClient,
    cwd: headers.cwd,
    toolCallId: headers.toolCallId,
    controlCapability: headers.controlCapability,
    currentTurnUserId: headers.currentTurnUserId,
    subagentProfile: (() => {
      return isNativeSubagentProfile(headers.subagentProfile) ? headers.subagentProfile : undefined;
    })(),
    safetyMode: headers.safetyMode === "restricted" ? "restricted" : undefined,
  };
}

function authenticateRequestContext(
  context: RequestContext,
  cache: ToolServerOptions["requestMessageCache"],
): readonly unknown[] | undefined {
  if (!context.requestId) return undefined;
  const messages = cache?.get(context.requestId);
  const origin = cache?.getOrigin?.(context.requestId);
  const routeMatches =
    messages !== undefined &&
    origin !== undefined &&
    origin.sessionId === context.sessionId &&
    origin.requestClient === context.requestClient;
  context.serverOwnedRequest = routeMatches && origin?.verifiedIngress === true;
  if (routeMatches && origin?.authenticatedOrigin) {
    context.requestInitiator = {
      platform: origin.authenticatedOrigin.platform,
      userId: origin.authenticatedOrigin.userId,
    };
    context.requestInitiatorSessionId = origin.authenticatedOrigin.sessionRef.channelId;
  }
  return messages;
}

type SafetyMode = "trusted" | "restricted";

const RESTRICTED_LEVEL2_ALLOWED = new Set([
  "fetch",
  "search",
  "discovery.search",
  "generate.image",
  "generate.video",
  "attachment.add_files",
  "attachment.download",
  "resource.materialize",
  "skills.list",
  "skills.brief",
  "skills.full",
  "content.inspect",
  "surface.help",
  "surface.sessions.listParticipants",
  "surface.messages.list",
  "surface.messages.read",
  "surface.messages.send",
  "surface.messages.edit",
  "surface.messages.delete",
  "surface.reactions.list",
  "surface.reactions.listDetailed",
  "surface.reactions.add",
  "surface.reactions.remove",
]);

function isCurrentSessionScopedSurfaceCall(params: {
  callableId: string;
  input: unknown;
  sessionId?: string;
}): boolean {
  if (!params.callableId.startsWith("surface.")) return true;
  if (!params.sessionId) return false;
  if (!params.input || typeof params.input !== "object" || Array.isArray(params.input)) return true;

  const inputSessionId = Reflect.get(params.input, "sessionId");
  if (inputSessionId === undefined || inputSessionId === null || inputSessionId === "") return true;
  return inputSessionId === params.sessionId;
}

function isRestrictedCallableAllowed(params: {
  callableId: string;
  input?: unknown;
  ctx: RequestContext;
}): boolean {
  if (!RESTRICTED_LEVEL2_ALLOWED.has(params.callableId)) return false;
  return isCurrentSessionScopedSurfaceCall({
    callableId: params.callableId,
    input: params.input,
    sessionId: params.ctx.sessionId,
  });
}

function estimateJsonBytes(value: ToolJsonObject): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export type ToolServerOptions = {
  tools?: ServerTool[];
  pluginManager?: ToolPluginManagerLike;
  app?: Elysia;
  logger?: Logger;
  toolCallTimeouts?: ToolCallTimeoutOptions;
  healthConfig?: ToolServerHealthConfig;
  healthProvider?: (options?: {
    includeMemoryDiagnostics?: boolean;
  }) => ToolServerHealthProviderResult | Promise<ToolServerHealthProviderResult>;
  activeLevel1WorkProvider?: () => readonly ToolServerActiveLevel1Work[];
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
  getConfig?: () => Promise<CoreConfig>;
  /** Optional cache to provide request-scoped messages to tools. */
  requestMessageCache?: {
    get(requestId: string): readonly unknown[] | undefined;
    getOrigin?(requestId: string): AuthenticatedRequestOrigin | undefined;
  };
  canonicalWorkspaceRoot?: string;
  operatorTokenSha256?: string;
  authorizeControlRequest?: (input: {
    requestId: string;
    token: string;
    sessionId: string;
    platform: string;
    now: number;
  }) => {
    kind: "primary" | "heartbeat";
    principal: SurfacePrincipal | null;
    authenticatedOrigin: AuthenticatedSurfaceOrigin | null;
    allowedCallables: readonly string[] | null;
    profile: "primary" | NativeSubagentProfile;
    canonicalCwd: string;
    safetyMode: SafetyMode;
  } | null;
  resolveServerSafetyMode?: (context: RequestContext) => Promise<SafetyMode>;
  reportFatalToolCallDefect?: (defect: FatalToolCallDefect) => void;
};

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const SERVER_OWNED_RELOAD_CALLABLE_ID = "onboarding.reload_tools";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function adaptResultToHost<T, E>(result: ResultType<T, E>, toError: (error: E) => unknown): T {
  return result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => {
      throw toError(error);
    },
  })();
}

function validateToolServerOptions(
  options: ToolServerOptions,
): ResultType<string | undefined, ToolServerOptionsInvalid> {
  const operatorTokenSha256 = options.operatorTokenSha256?.trim().toLowerCase();
  if (!operatorTokenSha256 || /^[0-9a-f]{64}$/u.test(operatorTokenSha256)) {
    return Result.ok(operatorTokenSha256);
  }
  return Result.err(
    new ToolServerOptionsInvalid({
      message: "operatorTokenSha256 must be a SHA-256 hex digest",
    }),
  );
}

function adaptToolServerOptionsResultToHost(
  result: ResultType<string | undefined, ToolServerOptionsInvalid>,
): string | undefined {
  return adaptResultToHost(result, (error) => new Error(error.message));
}

function adaptToolAuthenticationResultToElysia(
  result: ResultType<AuthenticatedToolRequest, ToolRequestAuthenticationError>,
): AuthenticatedToolRequest {
  return adaptResultToHost(result, (error) => new Error(error.message));
}

function adaptToolRequestHeadersResultToElysia(
  result: ResultType<ToolRequestHeaders, ToolRequestHeadersInvalid>,
): ToolRequestHeaders {
  return adaptResultToHost(result, (error) => new Error(error.message));
}

function adaptSafetyModeResultToElysia(
  result: ResultType<SafetyMode, ToolSafetyModeResolutionError>,
): SafetyMode {
  return adaptResultToHost(result, (error) => new Error(error.message));
}

function adaptToolRouteResultToElysia<TValue>(
  result: ResultType<TValue, ToolRouteNotFound>,
): TValue {
  return adaptResultToHost(result, (error) => new NotFoundError(error.message));
}

function adaptPluginLifecycleResultToHost(
  operation: string,
  result: ResultType<void, ToolPluginManagerError | ToolPluginCleanupError>,
): void {
  adaptResultToHost(result, (error) => {
    const formatted = formatTaggedErrorForLog(error);
    return new Error(`Tool plugin ${operation} failed: ${formatted.errorMessage}`);
  });
}

function adaptPanicToToolServerHost(panic: Panic): never {
  throw panic;
}

function projectUnhandledRejectionReason(reason: unknown): string {
  return opaquePluginExceptionMessage(reason);
}

function createDeadlineSignal(timeoutMs: number): {
  signal: AbortSignal;
  cancel(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`tool call exceeded deadline (${timeoutMs}ms)`));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    cancel() {
      clearTimeout(timer);
    },
  };
}

function timeoutForTool(toolId: string, options?: ToolCallTimeoutOptions): number {
  return options?.perToolMs?.[toolId] ?? options?.defaultTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
}

function countLoadedExternalPlugins(statuses: readonly ToolPluginStatus[] | undefined): number {
  if (!statuses) return 0;
  return statuses.filter((status) => status.source === "external" && status.state === "loaded")
    .length;
}

const TOOL_CALL_OUTPUT_CONTRACT_DEFECT_MESSAGE =
  "Plugin tool output violated the JSON wire contract";

function projectFatalToolCallDefect(reason: unknown, opaque = false): FatalToolCallDefect {
  if (isPluginPanic(reason)) return reason;
  if (opaque) return new Error(TOOL_CALL_OUTPUT_CONTRACT_DEFECT_MESSAGE);
  return safePluginExceptionCause(reason);
}

export function normalizeSuccessfulToolValue(
  value: unknown,
): ResultType<ToolJsonValue, ToolPayloadInvalid> {
  let containsNonFiniteNumber = false;
  const normalized = Result.try({
    try: () => {
      const serialized = JSON.stringify(value, (_key, nested: unknown) => {
        if (typeof nested === "number" && !Number.isFinite(nested)) {
          containsNonFiniteNumber = true;
        }
        return nested;
      });
      if (serialized === undefined || containsNonFiniteNumber) {
        return { kind: "invalid" as const };
      }
      const parsed: unknown = JSON.parse(serialized);
      const decoded = toolJsonValueSchema.safeParse(parsed);
      return decoded.success
        ? { kind: "valid" as const, value: decoded.data }
        : { kind: "invalid" as const };
    },
    catch: (cause) => ({ restoreCause: () => cause }),
  });
  const settlement = normalized.match<
    | {
        readonly kind: "normalized";
        readonly outcome:
          | { readonly kind: "valid"; readonly value: ToolJsonValue }
          | { readonly kind: "invalid" };
      }
    | { readonly kind: "serialization-failed"; readonly restoreCause: () => unknown }
  >({
    ok: (outcome) => ({ kind: "normalized", outcome }),
    err: ({ restoreCause }) => ({ kind: "serialization-failed", restoreCause }),
  });
  if (settlement.kind === "serialization-failed") {
    const classified = Result.try({
      try: () => {
        const cause = settlement.restoreCause();
        return isPluginPanic(cause)
          ? ({ kind: "panic", panic: cause } as const)
          : ({ kind: "ordinary" } as const);
      },
      catch: () => ({ kind: "ordinary" }) as const,
    }).match<{ readonly kind: "panic"; readonly panic: Panic } | { readonly kind: "ordinary" }>({
      ok: (outcome) => outcome,
      err: () => ({ kind: "ordinary" }) as const,
    });
    if (classified.kind === "panic") {
      return adaptPanicToToolServerHost(classified.panic);
    }
    return Result.err(
      new ToolPayloadInvalid({ message: TOOL_CALL_OUTPUT_CONTRACT_DEFECT_MESSAGE }),
    );
  }
  const outcome = settlement.outcome;
  return outcome.kind === "valid"
    ? Result.ok(outcome.value)
    : Result.err(new ToolPayloadInvalid({ message: TOOL_CALL_OUTPUT_CONTRACT_DEFECT_MESSAGE }));
}

function signalFatalToolCallDefectToProcess(defect: FatalToolCallDefect): void {
  queueMicrotask(() => {
    throw defect;
  });
}

function observeToolCallRejection(
  context: {
    readonly didTimeout: () => boolean;
    readonly report: (defect: FatalToolCallDefect) => void;
  },
  defect: FatalToolCallDefect,
): void {
  if (!context.didTimeout() && !isPluginPanic(defect)) return;
  context.report(defect);
}

function superviseToolCallRejections(context: {
  readonly didTimeout: () => boolean;
  readonly promise: Promise<unknown>;
  readonly report: (defect: FatalToolCallDefect) => void;
}): void {
  void supervise();

  async function supervise(): Promise<void> {
    const captured = await Result.tryPromise({
      try: () => context.promise,
      catch: captureError,
    });
    const failure = captured.match({ ok: () => null, err: ({ cause }) => ({ cause }) });
    if (!failure) return;
    observeToolCallRejection(
      {
        didTimeout: context.didTimeout,
        report: context.report,
      },
      projectFatalToolCallDefect(failure.cause),
    );
  }
}

export function createToolServer(options: ToolServerOptions) {
  const operatorTokenSha256 = adaptToolServerOptionsResultToHost(
    validateToolServerOptions(options),
  );
  const logger =
    options.logger ??
    createLogger({
      module: "tool-server",
    });

  const staticTools = options.tools ?? [];
  const serverStartedAt = Date.now();
  const reportFatalToolCallDefect =
    options.reportFatalToolCallDefect ?? signalFatalToolCallDefectToProcess;

  let callMapping = new Map<string, ServerTool>();
  let level2ContributionMapping = new Map<string, Level2ContributionInfo>();
  let toolCatalog: ServerToolListResult = [];
  let toolReloadBarrier: Promise<void> | null = null;
  let activeToolCallLeases = 0;
  let toolCallsDrained: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  const healthState = createToolServerHealthState({
    logger,
    pluginManager: options.pluginManager,
    externalHealthProvider: options.healthProvider,
    activeLevel1WorkProvider: options.activeLevel1WorkProvider,
    onUnhealthy: options.onUnhealthy,
    reportFatalDefect: reportFatalToolCallDefect,
    ...options.healthConfig,
  });

  function logPluginError(
    operation: string,
    error: ToolPluginManagerError | ToolPluginCleanupError,
    context: Readonly<Record<string, unknown>> = {},
  ): void {
    logger.error(
      "tool plugin operation failed",
      toolServerTaggedErrorLogProjection(error, { operation, ...context }),
    );
  }

  async function requirePluginLifecycle(
    operation: "init" | "reload",
    run: () => Promise<Result<void, ToolPluginManagerError>>,
  ): Promise<ResultType<void, ToolPluginManagerError>> {
    const result = await run();
    return result.match<() => ResultType<void, ToolPluginManagerError>>({
      ok: () => () => result,
      err: (error) => () => {
        logPluginError(operation, error);
        return error._tag === "ToolPluginReloadCommittedCleanupError" ? Result.ok() : result;
      },
    })();
  }

  function contributionForTool(tool: ServerTool): Level2ContributionInfo {
    return (
      options.pluginManager?.getLevel2ContributionInfo?.().get(tool) ?? {
        pluginId: `static:${toolId(tool)}`,
        source: "builtin",
      }
    );
  }

  function toolId(tool: ServerTool): string {
    return options.pluginManager?.getLevel2Capabilities?.().get(tool)?.id ?? tool.id;
  }

  async function listTool(tool: ServerTool) {
    const contribution = contributionForTool(tool);
    return invokeLevel2List({
      pluginId: contribution.pluginId,
      source: contribution.source,
      tool,
      capability: options.pluginManager?.getLevel2Capabilities?.().get(tool),
    });
  }

  async function runStaticToolLifecycle(
    operation: "level2.init" | "level2.destroy",
  ): Promise<void> {
    const settledResults = await Promise.allSettled(
      staticTools.map((tool) => {
        const contribution = contributionForTool(tool);
        const params = {
          pluginId: contribution.pluginId,
          source: contribution.source,
          tool,
          capability: options.pluginManager?.getLevel2Capabilities?.().get(tool),
        };
        return operation === "level2.init" ? invokeLevel2Init(params) : invokeLevel2Destroy(params);
      }),
    );
    let panic: Panic | undefined;
    for (const settled of settledResults) {
      if (settled.status === "rejected") {
        if (!isPluginPanic(settled.reason)) {
          return adaptPanicToToolServerHost(
            new Panic({
              message: `Unexpected ${operation} cleanup rejection`,
              cause: settled.reason,
            }),
          );
        }
        if (panic === undefined) panic = settled.reason;
      } else {
        settled.value.match<() => void>({
          ok: () => () => undefined,
          err: (error) => () => logPluginError(operation, error),
        })();
      }
    }
    if (panic) return adaptPanicToToolServerHost(panic);
  }

  async function getActiveTools(): Promise<readonly ServerTool[]> {
    const pluginManager = options.pluginManager;
    if (pluginManager) return pluginManager.getLevel2Tools();
    return staticTools;
  }

  async function acquireToolCallLease() {
    while (toolReloadBarrier) await toolReloadBarrier;
    activeToolCallLeases++;
    let transferred = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeToolCallLeases--;
      if (activeToolCallLeases !== 0 || !toolCallsDrained) return;
      const drained = toolCallsDrained;
      toolCallsDrained = null;
      drained.resolve();
    };
    return {
      transfer() {
        transferred = true;
      },
      release,
      [Symbol.dispose]() {
        if (!transferred) release();
      },
    };
  }

  async function acquireToolReloadLease() {
    while (toolReloadBarrier) await toolReloadBarrier;
    const completed = Promise.withResolvers<void>();
    toolReloadBarrier = completed.promise;
    if (activeToolCallLeases > 0) {
      toolCallsDrained = Promise.withResolvers<void>();
      await toolCallsDrained.promise;
    }
    return {
      [Symbol.dispose]() {
        if (toolReloadBarrier === completed.promise) toolReloadBarrier = null;
        completed.resolve();
      },
    };
  }

  async function refreshToolMapping() {
    const nextCallMapping = new Map<string, ServerTool>();
    const nextContributionMapping = new Map<string, Level2ContributionInfo>();
    const nextToolCatalog: ServerToolListResult = [];
    const activeTools = await getActiveTools();
    const contributionByTool = options.pluginManager?.getLevel2ContributionInfo?.();
    for (const tool of activeTools) {
      const listed = await listTool(tool);
      const listError = listed.match({ ok: () => null, err: (error) => error });
      if (listError) {
        logPluginError("level2.list", listError, { toolId: toolId(tool) });
        continue;
      }
      const entries = listed.match({ ok: (value) => value, err: () => [] });
      nextToolCatalog.push(...entries);
      for (const { callableId } of entries) {
        nextCallMapping.set(callableId, tool);
        const contribution = contributionByTool?.get(tool);
        if (contribution) nextContributionMapping.set(callableId, contribution);
      }
    }
    callMapping = nextCallMapping;
    level2ContributionMapping = nextContributionMapping;
    toolCatalog = nextToolCatalog;
  }

  async function captureSafetyModeProvider<TValue extends SafetyMode | CoreConfig>(
    ctx: RequestContext,
    source: "server-provider" | "config",
    provider: () => Promise<TValue>,
  ): Promise<ResultType<TValue, ToolSafetyModeResolutionError>> {
    const captured = await Result.tryPromise({
      try: provider,
      catch: captureError,
    });
    return captured.match<() => ResultType<TValue, ToolSafetyModeResolutionError>>({
      ok: (value) => () => Result.ok(value),
      err:
        ({ cause }) =>
        () => {
          if (isPanic(cause)) return adaptPanicToToolServerHost(cause);
          return Result.err(
            new ToolSafetyModeResolutionError({
              source,
              sessionId: ctx.sessionId,
              cause: safePluginExceptionCause(cause),
              message: opaquePluginExceptionMessage(cause),
            }),
          );
        },
    })();
  }

  function captureAuthenticationOperation<TValue>(
    run: () => TValue,
  ): Promise<ResultType<Awaited<TValue>, ToolRequestAuthenticationError>> {
    return capture();

    async function capture(): Promise<ResultType<Awaited<TValue>, ToolRequestAuthenticationError>> {
      const captured = await Result.tryPromise({
        try: () => Promise.resolve(run()),
        catch: captureError,
      });
      return captured.match<() => ResultType<Awaited<TValue>, ToolRequestAuthenticationError>>({
        ok: (value) => () => Result.ok(value),
        err:
          ({ cause }) =>
          () => {
            if (isPanic(cause)) return adaptPanicToToolServerHost(cause);
            return Result.err(
              new ToolRequestAuthenticationError({
                cause: safePluginExceptionCause(cause),
                message: opaquePluginExceptionMessage(cause),
              }),
            );
          },
      })();
    }
  }

  async function resolveSafetyMode(
    ctx: RequestContext,
  ): Promise<ResultType<SafetyMode, ToolSafetyModeResolutionError>> {
    if (ctx.operator) return Result.ok("trusted");
    if (ctx.controlPolicy) return Result.ok(ctx.safetyMode ?? "restricted");
    if (ctx.safetyMode === "restricted") return Result.ok("restricted");
    if (!ctx.serverOwnedRequest) return Result.ok("restricted");
    let assertedSafetyMode: SafetyMode = "restricted";
    if (ctx.requestClient === "discord") {
      const serverSafetyModeProvider = options.resolveServerSafetyMode;
      if (serverSafetyModeProvider) {
        const resolved = await captureSafetyModeProvider(ctx, "server-provider", () =>
          serverSafetyModeProvider(ctx),
        );
        const resolvedValue = resolved.match({ ok: (value) => value, err: () => null });
        if (!resolvedValue) return resolved;
        assertedSafetyMode = resolvedValue;
      } else {
        const sessionId = ctx.sessionId;
        if (!sessionId || !options.getConfig) return Result.ok("restricted");
        const loaded = await captureSafetyModeProvider(ctx, "config", options.getConfig);
        const loadedValue = loaded.match({ ok: (value) => value, err: () => null });
        if (!loadedValue) return loaded.map(() => "restricted");
        assertedSafetyMode = resolveSessionSafetyMode(loadedValue, sessionId);
      }
    }
    return Result.ok(
      resolveAuthenticatedRequestSafetyMode({
        projection: {
          requestClient: ctx.requestClient ?? "unknown",
          source: "external",
          verifiedIngress: ctx.serverOwnedRequest,
        },
        assertedSafetyMode,
        correlatedAuthority: true,
      }),
    );
  }

  function resolveSafetyModeFailClosed(
    result: ResultType<SafetyMode, ToolSafetyModeResolutionError>,
  ): SafetyMode {
    return result.match<() => SafetyMode>({
      ok: (value) => () => value,
      err: (error) => () => {
        if (error.source === "server-provider") return adaptSafetyModeResultToElysia(result);
        logger.warn(
          "failed to resolve tool request safety mode",
          toolServerTaggedErrorLogProjection(error),
        );
        return "restricted";
      },
    })();
  }

  async function listToolsForContext(ctx: RequestContext) {
    const safetyMode = resolveSafetyModeFailClosed(await resolveSafetyMode(ctx));

    const visible: Array<{
      callableId: string;
      name: string;
      description: string;
      shortInput: string[];
      primaryPositional?: import("@stanley2058/lilac-plugin-runtime").ServerToolPrimaryPositional;
      hidden?: boolean;
    }> = [];
    for (const entry of toolCatalog) {
      if (!isCallableAllowedForControlCapability(entry.callableId, ctx)) continue;
      if (!(await isCallableAllowedForNativeProfile(entry.callableId, ctx))) continue;
      if (
        safetyMode === "restricted" &&
        !isRestrictedCallableAllowed({ callableId: entry.callableId, ctx })
      ) {
        continue;
      }
      visible.push({
        callableId: entry.callableId,
        name: entry.name,
        description: entry.description,
        shortInput: entry.shortInput,
        primaryPositional: entry.primaryPositional,
        hidden: entry.hidden,
      });
    }
    return { tools: visible };
  }

  async function isCallableAllowedForNativeProfile(
    callableId: string,
    ctx: RequestContext,
  ): Promise<boolean> {
    if (!ctx.subagentProfile) return true;
    if (!options.getConfig) return options.pluginManager === undefined;
    const contribution = level2ContributionMapping.get(callableId);
    if (!contribution) return false;
    return isLevel2ContributionAllowedForNativeProfile({
      config: await options.getConfig(),
      profileName: ctx.subagentProfile,
      pluginId: contribution.pluginId,
      callableId,
    });
  }

  function isCallableAllowedForControlCapability(callableId: string, ctx: RequestContext): boolean {
    if (ctx.controlPolicy?.kind !== "heartbeat") return true;
    return ctx.controlPolicy.allowedCallables?.includes(callableId) === true;
  }

  async function authenticateContext(
    headers: ToolRequestHeaders,
  ): Promise<ResultType<AuthenticatedToolRequest, ToolRequestAuthenticationError>> {
    const operatorToken = headers.operatorToken;
    if (operatorToken) {
      if (!operatorTokenSha256) {
        return Result.err(
          new ToolRequestAuthenticationError({ message: "Operator access is unavailable" }),
        );
      }
      const suppliedHash = createHash("sha256").update(operatorToken).digest();
      const expectedHash = Buffer.from(operatorTokenSha256, "hex");
      if (!timingSafeEqual(suppliedHash, expectedHash)) {
        return Result.err(
          new ToolRequestAuthenticationError({ message: "Operator token is invalid" }),
        );
      }
      if (!options.canonicalWorkspaceRoot) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Operator access requires a canonical workspace root",
          }),
        );
      }
      const operatorContext: RequestContext = {
        requestId: headers.requestId,
        toolCallId: headers.toolCallId,
        cwd: options.canonicalWorkspaceRoot,
        safetyMode: "trusted",
        serverOwnedRequest: true,
        operator: true,
      };
      bindRequestInvocationCwd(operatorContext, headers.cwd);
      return Result.ok({ context: operatorContext, messages: undefined });
    }
    const context = parseRequestContext(headers);
    bindRequestInvocationCwd(context, context.cwd);
    const cachedMessages = await captureAuthenticationOperation(() =>
      authenticateRequestContext(context, options.requestMessageCache),
    );
    const cacheError = cachedMessages.match({ ok: () => null, err: (error) => error });
    if (cacheError) return Result.err(cacheError);
    const messages = cachedMessages.match({ ok: (value) => value, err: () => undefined });
    if (options.authorizeControlRequest) {
      const authorizeControlRequest = options.authorizeControlRequest;
      if (
        !context.controlCapability ||
        !context.requestId ||
        !context.sessionId ||
        !context.requestClient ||
        !context.cwd
      ) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Level-2 tools require an active server-issued request capability",
          }),
        );
      }
      const requestId = context.requestId;
      const controlCapability = context.controlCapability;
      const sessionId = context.sessionId;
      const requestClient = context.requestClient;
      const authorization = await captureAuthenticationOperation(() =>
        authorizeControlRequest({
          requestId,
          token: controlCapability,
          sessionId,
          platform: requestClient,
          now: Date.now(),
        }),
      );
      const authorizationError = authorization.match({ ok: () => null, err: (error) => error });
      if (authorizationError) return Result.err(authorizationError);
      const authorized = authorization.match({ ok: (value) => value, err: () => null });
      if (!authorized) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Request control capability is invalid or expired",
          }),
        );
      }
      const cachedOrigin = options.requestMessageCache?.getOrigin?.(requestId);
      if (authorized.kind === "heartbeat") {
        if (authorized.authenticatedOrigin !== null || authorized.principal !== null) {
          return Result.err(
            new ToolRequestAuthenticationError({
              message: "Heartbeat capability must remain principal-less",
            }),
          );
        }
        context.serverOwnedRequest = true;
        context.cwd = authorized.canonicalCwd;
        context.safetyMode = "trusted";
        context.controlPolicy = {
          kind: authorized.kind,
          allowedCallables: authorized.allowedCallables,
        };
        context.subagentProfile = undefined;
        delete context.requestInitiator;
        delete context.requestInitiatorSessionId;
        delete context.currentTurnUserId;
        return Result.ok({ context, messages });
      }
      if (!cachedOrigin) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Request control capability requires a live cached request projection",
          }),
        );
      }
      if (cachedOrigin.requestClient !== requestClient || cachedOrigin.sessionId !== sessionId) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Request control capability route conflicts with cached request projection",
          }),
        );
      }
      const cachedAuthenticatedOrigin = cachedOrigin?.authenticatedOrigin ?? null;
      const authorizedOrigin = authorized.authenticatedOrigin;
      const originsMatch =
        cachedAuthenticatedOrigin === null
          ? authorizedOrigin === null
          : authorizedOrigin !== null &&
            cachedAuthenticatedOrigin.platform === authorizedOrigin.platform &&
            cachedAuthenticatedOrigin.userId === authorizedOrigin.userId &&
            cachedAuthenticatedOrigin.sessionRef.platform ===
              authorizedOrigin.sessionRef.platform &&
            cachedAuthenticatedOrigin.sessionRef.channelId ===
              authorizedOrigin.sessionRef.channelId;
      const capabilityIdentityValid =
        (authorizedOrigin === null && authorized.principal === null) ||
        (authorizedOrigin !== null &&
          authorized.principal !== null &&
          authorizedOrigin.platform === authorized.principal.platform &&
          authorizedOrigin.userId === authorized.principal.userId);
      if (!originsMatch || !capabilityIdentityValid) {
        return Result.err(
          new ToolRequestAuthenticationError({
            message: "Request control capability identity conflicts with cached request origin",
          }),
        );
      }
      context.serverOwnedRequest = cachedOrigin.verifiedIngress;
      context.cwd = authorized.canonicalCwd;
      context.safetyMode = authorized.safetyMode;
      context.controlPolicy = {
        kind: authorized.kind,
        allowedCallables: authorized.allowedCallables,
      };
      context.subagentProfile = authorized.profile === "primary" ? undefined : authorized.profile;
      delete context.requestInitiator;
      delete context.requestInitiatorSessionId;
      if (authorizedOrigin && authorized.principal) {
        context.requestInitiator = authorized.principal;
        context.requestInitiatorSessionId = authorizedOrigin.sessionRef.channelId;
      }
    }
    return Result.ok({ context, messages });
  }

  function lookupTool(callableId: string): ResultType<ServerTool, ToolRouteNotFound> {
    const tool = callMapping.get(callableId);
    if (tool) return Result.ok(tool);
    return Result.err(
      new ToolRouteNotFound({
        callableId,
        message: `Unknown callable ID '${callableId}'`,
      }),
    );
  }

  async function lookupHelpTool(params: {
    readonly callableId: string;
    readonly context: RequestContext;
    readonly safetyMode: SafetyMode;
  }): Promise<ResultType<ServerTool, ToolRouteNotFound>> {
    if (
      !isCallableAllowedForControlCapability(params.callableId, params.context) ||
      !(await isCallableAllowedForNativeProfile(params.callableId, params.context)) ||
      (params.safetyMode === "restricted" &&
        !isRestrictedCallableAllowed({ callableId: params.callableId, ctx: params.context }))
    ) {
      return Result.err(
        new ToolRouteNotFound({
          callableId: params.callableId,
          message: `Unknown callable ID '${params.callableId}'`,
        }),
      );
    }
    return lookupTool(params.callableId);
  }

  const app = options.app ?? new Elysia();

  app.onError(({ code, error }) => {
    logger.error("tool-server error", { code, ...frameworkErrorLogProjection(error) });
  });

  app.get("/health", async ({ set }) => {
    const snapshot = await healthState.getSnapshot();
    if (!snapshot.live) set.status = 503;
    return snapshot;
  });

  app.get("/healthz", async ({ set }) => {
    const snapshot = await healthState.getSnapshot();
    if (!snapshot.live) set.status = 503;
    return snapshot;
  });

  app.get("/readyz", async ({ set }) => {
    const snapshot = await healthState.getSnapshot();
    if (!snapshot.ready) set.status = 503;
    return snapshot;
  });

  app.get(
    "/versionz",
    async () => {
      const buildInfo = getBuildInfo({ cwd: MODULE_DIR });
      const loadedExternalPlugins = countLoadedExternalPlugins(
        options.pluginManager?.getStatuses?.(),
      );

      return {
        ok: true as const,
        version: buildInfo.version,
        commit: buildInfo.commit,
        dirty: buildInfo.dirty,
        builtAt: buildInfo.builtAt,
        plugins: {
          loadedExternal: loadedExternalPlugins,
        },
        startedAt: serverStartedAt,
        pid: process.pid,
      };
    },
    {
      response: BridgeVersionResponse,
    },
  );

  app.get(
    "/list",
    async ({ headers }) => {
      using _toolCatalogLease = await acquireToolCallLease();
      const decodedHeaders = adaptToolRequestHeadersResultToElysia(
        decodeToolRequestHeaders(headers),
      );
      const { context } = adaptToolAuthenticationResultToElysia(
        await authenticateContext(decodedHeaders),
      );
      return await listToolsForContext(context);
    },
    {
      response: BridgeListResponse,
    },
  );

  async function reloadTools(): Promise<void> {
    using _reloadLease = await acquireToolReloadLease();
    if (options.pluginManager) {
      const pluginManager = options.pluginManager;
      adaptPluginLifecycleResultToHost(
        "reload",
        await requirePluginLifecycle("reload", () => pluginManager.reload()),
      );
    } else {
      await runStaticToolLifecycle("level2.destroy");
      await runStaticToolLifecycle("level2.init");
    }
    await refreshToolMapping();
  }

  async function completeServerOwnedPostCall(
    callableId: string,
    result: ServerToolResult,
  ): Promise<ServerToolResult> {
    if (callableId !== SERVER_OWNED_RELOAD_CALLABLE_ID) return result;
    const shouldReload = result.match({ ok: () => true, err: () => false });
    if (!shouldReload) return result;

    const reloaded = await Result.tryPromise({
      try: reloadTools,
      catch: captureError,
    });
    return reloaded.match<() => ServerToolResult>({
      ok: () => () => result,
      err:
        ({ cause }) =>
        () => {
          if (isPanic(cause)) return adaptPanicToToolServerHost(cause);
          return Result.err(
            serverToolFailure({
              kind: "unavailable",
              code: "onboarding_unavailable",
              message: "Tool reload failed",
              retryable: true,
            }),
          );
        },
    })();
  }

  app.post("/reload", async () => {
    await reloadTools();
    return { ok: true as const };
  });

  app.get("/help/:callableId", async ({ params, headers }) => {
    using _toolCatalogLease = await acquireToolCallLease();
    const decodedHeaders = adaptToolRequestHeadersResultToElysia(decodeToolRequestHeaders(headers));
    const { context: ctx } = adaptToolAuthenticationResultToElysia(
      await authenticateContext(decodedHeaders),
    );
    const safetyMode = resolveSafetyModeFailClosed(await resolveSafetyMode(ctx));
    adaptToolRouteResultToElysia(
      await lookupHelpTool({ callableId: params.callableId, context: ctx, safetyMode }),
    );
    const output = toolCatalog.find(
      (entry: Awaited<ReturnType<ServerTool["list"]>>[number]) =>
        entry.callableId === params.callableId,
    );
    if (!output) {
      return adaptToolRouteResultToElysia(
        Result.err(
          new ToolRouteNotFound({
            callableId: params.callableId,
            message: `Unknown callable ID '${params.callableId}'`,
          }),
        ),
      );
    }
    return output;
  });

  app.post(
    "/call",
    async ({ body, request, headers }) => {
      using toolCallLease = await acquireToolCallLease();
      const startedAt = Date.now();

      const toolResult = lookupTool(body.callableId);
      const tool = toolResult.match({ ok: (value) => value, err: () => null });
      if (!tool) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "not_found",
            code: "unknown_callable",
            message: `Unknown callable ID '${body.callableId}'`,
            retryable: false,
          }),
        };
      }

      const decodedHeaders = decodeToolRequestHeaders(headers);
      const headerError = decodedHeaders.match({ ok: () => null, err: (error) => error });
      if (headerError) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "usage",
            code: "invalid_headers",
            message: headerError.message,
            retryable: false,
          }),
        };
      }
      const decodedHeaderValues = decodedHeaders.match({ ok: (value) => value, err: () => null });
      const authenticated = await authenticateContext(decodedHeaderValues ?? {});
      const authenticationError = authenticated.match({ ok: () => null, err: (error) => error });
      if (authenticationError) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "denied",
            code: "authentication_failed",
            message: authenticationError.message,
            retryable: false,
          }),
        };
      }
      const authenticatedRequest = authenticated.match({ ok: (value) => value, err: () => null });
      const { context: ctx, messages } = authenticatedRequest ?? {
        context: {},
        messages: undefined,
      };
      const decodedInput = decodeToolPayload(body.input);
      const inputError = decodedInput.match({ ok: () => null, err: (error) => error });
      if (inputError) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "usage",
            code: "invalid_input",
            message: inputError.message,
            retryable: false,
          }),
        };
      }
      const input = decodedInput.match({ ok: (value) => value, err: () => null }) ?? {};
      const safetyModeResult = await resolveSafetyMode(ctx);
      const safetyModeOutcome = safetyModeResult.match<
        { readonly safetyMode: SafetyMode } | { readonly error: ToolSafetyModeResolutionError }
      >({
        ok: (value) => ({ safetyMode: value }),
        err: (error) => ({ error }),
      });
      let safetyMode: SafetyMode;
      if ("error" in safetyModeOutcome) {
        if (safetyModeOutcome.error.source === "server-provider") {
          logger.error(
            "failed to resolve tool request safety mode",
            toolServerTaggedErrorLogProjection(safetyModeOutcome.error),
          );
          return {
            status: "error" as const,
            error: serverToolFailure({
              kind: "internal",
              code: "safety_mode_resolution_failed",
              message: "Internal tool server failure",
              retryable: false,
            }),
          };
        }
        logger.warn(
          "failed to resolve tool request safety mode",
          toolServerTaggedErrorLogProjection(safetyModeOutcome.error),
        );
        safetyMode = "restricted";
      } else {
        safetyMode = safetyModeOutcome.safetyMode;
      }
      ctx.safetyMode = safetyMode;
      if (
        ctx.controlPolicy?.kind === "heartbeat" &&
        body.callableId === "surface.messages.send" &&
        isRecord(input) &&
        ["paths", "filenames", "mimeTypes"].some((key) => input[key] !== undefined)
      ) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "denied",
            code: "heartbeat_attachments_denied",
            message: "Heartbeat surface messages are text-only and cannot include attachments",
            retryable: false,
          }),
        };
      }
      if (!isCallableAllowedForControlCapability(body.callableId, ctx)) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "denied",
            code: "capability_denied",
            message: `Tool '${body.callableId}' is outside the internal request capability`,
            retryable: false,
          }),
        };
      }
      if (!(await isCallableAllowedForNativeProfile(body.callableId, ctx))) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "denied",
            code: "profile_denied",
            message: `Tool '${body.callableId}' is not enabled for this subagent profile`,
            retryable: false,
          }),
        };
      }
      if (
        safetyMode === "restricted" &&
        !isRestrictedCallableAllowed({ callableId: body.callableId, input, ctx })
      ) {
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "denied",
            code: "restricted_mode_denied",
            message: `Tool '${body.callableId}' is not allowed in restricted public-session mode`,
            retryable: false,
          }),
        };
      }
      const inputBytes = estimateJsonBytes(input);
      const capturedToolId = toolId(tool);
      const timeoutMs = timeoutForTool(capturedToolId, options.toolCallTimeouts);
      const deadlineAt = Date.now() + timeoutMs;
      const timeoutSignal = createDeadlineSignal(timeoutMs);
      const combinedSignal = AbortSignal.any([request.signal, timeoutSignal.signal]);
      const callToken = healthState.beginToolCall({
        toolId: capturedToolId,
        callableId: body.callableId,
        deadlineAt,
        requestId: ctx.requestId,
      });

      logger.debug("tool call", {
        callableId: body.callableId,
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
        requestClient: ctx.requestClient,
        operator: ctx.operator === true,
        cwd: ctx.cwd,
        inputBytes,
        timeoutMs,
      });

      logger.debug("tool call input", {
        callableId: body.callableId,
        input: safeToolInputPreview(body.callableId, input),
      });

      const toolFailureResponse = (failure: ServerToolFailure) => {
        const safeFailure =
          body.callableId === "mcp.add"
            ? serverToolFailure({
                kind: failure.kind,
                code:
                  failure.kind === "usage" && failure.code === "invalid_input"
                    ? "invalid_input"
                    : "mcp_add_failed",
                message:
                  failure.kind === "usage" && failure.code === "invalid_input"
                    ? "mcp.add input validation failed"
                    : "mcp.add failed without exposing sensitive configuration",
                retryable: failure.retryable,
              })
            : failure;
        const errorLogDetails = {
          callableId: body.callableId,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          inputBytes,
          durationMs: Date.now() - startedAt,
          timeoutMs,
          ok: false,
          errorKind: safeFailure.kind,
          errorCode: safeFailure.code,
          cancelled: combinedSignal.aborted,
        };
        if (body.callableId === "mcp.add") {
          logger.error("tool.call.result", {
            ...errorLogDetails,
          });
        } else {
          logger.error("tool.call.result", errorLogDetails);
        }
        return {
          status: "error" as const,
          error: safeFailure,
        };
      };
      const internalPluginCallFailure = serverToolFailure({
        kind: "internal",
        code: "plugin_call_failed",
        message: "Internal tool server failure",
        retryable: false,
      });

      if (!ctx.operator && (!ctx.requestId || !ctx.sessionId || !ctx.requestClient)) {
        logger.warn("tool.call.context_missing", {
          callableId: body.callableId,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          hasRequestId: Boolean(ctx.requestId),
          hasSessionId: Boolean(ctx.sessionId),
          hasRequestClient: Boolean(ctx.requestClient),
        });
      }

      const contribution = contributionForTool(tool);
      let toolCallTimedOut = false;
      const invocationResult = Promise.resolve()
        .then(() =>
          invokeLevel2Call({
            pluginId: contribution.pluginId,
            source: contribution.source,
            tool,
            capability: options.pluginManager?.getLevel2Capabilities?.().get(tool),
            callableId: body.callableId,
            input,
            opts: {
              signal: combinedSignal,
              context: ctx,
              messages,
            },
          }),
        )
        .then((output) => {
          return output.match<() => ServerToolResult>({
            ok: (result) => () => result,
            err: (error) => () => {
              if (error._tag === "ToolPluginHookError") {
                reportFatalToolCallDefect(safePluginExceptionCause(error.cause));
              }
              if (body.callableId !== "mcp.add") {
                logPluginError("level2.call", error, {
                  toolId: capturedToolId,
                  callableId: body.callableId,
                });
              } else {
                logger.error("tool plugin operation failed", {
                  operation: "level2.call",
                  toolId: capturedToolId,
                  callableId: body.callableId,
                  errorTag: formatTaggedErrorForLog(error).errorTag,
                });
              }
              return Result.err(internalPluginCallFailure);
            },
          })();
        })
        .finally(() => {
          toolCallLease.release();
        });
      toolCallLease.transfer();
      const callResult = invocationResult
        .then((result) => completeServerOwnedPostCall(body.callableId, result))
        .finally(() => {
          healthState.endToolCall(callToken, {
            settled: true,
          });
        })
        .finally(() => {
          timeoutSignal.cancel();
        });
      superviseToolCallRejections({
        didTimeout: () => toolCallTimedOut,
        promise: callResult,
        report: reportFatalToolCallDefect,
      });

      const timeoutResult = new Promise<"timeout">((resolve) => {
        timeoutSignal.signal.addEventListener(
          "abort",
          () => {
            toolCallTimedOut = true;
            resolve("timeout");
          },
          { once: true },
        );
      });

      const result = await Promise.race([callResult, timeoutResult]);

      if (result === "timeout") {
        healthState.endToolCall(callToken, {
          settled: false,
          timedOut: true,
          failed: true,
          cancelled: true,
        });
        logger.error("tool.call.result", {
          callableId: body.callableId,
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          inputBytes,
          durationMs: Date.now() - startedAt,
          ok: false,
          timeoutMs,
          timedOut: true,
        });
        return {
          status: "error" as const,
          error: serverToolFailure({
            kind: "timeout",
            code: "tool_timeout",
            message: `Tool call timed out after ${timeoutMs}ms`,
            retryable: true,
          }),
        };
      }

      const completed: ServerToolResult = result;
      const completedOutcome = completed.match<
        | { readonly kind: "success"; readonly value: unknown }
        | { readonly kind: "failure"; readonly failure: ServerToolFailure }
      >({
        ok: (value) => ({ kind: "success", value }),
        err: (failure) => ({ kind: "failure", failure }),
      });
      if (completedOutcome.kind === "failure") {
        return toolFailureResponse(completedOutcome.failure);
      }
      const normalizedValue = normalizeSuccessfulToolValue(completedOutcome.value);
      const outputDefect = normalizedValue.match({ ok: () => null, err: (error) => error });
      if (outputDefect) {
        reportFatalToolCallDefect(outputDefect);
        logger.error("tool plugin operation failed", {
          operation: "level2.call",
          toolId: capturedToolId,
          callableId: body.callableId,
          errorTag: "ToolPluginCapabilityError",
        });
        return toolFailureResponse(internalPluginCallFailure);
      }
      const outputValue = normalizedValue.match({ ok: (value) => value, err: () => null });
      logger.info("tool.call.result", {
        callableId: body.callableId,
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
        requestClient: ctx.requestClient,
        hasMessagesContext: Array.isArray(messages) && messages.length > 0,
        inputBytes,
        durationMs: Date.now() - startedAt,
        timeoutMs,
        ok: true,
      });
      return { status: "ok" as const, value: outputValue };
    },
    {
      body: BridgeFnRequest,
      response: {
        200: BridgeFnResponse,
      },
    },
  );

  let started = false;
  let unixServer: ReturnType<typeof Bun.serve> | undefined;
  let unixSocketPath: string | undefined;

  function recordCleanupResult(
    label: string,
    result: ResultType<void, Error>,
  ): ToolServerCleanupFailure | undefined {
    const failure = result.match<ToolServerCleanupFailure | undefined>({
      ok: () => undefined,
      err: (cause) => ({ label, cause }),
    });
    if (!failure) return undefined;
    logger.error("tool server cleanup failed", {
      operation: failure.label,
      ...frameworkErrorLogProjection(failure.cause),
    });
    return failure;
  }

  function captureCleanupOperation(
    label: string,
    operation: () => void,
  ): ToolServerCleanupFailure | undefined {
    const result = Result.try({ try: operation, catch: captureError }).mapError(
      (error) => error.cause,
    );
    return recordCleanupResult(label, result);
  }

  function settleLifecycleFailure(
    priorFailure: Error | undefined,
    cleanupFailures: readonly ToolServerCleanupFailure[],
  ): void {
    if (priorFailure && isPanic(priorFailure)) adaptPanicToToolServerHost(priorFailure);
    for (const failure of cleanupFailures) {
      if (isPanic(failure.cause)) adaptPanicToToolServerHost(failure.cause);
    }
    if (priorFailure) adaptResultToHost(Result.err(priorFailure), (error) => error);
    const cleanupFailure = cleanupFailures[0];
    if (cleanupFailure) adaptResultToHost(Result.err(cleanupFailure.cause), (error) => error);
  }

  function startUnixServer(socketPath: string): ResultType<void, Error> {
    return removeOwnedUnixSocket(socketPath).andThen(() =>
      Result.try({
        try: () => {
          const server = Bun.serve({
            unix: socketPath,
            fetch: (request) => app.fetch(request),
          });
          unixServer = server;
          unixSocketPath = socketPath;
          chmodSync(socketPath, 0o600);
        },
        catch: captureError,
      }).mapError((error) => error.cause),
    );
  }

  function stopServers(): ToolServerCleanupFailure[] {
    const appWasStarted = started;
    const capturedUnixServer = unixServer;
    const capturedUnixSocketPath = unixSocketPath;
    started = false;
    unixServer = undefined;
    unixSocketPath = undefined;

    const failures: ToolServerCleanupFailure[] = [];
    if (appWasStarted) {
      const failure = captureCleanupOperation("http.stop", () => app.stop());
      if (failure) failures.push(failure);
    }
    if (capturedUnixServer) {
      const failure = captureCleanupOperation("unix.stop", () => capturedUnixServer.stop(true));
      if (failure) failures.push(failure);
    }
    if (capturedUnixSocketPath) {
      const failure = recordCleanupResult(
        "unix.remove",
        removeOwnedUnixSocket(capturedUnixSocketPath),
      );
      if (failure) failures.push(failure);
    }
    return failures;
  }

  function rollbackServerStart(priorFailure: Error): void {
    const failures = stopServers();
    const markFailure = captureCleanupOperation("health.mark-not-listening", () => {
      healthState.markListening(false);
    });
    if (markFailure) failures.push(markFailure);
    const monitoringFailure = captureCleanupOperation("health.stop-monitoring", () => {
      healthState.stopMonitoring();
    });
    if (monitoringFailure) failures.push(monitoringFailure);
    settleLifecycleFailure(priorFailure, failures);
  }

  function recordUnhandledRejectionAtBoundary(reason: unknown): void {
    healthState.recordUnhandledRejection(projectUnhandledRejectionReason(reason));
  }

  return {
    app,
    init: async () => {
      if (options.pluginManager) {
        const pluginManager = options.pluginManager;
        adaptPluginLifecycleResultToHost(
          "init",
          await requirePluginLifecycle("init", () => pluginManager.init()),
        );
      } else {
        await runStaticToolLifecycle("level2.init");
      }
      await refreshToolMapping();
      healthState.markInitialized(true);
    },
    start: async (port: number) => {
      if (started) return;
      started = true;
      const configuredSocket = process.env.TOOL_SERVER_BACKEND_SOCKET;
      const startup = Result.try({
        try: () => {
          healthState.startMonitoring();
          // Elysia listen is sync-ish, but server becomes available shortly after.
          app.listen(port);
        },
        catch: captureError,
      })
        .mapError((error) => error.cause)
        .andThen(() =>
          configuredSocket ? startUnixServer(configuredSocket) : Result.ok(undefined),
        )
        .andThen(() =>
          Result.try({
            try: () => {
              healthState.markListening(true);
              logger.info(
                `Tool server listening on port ${app.server?.hostname}:${app.server?.port}`,
              );
              if (unixSocketPath)
                logger.info(`Tool server listening on unix socket ${unixSocketPath}`);
            },
            catch: captureError,
          }).mapError((error) => error.cause),
        );
      startup.match<() => void>({
        ok: () => () => undefined,
        err: (error) => () => rollbackServerStart(error),
      })();
    },
    stop: async () => {
      const destroy = async () => {
        if (options.pluginManager) {
          const destroyed = await options.pluginManager.destroy();
          destroyed.match<() => void>({
            ok: () => () => undefined,
            err: (error) => () => logPluginError("destroy", error),
          })();
        } else {
          await runStaticToolLifecycle("level2.destroy");
        }
      };
      const failures: ToolServerCleanupFailure[] = [];
      const markListeningFailure = captureCleanupOperation("health.mark-not-listening", () => {
        healthState.markListening(false);
      });
      if (markListeningFailure) failures.push(markListeningFailure);
      const markInitializedFailure = captureCleanupOperation("health.mark-not-initialized", () => {
        healthState.markInitialized(false);
      });
      if (markInitializedFailure) failures.push(markInitializedFailure);
      const monitoringFailure = captureCleanupOperation("health.stop-monitoring", () => {
        healthState.stopMonitoring();
      });
      if (monitoringFailure) failures.push(monitoringFailure);

      const destroyResult = (
        await Result.tryPromise({ try: destroy, catch: captureError })
      ).mapError((error) => error.cause);
      const destroyFailure = recordCleanupResult("tools.destroy", destroyResult);
      if (destroyFailure) failures.push(destroyFailure);
      failures.push(...stopServers());
      settleLifecycleFailure(undefined, failures);
    },
    reload: reloadTools,
    getHealthSnapshot: async () => await healthState.getSnapshot(),
    recordUnhandledRejection: recordUnhandledRejectionAtBoundary,
  };
}

export type {
  ToolServerActiveLevel1Work,
  ToolServerHealthCheck,
  ToolServerHealthConfig,
  ToolServerHealthProviderResult,
  ToolServerHealthSnapshot,
  ToolServerLagIncident,
};
