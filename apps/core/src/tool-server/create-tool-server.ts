import Elysia, { NotFoundError } from "elysia";
import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";

import { BridgeFnRequest, BridgeFnResponse, BridgeListResponse } from "./schema";
import type { RequestContext, ServerTool } from "./types";

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

export type ToolServerOptions = {
  tools: ServerTool[];
  app?: Elysia;
  logger?: Logger;
  /** Optional cache to provide request-scoped messages to tools. */
  requestMessageCache?: {
    get(requestId: string): readonly unknown[] | undefined;
  };
};

export function createToolServer(options: ToolServerOptions) {
  const logger =
    options.logger ??
    new Logger({
      logLevel: resolveLogLevel(),
      module: "tool-server",
    });

  const tools = options.tools;

  const callMapping = new Map<string, ServerTool>();

  async function refreshToolMapping() {
    callMapping.clear();
    for (const tool of tools) {
      for (const { callableId } of await tool.list()) {
        callMapping.set(callableId, tool);
      }
    }
  }

  const app = options.app ?? new Elysia();

  app.onError(({ code, error }) => {
    logger.error("tool-server error", { code }, error);
  });

  app.get("/health", async () => ({ ok: true as const }));

  app.get(
    "/list",
    async () => {
      const toolDescs = await Promise.allSettled(tools.map((t) => t.list()));
      const succeeded = toolDescs.filter((t) => t.status === "fulfilled").map((t) => t.value);

      return {
        tools: succeeded.flatMap((s) =>
          s.map((t) => ({
            callableId: t.callableId,
            name: t.name,
            description: t.description,
            shortInput: t.shortInput,
            hidden: t.hidden,
          })),
        ),
      };
    },
    {
      response: BridgeListResponse,
    },
  );

  app.post("/reload", async () => {
    await Promise.allSettled(tools.map((t) => t.destroy()));
    await Promise.allSettled(tools.map((t) => t.init()));
    await refreshToolMapping();
    return { ok: true as const };
  });

  app.get("/help/:callableId", async ({ params }) => {
    const tool = callMapping.get(params.callableId);
    if (!tool) {
      throw new NotFoundError(`Unknown callable ID '${params.callableId}'`);
    }
    const desc = await tool.list();
    const output = desc.find((d) => d.callableId === params.callableId);
    if (!output) return new NotFoundError();
    return output;
  });

  app.post(
    "/call",
    async ({ body, request, headers }) => {
      const startedAt = Date.now();

      const tool = callMapping.get(body.callableId);
      if (!tool) {
        throw new NotFoundError(`Unknown callable ID '${body.callableId}'`);
      }

      const ctx = parseRequestContext(headers);

      logger.info("tool call", {
        callableId: body.callableId,
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
        requestClient: ctx.requestClient,
        cwd: ctx.cwd,
      });

      logger.debug("tool call input", {
        callableId: body.callableId,
        input: safeJsonPreview(body.input),
      });

      try {
        const messages = ctx.requestId
          ? options.requestMessageCache?.get(ctx.requestId)
          : undefined;

        const output = await tool.call(body.callableId, body.input, {
          signal: request.signal,
          context: ctx,
          messages,
        });

        logger.info("tool call done", {
          callableId: body.callableId,
          requestId: ctx.requestId,
          durationMs: Date.now() - startedAt,
          ok: true,
        });
        return { isError: false, output };
      } catch (e) {
        logger.error(
          "tool call failed",
          {
            callableId: body.callableId,
            requestId: ctx.requestId,
            durationMs: Date.now() - startedAt,
          },
          e,
        );

        return {
          isError: true,
          output: e instanceof Error ? e.message : String(e),
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
      const initResult = await Promise.allSettled(tools.map((t) => t.init()));
      for (const result of initResult) {
        if (result.status === "rejected") {
          logger.error("tool init failed", result.reason);
        }
      }
      await refreshToolMapping();
    },
    start: async (port: number) => {
      if (started) return;
      started = true;

      // Elysia listen is sync-ish, but server becomes available shortly after.
      app.listen(port);
      logger.info(`Tool server listening on port ${app.server?.hostname}:${app.server?.port}`);
    },
    stop: async () => {
      await Promise.allSettled(tools.map((t) => t.destroy()));
      app.stop();
      started = false;
    },
  };
}
