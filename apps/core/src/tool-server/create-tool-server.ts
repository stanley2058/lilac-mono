import Elysia, { NotFoundError } from "elysia";
import { createLogger } from "@stanley2058/lilac-utils";
import type { Logger } from "@stanley2058/simple-module-logger";

import { BridgeFnRequest, BridgeFnResponse, BridgeListResponse } from "./schema";
import {
  createToolServerHealthState,
  type ToolServerHealthCheck,
  type ToolServerHealthConfig,
  type ToolServerHealthProviderResult,
  type ToolServerHealthSnapshot,
} from "./health-state";
import type { RequestContext, ServerTool } from "./types";
import { ToolInputValidationError } from "./validation-error-message";

type ToolPluginManagerLike = {
  init(): Promise<void>;
  destroy(): Promise<void>;
  reload(): Promise<void>;
  ensureFresh(): Promise<void>;
  getLevel2Tools(): readonly ServerTool[];
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
  };
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
  onUnhealthy?: (snapshot: ToolServerHealthSnapshot) => void | Promise<void>;
  /** Optional cache to provide request-scoped messages to tools. */
  requestMessageCache?: {
    get(requestId: string): readonly unknown[] | undefined;
  };
};

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;

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

function getVersion(): string {
  const pkgVersion = process.env.npm_package_version?.trim();
  return pkgVersion && pkgVersion.length > 0 ? pkgVersion : "dev";
}

export function createToolServer(options: ToolServerOptions) {
  const logger =
    options.logger ??
    createLogger({
      module: "tool-server",
    });

  const staticTools = options.tools ?? [];
  const serverStartedAt = Date.now();

  const callMapping = new Map<string, ServerTool>();
  const healthState = createToolServerHealthState({
    logger,
    pluginManager: options.pluginManager,
    externalHealthProvider: options.healthProvider,
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
    callMapping.clear();
    for (const tool of await getActiveTools()) {
      for (const { callableId } of await tool.list()) {
        callMapping.set(callableId, tool);
      }
    }
  }

  async function ensureFreshToolMapping() {
    await refreshToolMapping();
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

  app.get("/versionz", async () => ({
    ok: true as const,
    version: getVersion(),
    startedAt: serverStartedAt,
    pid: process.pid,
  }));

  app.get(
    "/list",
    async () => {
      await ensureFreshToolMapping();
      const tools = await getActiveTools();
      const toolDescs = await Promise.allSettled(tools.map((t) => t.list()));
      const succeeded = toolDescs
        .filter(
          (result): result is PromiseFulfilledResult<Awaited<ReturnType<ServerTool["list"]>>> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      return {
        tools: succeeded.flatMap((s) =>
          s.map((entry: Awaited<ReturnType<ServerTool["list"]>>[number]) => ({
            callableId: entry.callableId,
            name: entry.name,
            description: entry.description,
            shortInput: entry.shortInput,
            primaryPositional: entry.primaryPositional,
            hidden: entry.hidden,
          })),
        ),
      };
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

  app.get("/help/:callableId", async ({ params }) => {
    await ensureFreshToolMapping();
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

      const ctx = parseRequestContext(headers);
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
        cwd: ctx.cwd,
        inputBytes,
        timeoutMs,
      });

      logger.debug("tool call input", {
        callableId: body.callableId,
        input: safeJsonPreview(body.input),
      });

      try {
        const messages = ctx.requestId
          ? options.requestMessageCache?.get(ctx.requestId)
          : undefined;

        if (!ctx.requestId || !ctx.sessionId || !ctx.requestClient) {
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
  ToolServerHealthCheck,
  ToolServerHealthConfig,
  ToolServerHealthProviderResult,
  ToolServerHealthSnapshot,
};
