import { realpath, stat } from "node:fs/promises";

import {
  MINI_LILAC_REASONING_LEVELS,
  miniLilacCancelRequestSchema,
  miniLilacCompactRequestSchema,
  miniLilacInterruptQueuedSteeringRequestSchema,
  miniLilacMessagesSchema,
  miniLilacSteerRequestSchema,
  miniLilacUndoRequestSchema,
  miniLilacUpdateSessionBindingsRequestSchema,
  type MiniLilacModelSummary,
  type MiniLilacProfileSummary,
  type MiniLilacSessionSnapshot,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
} from "@stanley2058/mini-lilac-client";
import {
  type ModelCatalogSnapshot,
  type RuntimeConfig,
  type SessionService,
} from "@stanley2058/mini-lilac-runtime";
import { createUIMessageStreamResponse, safeValidateUIMessages } from "ai";
import Elysia from "elysia";
import { z } from "zod";

export const MINI_LILAC_API_PREFIX = "/api/mini-lilac";
const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

const identifierSchema = z.string().trim().min(1);
const sessionParamsSchema = z.object({ sessionId: identifierSchema }).strict();
const sessionsQuerySchema = z.object({ cwd: z.string().trim().min(1) }).strict();
const skillsQuerySchema = z
  .object({
    cwd: z.string().trim().min(1),
    profile: identifierSchema.optional(),
  })
  .strict();
const reconnectQuerySchema = z
  .object({
    after: z
      .string()
      .regex(/^\d+$/, "must be a nonnegative integer")
      .transform(Number)
      .pipe(z.number().int().nonnegative().finite())
      .optional(),
  })
  .strict();
const emptyBodySchema = z.union([z.undefined(), z.null(), z.object({}).strict()]);
const chatRequestSchema = z
  .object({
    id: identifierSchema,
    messages: z.array(z.unknown()),
    trigger: z.enum(["submit-message", "regenerate-message"]),
    messageId: identifierSchema.nullish(),
    clientCommandId: identifierSchema,
    cwd: z.string().min(1).optional(),
    model: identifierSchema.optional(),
    profile: identifierSchema.optional(),
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
  })
  .strict();

export type MiniLilacModelCatalog = {
  get(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<ModelCatalogSnapshot>;
};

export type CreateMiniLilacServerOptions = {
  config: RuntimeConfig;
  sessionService: SessionService;
  modelCatalog: MiniLilacModelCatalog;
  authToken?: string;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

function requireClientCommandId<T extends { clientCommandId?: string }>(
  request: T,
): asserts request is T & { clientCommandId: string } {
  if (request.clientCommandId === undefined) {
    throw new ApiError(400, "client_command_id_required", "clientCommandId is required");
  }
}

export function withSseKeepAlive(
  response: Response,
  intervalMs = SSE_KEEPALIVE_INTERVAL_MS,
): Response {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          close();
        }
      }, intervalMs);
      void (async () => {
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) {
              close();
              controller.close();
              return;
            }
            controller.enqueue(result.value);
          }
        } catch (error) {
          close();
          controller.error(error);
        }
      })();
    },
    async cancel(reason) {
      close();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function uiMessageStreamResponse(
  stream: Parameters<typeof createUIMessageStreamResponse>[0]["stream"],
): Response {
  return withSseKeepAlive(createUIMessageStreamResponse({ stream }));
}

function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
  }
  if (error instanceof z.ZodError) {
    return jsonResponse(
      {
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          issues: error.issues,
        },
      },
      400,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("was not found")) {
    return jsonResponse({ error: { code: "not_found", message } }, 404);
  }
  if (message.includes("already has an active run")) {
    return jsonResponse({ error: { code: "session_active", message } }, 409);
  }
  if (
    message.startsWith("Invalid model reference") ||
    message.startsWith("Provider '") ||
    message.startsWith("Unknown profile '") ||
    message.includes("is subagent-only")
  ) {
    return jsonResponse({ error: { code: "invalid_session_bindings", message } }, 400);
  }
  if (
    message.includes("has no active run") ||
    message.includes("is not active for session") ||
    message.includes("is not accepting") ||
    message.includes("is pending") ||
    message.includes("was already used") ||
    message.includes("must be quiescent to undo") ||
    message.includes("must be quiescent to compact") ||
    message.includes("must be quiescent to update bindings") ||
    message.includes("has no durable checkpoint") ||
    message.includes("has no exact UI prefix") ||
    message.includes("has an invalid checkpoint") ||
    message.includes("UNIQUE constraint failed")
  ) {
    return jsonResponse({ error: { code: "conflict", message } }, 409);
  }
  return jsonResponse(
    { error: { code: "internal_error", message: "The request could not be completed" } },
    500,
  );
}

async function safely(operation: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    return errorResponse(error);
  }
}

function modelSummaries(snapshot: ModelCatalogSnapshot): MiniLilacModelSummary[] {
  return snapshot.models.map((model) => ({
    id: model.ref.value,
    label: model.name ?? model.ref.value,
    provider: model.provider.id,
    supportsReasoning: model.reasoning === true,
    ...(model.reasoning === true ? { reasoningLevels: [...MINI_LILAC_REASONING_LEVELS] } : {}),
    ...(model.limits && model.limits.context > 0 ? { contextWindow: model.limits.context } : {}),
  }));
}

function profileSummaries(config: RuntimeConfig): MiniLilacProfileSummary[] {
  return Object.entries(config.agent.profiles).map(([id, profile]) => ({
    id,
    label: id,
    ...(profile.description ? { description: profile.description } : {}),
    ...(id === config.agent.defaultProfile ? { isDefault: true } : {}),
    subagentOnly: profile.subagentOnly,
  }));
}

function existingSession(
  sessionService: SessionService,
  sessionId: string,
): MiniLilacSessionSnapshot | undefined {
  return sessionService.store.listSessions().find((session) => session.id === sessionId);
}

async function validateSessionBinding(
  snapshot: MiniLilacSessionSnapshot,
  supplied: {
    cwd?: string;
    model?: string;
    profile?: string;
    reasoning?: string;
  },
): Promise<void> {
  if (supplied.cwd !== undefined) {
    let canonicalCwd: string;
    try {
      canonicalCwd = await realpath(supplied.cwd);
    } catch {
      throw new ApiError(400, "invalid_cwd", `Session cwd '${supplied.cwd}' does not exist`);
    }
    if (canonicalCwd !== snapshot.cwd) {
      throw new ApiError(409, "session_binding_mismatch", "cwd does not match the session");
    }
  }

  const immutable = ["model", "profile", "reasoning"] as const;
  for (const field of immutable) {
    const value = supplied[field];
    if (value !== undefined && value !== snapshot[field]) {
      throw new ApiError(409, "session_binding_mismatch", `${field} does not match the session`);
    }
  }
}

export function createMiniLilacServer(options: CreateMiniLilacServerOptions) {
  const { config, modelCatalog, sessionService } = options;
  if (config.server.authTokenEnv && options.authToken === undefined) {
    throw new Error(`An auth token is required by '${config.server.authTokenEnv}'`);
  }
  if (options.authToken !== undefined && !options.authToken.trim()) {
    throw new Error("The auth token cannot be blank");
  }
  const authToken = config.server.authTokenEnv ? options.authToken : undefined;

  const sessionLocks = new Map<string, Promise<void>>();
  async function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessionLocks.set(sessionId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId);
    }
  }

  const app = new Elysia();

  app.onBeforeHandle(({ request }) => {
    const pathname = new URL(request.url).pathname;
    if (
      authToken !== undefined &&
      pathname.startsWith(`${MINI_LILAC_API_PREFIX}/`) &&
      pathname !== `${MINI_LILAC_API_PREFIX}/healthz` &&
      request.headers.get("authorization") !== `Bearer ${authToken}`
    ) {
      return jsonResponse(
        { error: { code: "unauthorized", message: "A valid bearer token is required" } },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
  });

  app.onError(({ code }) => {
    if (code === "PARSE") {
      return jsonResponse(
        { error: { code: "invalid_json", message: "Request body must be valid JSON" } },
        400,
      );
    }
    return jsonResponse(
      { error: { code: "internal_error", message: "The request could not be completed" } },
      500,
    );
  });

  app.get(`${MINI_LILAC_API_PREFIX}/healthz`, () => ({ ok: true }));

  app.post(`${MINI_LILAC_API_PREFIX}/chat`, ({ body }) =>
    safely(async () => {
      const request = chatRequestSchema.parse(body);
      if (request.trigger !== "submit-message") {
        throw new ApiError(400, "regenerate_unsupported", "Regenerate requests are not supported");
      }
      const strictMessages = miniLilacMessagesSchema.safeParse(request.messages);
      if (!strictMessages.success) {
        throw new ApiError(
          400,
          "invalid_ui_messages",
          `UI message validation failed: ${z.prettifyError(strictMessages.error)}`,
        );
      }
      const validatedMessages = await safeValidateUIMessages<MiniLilacUIMessage>({
        messages: strictMessages.data,
      });
      if (!validatedMessages.success) {
        throw new ApiError(
          400,
          "invalid_ui_messages",
          `UI message validation failed: ${validatedMessages.error.message}`,
        );
      }
      const userMessage = validatedMessages.data.findLast((message) => message.role === "user");
      if (!userMessage) {
        throw new ApiError(400, "user_message_required", "A user UI message is required");
      }

      return withSessionLock(request.id, async () => {
        let snapshot = existingSession(sessionService, request.id);
        if (!snapshot) {
          if (request.cwd === undefined || request.model === undefined) {
            throw new ApiError(
              400,
              "session_configuration_required",
              "New sessions require cwd and model",
            );
          }
          try {
            snapshot = await sessionService.createSession({
              id: request.id,
              cwd: request.cwd,
              model: request.model,
              profile: request.profile,
              reasoning: request.reasoning,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new ApiError(400, "invalid_session_configuration", message);
          }
        } else {
          await validateSessionBinding(snapshot, request);
        }

        const commandId = request.clientCommandId ?? crypto.randomUUID();
        const started = await sessionService.startPrompt(snapshot.id, userMessage, commandId);
        return uiMessageStreamResponse(started.stream);
      });
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/chat/:sessionId/stream`, ({ params, query }) =>
    safely(() => {
      const { sessionId } = sessionParamsSchema.parse(params);
      const { after } = reconnectQuerySchema.parse(query);
      const snapshot = existingSession(sessionService, sessionId);
      if (!snapshot) throw new ApiError(404, "not_found", `Session '${sessionId}' was not found`);
      const run = sessionService.store.getLatestRun(sessionId);
      if (!run) return new Response(null, { status: 204 });
      if (run.status === "active") {
        return uiMessageStreamResponse(sessionService.replayRun(run.id, { afterSeq: after }));
      }
      return new Response(null, { status: 204 });
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId`, ({ params }) =>
    safely(() => {
      const { sessionId } = sessionParamsSchema.parse(params);
      return jsonResponse(sessionService.getSnapshot(sessionId));
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions`, ({ query }) =>
    safely(async () => {
      const { cwd } = sessionsQuerySchema.parse(query);
      let canonicalCwd: string;
      try {
        canonicalCwd = await realpath(cwd);
      } catch {
        throw new ApiError(400, "invalid_cwd", `Session cwd '${cwd}' does not exist`);
      }
      const sessions = sessionService.store
        .listSessions()
        .filter((session) => session.cwd === canonicalCwd && !session.id.startsWith("sub:"))
        .toSorted((left, right) => {
          const timestamp = (right.updatedAt ?? right.createdAt ?? "").localeCompare(
            left.updatedAt ?? left.createdAt ?? "",
          );
          return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
        });
      return jsonResponse(sessions);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/messages`, ({ params }) =>
    safely(() => {
      const { sessionId } = sessionParamsSchema.parse(params);
      return jsonResponse(sessionService.getMessages(sessionId));
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/todos`, ({ params }) =>
    safely(() => {
      const { sessionId } = sessionParamsSchema.parse(params);
      const todos: MiniLilacTodoState = sessionService.getTodos(sessionId);
      return jsonResponse(todos);
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/skills`, ({ query }) =>
    safely(async () => {
      const { cwd, profile } = skillsQuerySchema.parse(query);
      let canonicalCwd: string;
      try {
        canonicalCwd = await realpath(cwd);
      } catch {
        throw new ApiError(400, "invalid_cwd", `Skill cwd '${cwd}' does not exist`);
      }
      if (!(await stat(canonicalCwd)).isDirectory()) {
        throw new ApiError(400, "invalid_cwd", `Skill cwd '${cwd}' is not a directory`);
      }
      return jsonResponse(await sessionService.listSkills(cwd, profile));
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/bindings`, ({ body, params }) =>
    safely(async () => {
      const { sessionId } = sessionParamsSchema.parse(params);
      const request = miniLilacUpdateSessionBindingsRequestSchema.parse(body);
      if (request.sessionId !== sessionId) {
        throw new ApiError(409, "session_id_mismatch", "Body sessionId does not match the path");
      }
      return withSessionLock(sessionId, async () =>
        jsonResponse(await sessionService.updateSessionBindings(request)),
      );
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/steer`, ({ body, params }) =>
    safely(async () => {
      const { sessionId } = sessionParamsSchema.parse(params);
      const request = miniLilacSteerRequestSchema.parse(body);
      requireClientCommandId(request);
      if (request.sessionId !== sessionId) {
        throw new ApiError(409, "session_id_mismatch", "Body sessionId does not match the path");
      }
      return jsonResponse(await sessionService.steer(request));
    }),
  );

  app.post(
    `${MINI_LILAC_API_PREFIX}/sessions/:sessionId/interrupt-queued-steering`,
    ({ body, params }) =>
      safely(async () => {
        const { sessionId } = sessionParamsSchema.parse(params);
        const request = miniLilacInterruptQueuedSteeringRequestSchema.parse(body);
        requireClientCommandId(request);
        if (request.sessionId !== sessionId) {
          throw new ApiError(409, "session_id_mismatch", "Body sessionId does not match the path");
        }
        return jsonResponse(await sessionService.interruptQueuedSteering(request));
      }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/cancel`, ({ body, params }) =>
    safely(async () => {
      const { sessionId } = sessionParamsSchema.parse(params);
      const request = miniLilacCancelRequestSchema.parse(body);
      requireClientCommandId(request);
      if (request.sessionId !== sessionId) {
        throw new ApiError(409, "session_id_mismatch", "Body sessionId does not match the path");
      }
      return jsonResponse(await sessionService.cancel(request));
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/undo`, ({ body, params }) =>
    safely(async () => {
      const { sessionId } = sessionParamsSchema.parse(params);
      const request = miniLilacUndoRequestSchema.parse(body);
      if (request.sessionId !== sessionId) {
        throw new ApiError(409, "session_id_mismatch", "Body sessionId does not match the path");
      }
      return withSessionLock(sessionId, async () =>
        jsonResponse(await sessionService.undo(request)),
      );
    }),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/sessions/:sessionId/compact`, ({ body, params }) =>
    safely(async () => {
      const { sessionId } = sessionParamsSchema.parse(params);
      const request = miniLilacCompactRequestSchema.parse(body);
      if (request.sessionId !== sessionId) {
        throw new ApiError(409, "session_id_mismatch", "Body sessionId does not match the path");
      }
      return withSessionLock(sessionId, async () =>
        jsonResponse(await sessionService.compact(request)),
      );
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/models`, () =>
    safely(async () => jsonResponse(modelSummaries(await modelCatalog.get()))),
  );

  app.post(`${MINI_LILAC_API_PREFIX}/models/refresh`, ({ body }) =>
    safely(async () => {
      emptyBodySchema.parse(body);
      return jsonResponse(modelSummaries(await modelCatalog.get({ forceRefresh: true })));
    }),
  );

  app.get(`${MINI_LILAC_API_PREFIX}/profiles`, () => jsonResponse(profileSummaries(config)));

  return app;
}
