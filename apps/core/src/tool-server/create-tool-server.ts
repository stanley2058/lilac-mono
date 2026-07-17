import Elysia, { NotFoundError } from "elysia";
import {
  createLogger,
  extractAiErrorLogDetails,
  getBuildInfo,
  isRecord,
  isNativeSubagentProfile,
  profileIncludes,
  resolveNativeSubagentProfile,
  type CoreConfig,
  type NativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import type { Level2ContributionInfo } from "@stanley2058/lilac-plugin-runtime";
import type { Logger } from "@stanley2058/simple-module-logger";
import { createHash, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
import { ToolInputValidationError } from "./validation-error-message";

type ToolPluginManagerLike = {
  init(): Promise<void>;
  destroy(): Promise<void>;
  reload(): Promise<void>;
  ensureFresh(): Promise<void>;
  getLevel2Tools(): readonly ServerTool[];
  getLevel2ContributionInfo?(): ReadonlyMap<ServerTool, Level2ContributionInfo>;
  getStatuses?(): readonly unknown[];
};

type ToolCallTimeoutOptions = {
  defaultTimeoutMs?: number;
  perToolMs?: Record<string, number>;
};

function safeJsonPreview(value: unknown, maxChars = 2000): string {
  const SENSITIVE_KEYS = new Set([
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

  const seen = new WeakSet<object>();
  const replacer = (key: string, val: unknown) => {
    if (SENSITIVE_KEYS.has(key)) return "<redacted>";
    if (typeof val === "object" && val !== null) {
      if (seen.has(val as object)) return "<circular>";
      seen.add(val as object);
    }
    return val;
  };

  let raw = "";
  try {
    raw = JSON.stringify(value, replacer);
  } catch {
    raw = String(value);
  }

  return raw.length > maxChars ? `${raw.slice(0, maxChars)}...` : raw;
}

function headerStr(h: unknown): string | undefined {
  return typeof h === "string" && h.length > 0 ? h : undefined;
}

function parseRequestContext(headers: Record<string, unknown>): RequestContext {
  return {
    requestId: headerStr(headers["x-lilac-request-id"]),
    sessionId: headerStr(headers["x-lilac-session-id"]),
    requestClient: headerStr(headers["x-lilac-request-client"]),
    cwd: headerStr(headers["x-lilac-cwd"]),
    toolCallId: headerStr(headers["x-lilac-tool-call-id"]),
    controlCapability: headerStr(headers["x-lilac-control-capability"]),
    subagentProfile: (() => {
      const profile = headerStr(headers["x-lilac-subagent-profile"]);
      return isNativeSubagentProfile(profile) ? profile : undefined;
    })(),
    safetyMode:
      headerStr(headers["x-lilac-safety-mode"]) === "restricted" ? "restricted" : undefined,
  };
}

function authenticateRequestContext(
  context: RequestContext,
  cache: ToolServerOptions["requestMessageCache"],
): readonly unknown[] | undefined {
  if (!context.requestId) return undefined;
  const messages = cache?.get(context.requestId);
  const origin = cache?.getOrigin?.(context.requestId);
  context.serverOwnedRequest =
    messages !== undefined &&
    origin !== undefined &&
    origin.sessionId === context.sessionId &&
    origin.platform === context.requestClient;
  if (context.serverOwnedRequest && origin?.actorUserId) {
    context.authenticatedPrincipal = { platform: origin.platform, userId: origin.actorUserId };
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

function estimateJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Buffer.byteLength(String(value), "utf8");
  }
}

export type ToolServerOptions = {
  tools?: ServerTool[];
  pluginManager?: ToolPluginManagerLike;
  app?: Elysia;
  logger?: Logger;
  toolCallTimeouts?: ToolCallTimeoutOptions;
  healthConfig?: ToolServerHealthConfig;
  healthProvider?: () => ToolServerHealthProviderResult | Promise<ToolServerHealthProviderResult>;
  activeLevel1WorkProvider?: () => readonly ToolServerActiveLevel1Work[];
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
  getConfig?: () => Promise<CoreConfig>;
  /** Optional cache to provide request-scoped messages to tools. */
  requestMessageCache?: {
    get(requestId: string): readonly unknown[] | undefined;
    getOrigin?(requestId: string):
      | {
          sessionId: string;
          platform: "discord" | "github";
          actorUserId: string | null;
        }
      | undefined;
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
    principal: { platform: "discord" | "github"; userId: string } | null;
    allowedCallables: readonly string[] | null;
    profile: "primary" | NativeSubagentProfile;
    canonicalCwd: string;
    safetyMode: SafetyMode;
  } | null;
  resolveServerSafetyMode?: (context: RequestContext) => Promise<SafetyMode>;
};

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

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

function timeoutForTool(tool: ServerTool, options?: ToolCallTimeoutOptions): number {
  return options?.perToolMs?.[tool.id] ?? options?.defaultTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
}

function countLoadedExternalPlugins(statuses: readonly unknown[] | undefined): number {
  if (!statuses) return 0;

  let count = 0;
  for (const status of statuses) {
    if (!status || typeof status !== "object") continue;

    const source = Reflect.get(status, "source");
    const state = Reflect.get(status, "state");
    if (source === "external" && state === "loaded") count += 1;
  }

  return count;
}

export function createToolServer(options: ToolServerOptions) {
  const operatorTokenSha256 = options.operatorTokenSha256?.trim().toLowerCase();
  if (operatorTokenSha256 && !/^[0-9a-f]{64}$/u.test(operatorTokenSha256)) {
    throw new Error("operatorTokenSha256 must be a SHA-256 hex digest");
  }
  const logger =
    options.logger ??
    createLogger({
      module: "tool-server",
    });

  const staticTools = options.tools ?? [];
  const serverStartedAt = Date.now();

  let callMapping = new Map<string, ServerTool>();
  let level2ContributionMapping = new Map<string, Level2ContributionInfo>();
  const healthState = createToolServerHealthState({
    logger,
    pluginManager: options.pluginManager,
    externalHealthProvider: options.healthProvider,
    activeLevel1WorkProvider: options.activeLevel1WorkProvider,
    onUnhealthy: options.onUnhealthy,
    ...options.healthConfig,
  });

  async function getActiveTools(): Promise<readonly ServerTool[]> {
    if (options.pluginManager) {
      await options.pluginManager.ensureFresh();
      return options.pluginManager.getLevel2Tools();
    }
    return staticTools;
  }

  async function refreshToolMapping() {
    const nextCallMapping = new Map<string, ServerTool>();
    const nextContributionMapping = new Map<string, Level2ContributionInfo>();
    const activeTools = await getActiveTools();
    const contributionByTool = options.pluginManager?.getLevel2ContributionInfo?.();
    for (const tool of activeTools) {
      for (const { callableId } of await tool.list()) {
        nextCallMapping.set(callableId, tool);
        const contribution = contributionByTool?.get(tool);
        if (contribution) nextContributionMapping.set(callableId, contribution);
      }
    }
    callMapping = nextCallMapping;
    level2ContributionMapping = nextContributionMapping;
  }

  async function ensureFreshToolMapping() {
    await refreshToolMapping();
  }

  async function resolveSafetyMode(ctx: RequestContext): Promise<SafetyMode> {
    if (ctx.operator) return "trusted";
    if (ctx.controlPolicy) return ctx.safetyMode ?? "restricted";
    if (ctx.safetyMode === "restricted") return "restricted";
    if (options.resolveServerSafetyMode) return await options.resolveServerSafetyMode(ctx);
    const sessionId = ctx.sessionId;
    if (!sessionId || !options.getConfig) return "trusted";
    try {
      const cfg = await options.getConfig();
      return cfg.surface.router.sessionModes[sessionId]?.safetyMode ?? "trusted";
    } catch (error) {
      logger.warn("failed to resolve tool request safety mode", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "restricted";
    }
  }

  async function listToolsForContext(ctx: RequestContext) {
    const safetyMode = await resolveSafetyMode(ctx);
    const tools = await getActiveTools();
    const toolDescs = await Promise.allSettled(tools.map((t) => t.list()));
    const succeeded = toolDescs
      .filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<ServerTool["list"]>>> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);

    const visible: Array<{
      callableId: string;
      name: string;
      description: string;
      shortInput: string[];
      primaryPositional?: import("@stanley2058/lilac-plugin-runtime").ServerToolPrimaryPositional;
      hidden?: boolean;
    }> = [];
    for (const entries of succeeded) {
      for (const entry of entries) {
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
    const profile = resolveNativeSubagentProfile(await options.getConfig(), ctx.subagentProfile);
    return (
      profileIncludes(profile.level2.plugins, contribution.pluginId) &&
      profileIncludes(profile.level2.callables, callableId)
    );
  }

  function isCallableAllowedForControlCapability(callableId: string, ctx: RequestContext): boolean {
    if (ctx.controlPolicy?.kind !== "heartbeat") return true;
    return ctx.controlPolicy.allowedCallables?.includes(callableId) === true;
  }

  function authenticateContext(headers: Record<string, unknown>): {
    context: RequestContext;
    messages: readonly unknown[] | undefined;
  } {
    const operatorToken = headerStr(headers["x-lilac-operator-token"]);
    if (operatorToken) {
      if (!operatorTokenSha256) throw new Error("Operator access is unavailable");
      const suppliedHash = createHash("sha256").update(operatorToken).digest();
      const expectedHash = Buffer.from(operatorTokenSha256, "hex");
      if (!timingSafeEqual(suppliedHash, expectedHash)) {
        throw new Error("Operator token is invalid");
      }
      if (!options.canonicalWorkspaceRoot) {
        throw new Error("Operator access requires a canonical workspace root");
      }
      return {
        context: {
          requestId: headerStr(headers["x-lilac-request-id"]),
          toolCallId: headerStr(headers["x-lilac-tool-call-id"]),
          cwd: options.canonicalWorkspaceRoot,
          safetyMode: "trusted",
          serverOwnedRequest: true,
          operator: true,
        },
        messages: undefined,
      };
    }
    const context = parseRequestContext(headers);
    const messages = authenticateRequestContext(context, options.requestMessageCache);
    if (options.authorizeControlRequest) {
      if (
        !context.controlCapability ||
        !context.requestId ||
        !context.sessionId ||
        !context.requestClient ||
        !context.cwd
      ) {
        throw new Error("Level-2 tools require an active server-issued request capability");
      }
      const authorized = options.authorizeControlRequest?.({
        requestId: context.requestId,
        token: context.controlCapability,
        sessionId: context.sessionId,
        platform: context.requestClient,
        now: Date.now(),
      });
      if (!authorized) throw new Error("Request control capability is invalid or expired");
      context.serverOwnedRequest = true;
      context.cwd = authorized.canonicalCwd;
      context.safetyMode = authorized.safetyMode;
      context.controlPolicy = {
        kind: authorized.kind,
        allowedCallables: authorized.allowedCallables,
      };
      context.subagentProfile = authorized.profile === "primary" ? undefined : authorized.profile;
      if (authorized.principal) context.authenticatedPrincipal = authorized.principal;
    }
    return { context, messages };
  }

  const app = options.app ?? new Elysia();

  app.onError(({ code, error }) => {
    logger.error("tool-server error", { code }, error);
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
      if (options.pluginManager) {
        await options.pluginManager.ensureFresh();
      }

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
      await ensureFreshToolMapping();
      const { context } = authenticateContext(headers);
      return await listToolsForContext(context);
    },
    {
      response: BridgeListResponse,
    },
  );

  app.post("/reload", async () => {
    if (options.pluginManager) {
      await options.pluginManager.reload();
    } else {
      await Promise.allSettled(staticTools.map((t) => t.destroy()));
      await Promise.allSettled(staticTools.map((t) => t.init()));
    }
    await refreshToolMapping();
    return { ok: true as const };
  });

  app.get("/help/:callableId", async ({ params, headers }) => {
    await ensureFreshToolMapping();
    const { context: ctx } = authenticateContext(headers);
    const safetyMode = await resolveSafetyMode(ctx);
    if (
      !isCallableAllowedForControlCapability(params.callableId, ctx) ||
      !(await isCallableAllowedForNativeProfile(params.callableId, ctx)) ||
      (safetyMode === "restricted" &&
        !isRestrictedCallableAllowed({ callableId: params.callableId, ctx }))
    ) {
      throw new NotFoundError(`Unknown callable ID '${params.callableId}'`);
    }
    const tool = callMapping.get(params.callableId);
    if (!tool) {
      throw new NotFoundError(`Unknown callable ID '${params.callableId}'`);
    }
    const desc = await tool.list();
    const output = desc.find(
      (entry: Awaited<ReturnType<ServerTool["list"]>>[number]) =>
        entry.callableId === params.callableId,
    );
    if (!output) return new NotFoundError();
    return output;
  });

  app.post(
    "/call",
    async ({ body, request, headers }) => {
      await ensureFreshToolMapping();
      const startedAt = Date.now();

      const tool = callMapping.get(body.callableId);
      if (!tool) {
        throw new NotFoundError(`Unknown callable ID '${body.callableId}'`);
      }

      const { context: ctx, messages } = authenticateContext(headers);
      const safetyMode = await resolveSafetyMode(ctx);
      ctx.safetyMode = safetyMode;
      if (
        ctx.controlPolicy?.kind === "heartbeat" &&
        body.callableId === "surface.messages.send" &&
        isRecord(body.input) &&
        ["paths", "filenames", "mimeTypes"].some((key) => body.input[key] !== undefined)
      ) {
        return {
          isError: true,
          output: "Heartbeat surface messages are text-only and cannot include attachments",
        };
      }
      if (!isCallableAllowedForControlCapability(body.callableId, ctx)) {
        return {
          isError: true,
          output: `Tool '${body.callableId}' is outside the internal request capability`,
        };
      }
      if (!(await isCallableAllowedForNativeProfile(body.callableId, ctx))) {
        return {
          isError: true,
          output: `Tool '${body.callableId}' is not enabled for this subagent profile`,
        };
      }
      if (
        safetyMode === "restricted" &&
        !isRestrictedCallableAllowed({ callableId: body.callableId, input: body.input, ctx })
      ) {
        return {
          isError: true,
          output: `Tool '${body.callableId}' is not allowed in restricted public-session mode`,
        };
      }
      const inputBytes = estimateJsonBytes(body.input);
      const timeoutMs = timeoutForTool(tool, options.toolCallTimeouts);
      const deadlineAt = Date.now() + timeoutMs;
      const timeoutSignal = createDeadlineSignal(timeoutMs);
      const combinedSignal = AbortSignal.any([request.signal, timeoutSignal.signal]);
      const callToken = healthState.beginToolCall({
        toolId: tool.id,
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
        input: safeJsonPreview(
          body.callableId.startsWith("workflow.") ? "<redacted workflow input>" : body.input,
        ),
      });

      try {
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

        const callResult = Promise.resolve()
          .then(() =>
            tool.call(body.callableId, body.input, {
              signal: combinedSignal,
              context: ctx,
              messages,
            }),
          )
          .then(
            (output) => ({ kind: "success" as const, output }),
            (error) => ({ kind: "error" as const, error }),
          )
          .finally(() => {
            healthState.endToolCall(callToken, {
              settled: true,
            });
          })
          .finally(() => {
            timeoutSignal.cancel();
          });

        const timeoutResult = new Promise<{ kind: "timeout" }>((resolve) => {
          timeoutSignal.signal.addEventListener(
            "abort",
            () => {
              resolve({ kind: "timeout" });
            },
            { once: true },
          );
        });

        const result = await Promise.race([callResult, timeoutResult]);

        if (result.kind === "timeout") {
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
            isError: true,
            output: `Tool call timed out after ${timeoutMs}ms`,
          };
        }

        if (result.kind === "error") {
          throw result.error;
        }

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
        return { isError: false, output: result.output };
      } catch (e) {
        if (request.signal.aborted) {
          healthState.endToolCall(callToken, {
            settled: false,
            cancelled: true,
          });
        } else if (!timeoutSignal.signal.aborted) {
          healthState.endToolCall(callToken, {
            settled: false,
            failed: true,
            cancelled: combinedSignal.aborted,
          });
        }
        logger.error(
          "tool.call.result",
          {
            callableId: body.callableId,
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            requestClient: ctx.requestClient,
            inputBytes,
            durationMs: Date.now() - startedAt,
            timeoutMs,
            ok: false,
            errorClass: e instanceof Error ? e.name : "unknown",
            cancelled: combinedSignal.aborted,
            ...extractAiErrorLogDetails(e),
          },
          e,
        );

        return {
          isError: true,
          output:
            e instanceof ToolInputValidationError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e),
        };
      }
    },
    {
      body: BridgeFnRequest,
      response: {
        200: BridgeFnResponse,
      },
    },
  );

  let started = false;

  return {
    app,
    init: async () => {
      if (options.pluginManager) {
        await options.pluginManager.init();
      } else {
        const initResult = await Promise.allSettled(staticTools.map((t) => t.init()));
        for (const result of initResult) {
          if (result.status === "rejected") {
            logger.error("tool init failed", result.reason);
          }
        }
      }
      await refreshToolMapping();
      healthState.markInitialized(true);
    },
    start: async (port: number) => {
      if (started) return;
      started = true;
      healthState.startMonitoring();

      // Elysia listen is sync-ish, but server becomes available shortly after.
      app.listen(port);
      healthState.markListening(true);
      logger.info(`Tool server listening on port ${app.server?.hostname}:${app.server?.port}`);
    },
    stop: async () => {
      healthState.markListening(false);
      healthState.markInitialized(false);
      healthState.stopMonitoring();
      if (options.pluginManager) {
        await options.pluginManager.destroy();
      } else {
        await Promise.allSettled(staticTools.map((t) => t.destroy()));
      }
      if (started) {
        app.stop();
      }
      started = false;
    },
    getHealthSnapshot: async () => await healthState.getSnapshot(),
    recordUnhandledRejection: (reason: unknown) => {
      healthState.recordUnhandledRejection(reason);
    },
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
