import { captureError } from "../../shared/error-capture";
import { z } from "zod";
import fs from "node:fs/promises";
import { basename } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { errorMessage, getDiscordUserAliasValue, type CoreConfig } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";

import { defineServerTool, type ServerTool, type ServerToolCallOptions } from "../types";

import { isAdapterPlatform } from "../../shared/is-adapter-platform";
import { hasCacheBurstProvider, type SurfaceOperationError } from "../../surface/adapter";
import type {
  ResolvedSurfaceAdapter,
  SurfaceAdapterResolver,
} from "../../surface/runtime-descriptor";
import { SurfaceToolTargetInvalid } from "../../surface/protocol";
import type {
  MsgRef,
  RegisteredSurfacePlatform,
  SessionRef,
  SessionRefFor,
  SurfaceAttachment,
  SurfaceMessage,
  SurfaceReactionSummary,
} from "../../surface/types";
import {
  getBuiltinSurfaceProtocol,
  inferBuiltinSurfaceToolRequestTarget,
} from "../../surface/builtin-surface-protocols";
import type { DiscordSearchService } from "../../surface/store/discord-search-store";
import type { RequestContext } from "../types";
import type { RecentAgentWriteSnapshot, TranscriptStore } from "../../transcript/transcript-store";
import { isHeartbeatSessionId } from "../../transcript/heartbeat-handoff";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

import {
  bestEffortAliasForDiscordChannelId,
  resolveGuildIdForChannel,
  shouldAllowDiscordChannel as checkDiscordChannelAllowed,
} from "../../surface/discord/discord-tool-targets";
import {
  formatToolPathForRequestContext,
  inferMimeTypeFromFilename,
  resolveToolPathForRequestContextResult,
} from "../../shared/attachment-utils";
import type { DiscordAttachmentMeta } from "../../surface/discord/discord-attachment";
import {
  projectDiscordMessage,
  getDiscordMessageKind,
} from "../../surface/discord/discord-message-projection";
import {
  resolveDiscordReferencedMessage,
  resolveDiscordReferencedMessages,
  surfaceMessageKey,
} from "../../surface/discord/discord-reference-enrichment";

function surfaceFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `surface_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

const surfaceFailureSchema: z.ZodType<ServerToolFailure> = z
  .object({
    kind: z.enum([
      "usage",
      "denied",
      "not_found",
      "conflict",
      "unavailable",
      "timeout",
      "cancelled",
      "internal",
    ]),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.json().optional(),
  })
  .strict();

type SurfaceCapturedFailure = {
  readonly cause: Error | Panic;
  readonly code?: string;
};

function captureSurfaceFailure(cause: unknown): SurfaceCapturedFailure {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  if (Panic.is(cause)) return { cause, code };
  if (cause instanceof Error) return { cause, code };
  const message =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : "Surface operation failed";
  return { cause: new Error(message, { cause }), code };
}

function surfaceExternalFailure(
  failure: SurfaceCapturedFailure,
  signal?: AbortSignal,
): ServerToolFailure {
  const { cause, code } = failure;
  if (Panic.is(cause)) preserveToolPanic(cause);
  const decodedFailure = surfaceFailureSchema.safeParse(cause);
  if (decodedFailure.success) return decodedFailure.data;
  const message = errorMessage(cause);
  const normalized = message.toLowerCase();
  let category: ServerToolFailure["kind"] = "unavailable";
  switch (true) {
    case signal?.aborted || /\babort(?:ed)?\b/.test(normalized):
      category = "cancelled";
      break;
    case /\b(?:timeout|timed out)\b/.test(normalized):
      category = "timeout";
      break;
    case code === "ENOENT":
      category = "not_found";
      break;
    case code === "EACCES" || code === "EPERM":
      category = "denied";
      break;
  }
  return surfaceFailure(category, message);
}

function surfaceTargetResult<T>(
  result: ResultType<T, { readonly message: string }>,
): ResultType<T, ServerToolFailure> {
  return result.mapError((error) => surfaceFailure("usage", error.message));
}

function surfaceOperationResult<T>(
  result: ResultType<T, SurfaceOperationError>,
): ResultType<T, ServerToolFailure> {
  return result.mapError((error) => {
    switch (error._tag) {
      case "SurfaceOperationUnsupported":
        return serverToolFailure({
          kind: "usage",
          code: "surface_operation_unsupported",
          message: error.message,
          retryable: false,
        });
      case "SurfaceRateLimited":
        return serverToolFailure({
          kind: "unavailable",
          code: "surface_rate_limited",
          message: error.message,
          retryable: true,
          ...(error.retryAfterMs === undefined
            ? {}
            : { details: { retryAfterMs: error.retryAfterMs } }),
        });
      case "SurfaceUnavailable":
        return surfaceFailure("unavailable", error.message);
      case "SurfacePlatformMismatch":
      case "SurfaceSessionMismatch":
        return surfaceFailure("conflict", error.message);
      case "SurfaceOperationPartiallyCompleted":
        return serverToolFailure({
          kind: "conflict",
          code: "surface_operation_partially_completed",
          message: error.message,
          retryable: false,
          details: {
            created: {
              platform: error.created.platform,
              channelId: error.created.channelId,
              messageId: error.created.messageId,
            },
          },
        });
      case "SurfaceInvalidInput":
        return surfaceFailure("usage", error.message);
      case "SurfaceMessageNotFound":
        return surfaceFailure("not_found", error.message);
      case "SurfacePermissionDenied":
        return surfaceFailure("denied", error.message);
    }
  });
}

function createSurfaceMessageRef<P extends RegisteredSurfacePlatform>(
  sessionRef: SessionRefFor<P>,
  messageId: string,
) {
  const protocol = getBuiltinSurfaceProtocol(sessionRef.platform);
  return protocol.refs.createMessageRef(sessionRef, messageId);
}

const surfaceClientSchema = z
  .enum(["discord", "github", "whatsapp", "slack", "telegram", "web"])
  .describe(
    "Recognized surface wire client/platform. Execution requires a registered adapter and is selected from request context unless --client is needed.",
  );

type SurfaceClient = z.infer<typeof surfaceClientSchema>;

function formatRegisteredPlatforms(resolver: SurfaceAdapterResolver): string {
  return resolver
    .registeredPlatforms()
    .map((platform) => `'${platform}'`)
    .join(", ");
}

function resolveSurfaceAdapter(params: {
  inputClient?: SurfaceClient;
  ctx?: RequestContext;
  resolver: SurfaceAdapterResolver;
}): ResultType<ResolvedSurfaceAdapter, ServerToolFailure> {
  const ctxClientRaw = params.ctx?.requestClient;
  const ctxClient = isAdapterPlatform(ctxClientRaw) ? ctxClientRaw : null;
  const contextAdapter = ctxClient ? params.resolver.resolve(ctxClient) : null;

  if (contextAdapter) {
    if (params.inputClient && params.inputClient !== contextAdapter.platform) {
      return Result.err(
        surfaceFailure(
          "conflict",
          `Client mismatch: context requestClient is '${contextAdapter.platform}' but input client is '${params.inputClient}'`,
        ),
      );
    }
    return Result.ok(contextAdapter);
  }

  if (params.inputClient) {
    const inputAdapter = params.resolver.resolve(params.inputClient);
    if (inputAdapter) return Result.ok(inputAdapter);
    return Result.err(
      surfaceFailure(
        "unavailable",
        `surface tool: client '${params.inputClient}' is recognized but has no registered executable adapter (registered: ${formatRegisteredPlatforms(params.resolver)})`,
      ),
    );
  }

  if (ctxClient && ctxClient !== "unknown") {
    return Result.err(
      surfaceFailure(
        "unavailable",
        `surface tool: context client '${ctxClient}' is recognized but has no registered executable adapter (registered: ${formatRegisteredPlatforms(params.resolver)})`,
      ),
    );
  }

  if (typeof ctxClientRaw === "string" && ctxClientRaw.length > 0 && !ctxClient) {
    return Result.err(
      surfaceFailure(
        "usage",
        `surface tool: context requestClient '${ctxClientRaw}' is not a valid surface wire value; pass --client=<client> explicitly`,
      ),
    );
  }

  return Result.err(
    surfaceFailure(
      "usage",
      "surface tool requires --client when request client is unknown (set LILAC_REQUEST_CLIENT or pass --client=<client>)",
    ),
  );
}

function shouldAllowDiscordChannel(params: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): ResultType<boolean, ServerToolFailure> {
  return checkDiscordChannelAllowed(params).mapError((error) =>
    surfaceFailure("unavailable", error.message),
  );
}

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export async function loadLocalAttachments(params: {
  cwd: string;
  paths: string[];
  filenames?: string[];
  mimeTypes?: string[];
  context?: RequestContext | undefined;
}): Promise<ResultType<SurfaceAttachment[], ServerToolFailure>> {
  return Result.gen(async function* () {
    let totalBytes = 0;
    const out: SurfaceAttachment[] = [];

    for (let i = 0; i < params.paths.length; i++) {
      const inputPath = params.paths[i]!;
      const resolvedPath = yield* resolveToolPathForRequestContextResult({
        cwd: params.cwd,
        inputPath,
        context: params.context,
      }).mapError((error) => surfaceFailure("denied", error.message));
      const st = yield* Result.await(
        Result.tryPromise({
          try: () => fs.stat(resolvedPath),
          catch: captureSurfaceFailure,
        }).then((result) => result.mapError((failure) => surfaceExternalFailure(failure))),
      );
      if (!st.isFile()) {
        return Result.err(
          surfaceFailure(
            "usage",
            `Not a file: ${formatToolPathForRequestContext({
              path: resolvedPath,
              context: params.context,
            })}`,
          ),
        );
      }
      if (st.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
        return Result.err(
          surfaceFailure(
            "usage",
            `Attachment too large (${st.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${formatToolPathForRequestContext(
              { path: resolvedPath, context: params.context },
            )}`,
          ),
        );
      }
      totalBytes += st.size;
      if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
        return Result.err(
          surfaceFailure(
            "usage",
            `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
          ),
        );
      }
      const bytes = yield* Result.await(
        Result.tryPromise({
          try: () => fs.readFile(resolvedPath),
          catch: captureSurfaceFailure,
        }).then((result) => result.mapError((failure) => surfaceExternalFailure(failure))),
      );
      const filename = (params.filenames && params.filenames[i]) ?? basename(resolvedPath);
      const typeFromBytes = yield* Result.await(
        Result.tryPromise({
          try: () => fileTypeFromBuffer(bytes),
          catch: captureSurfaceFailure,
        }).then((result) => result.mapError((failure) => surfaceExternalFailure(failure))),
      );
      const mimeType =
        (params.mimeTypes && params.mimeTypes[i]) ??
        typeFromBytes?.mime ??
        inferMimeTypeFromFilename(filename);
      out.push({
        kind: mimeType.startsWith("image/") ? "image" : "file",
        mimeType,
        filename,
        bytes: new Uint8Array(bytes),
      });
    }

    return Result.ok(out);
  });
}

function buildDiscordUserAliasById(cfg: CoreConfig): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    const resolved = getDiscordUserAliasValue(rec);
    if (!resolved) continue;
    const userId = resolved.discordId;
    if (!out.has(userId)) {
      out.set(userId, alias);
    }
  }

  return out;
}

const baseInputSchema = z
  .object({
    client: surfaceClientSchema.optional(),
  })
  .strict();

const helpInputSchema = baseInputSchema;

const sessionsListLimitSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;

    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      ctx.addIssue({
        code: "custom",
        message: "Expected an integer from 1 to 1000.",
      });
      return z.NEVER;
    }

    return parsed;
  })
  .describe("Max sessions to return (default: all).");

function withDefaultSessionId<TInput extends { readonly sessionId?: string }>(
  input: TInput,
  ctx: RequestContext | undefined,
): ResultType<TInput, ServerToolFailure> {
  if (input.sessionId !== undefined) return Result.ok(input);

  const ctxSessionId =
    typeof ctx?.sessionId === "string" && ctx.sessionId.length > 0
      ? ctx.sessionId
      : inferBuiltinSurfaceToolRequestTarget(ctx?.requestId)?.sessionId;

  if (ctxSessionId) {
    return Result.ok({ ...input, sessionId: ctxSessionId });
  }

  return Result.err(
    surfaceFailure(
      "usage",
      "surface tool requires --session-id when request session is unknown (set LILAC_SESSION_ID or pass --session-id=<id>)",
    ),
  );
}

function withDefaultMessageId<TInput extends { readonly messageId?: string }>(
  input: TInput,
  ctx: RequestContext | undefined,
): ResultType<TInput, ServerToolFailure> {
  if (input.messageId !== undefined) return Result.ok(input);

  const inferred = inferBuiltinSurfaceToolRequestTarget(ctx?.requestId);
  if (inferred?.messageId) return Result.ok({ ...input, messageId: inferred.messageId });

  const rid = typeof ctx?.requestId === "string" ? ctx.requestId : undefined;
  const hint = rid ? ` (requestId='${rid}')` : " (no requestId in context)";

  return Result.err(
    surfaceFailure(
      "usage",
      `surface tool requires --message-id when origin message is unknown${hint}. ` +
        "This is expected for active-mode gated batches (requestId like 'req:<uuid>'); pass --message-id explicitly.",
    ),
  );
}

function mustPresentString(v: unknown, label: string): ResultType<string, ServerToolFailure> {
  if (typeof v === "string" && v.length > 0) return Result.ok(v);
  return Result.err(surfaceFailure("internal", `surface tool internal error: missing ${label}`));
}

type SurfaceMessageAttachmentKind = "image" | "video" | "audio" | "file";

type SurfaceMessageAttachmentMeta = {
  url: string;
  kind: SurfaceMessageAttachmentKind;
  filename?: string;
  mimeType?: string;
  size?: number;
};

type SurfaceMessageAttachmentHints = {
  hasAttachments: boolean;
  attachmentCount: number;
  hasMedia: boolean;
  mediaCount: number;
  mediaKinds: SurfaceMessageAttachmentKind[];
};

function normalizeMimeTypeForAttachment(mimeType: string): string | undefined {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function inferAttachmentMimeType(params: {
  mimeType?: string;
  filename?: string;
  url: string;
}): string | undefined {
  if (params.mimeType) {
    const normalized = normalizeMimeTypeForAttachment(params.mimeType);
    if (normalized) return normalized;
  }

  if (params.filename) {
    const inferred = inferMimeTypeFromFilename(params.filename);
    if (inferred !== "application/octet-stream") return inferred;
  }

  const basenameFromUrl = URL.canParse(params.url)
    ? (() => {
        const pathBasename = basename(new URL(params.url).pathname);
        return pathBasename.length > 0 ? pathBasename : undefined;
      })()
    : undefined;

  if (basenameFromUrl) {
    const inferred = inferMimeTypeFromFilename(basenameFromUrl);
    if (inferred !== "application/octet-stream") return inferred;
  }

  return undefined;
}

function attachmentKindFromMimeType(mimeType: string | undefined): SurfaceMessageAttachmentKind {
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function toAttachmentMeta(attachment: DiscordAttachmentMeta): SurfaceMessageAttachmentMeta {
  const mimeType = inferAttachmentMimeType(attachment);
  return {
    url: attachment.url,
    kind: attachmentKindFromMimeType(mimeType),
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
  };
}

function getMessageAttachmentMeta(msg: SurfaceMessage): SurfaceMessageAttachmentMeta[] {
  return msg.session.platform === "discord"
    ? projectDiscordMessage(msg).attachments.map(toAttachmentMeta)
    : [];
}

function buildAttachmentHints(
  attachments: readonly SurfaceMessageAttachmentMeta[],
): SurfaceMessageAttachmentHints {
  const mediaFiles = attachments.filter((a) => a.kind !== "file");
  return {
    hasAttachments: attachments.length > 0,
    attachmentCount: attachments.length,
    hasMedia: mediaFiles.length > 0,
    mediaCount: mediaFiles.length,
    mediaKinds: Array.from(new Set(mediaFiles.map((a) => a.kind))),
  };
}

const MESSAGE_LIST_ORDER_SCHEMA = z.enum(["ts_asc", "ts_desc"]);
type MessageListOrder = z.infer<typeof MESSAGE_LIST_ORDER_SCHEMA>;

const MESSAGE_SEARCH_ORDER_SCHEMA = z.enum(["relevance", "ts_asc", "ts_desc"]);
type MessageSearchOrder = z.infer<typeof MESSAGE_SEARCH_ORDER_SCHEMA>;

function compareMessageIdLike(a: string, b: string): number {
  if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  }
  return a.localeCompare(b);
}

function compareSurfaceMessageChronological(a: SurfaceMessage, b: SurfaceMessage): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return compareMessageIdLike(a.ref.messageId, b.ref.messageId);
}

function sortSurfaceMessages(
  messages: readonly SurfaceMessage[],
  order: MessageListOrder,
): SurfaceMessage[] {
  const sorted = [...messages].sort(compareSurfaceMessageChronological);
  if (order === "ts_desc") sorted.reverse();
  return sorted;
}

type SessionMeta = {
  platform: string;
  channelId: string;
  alias?: string;
  guildId?: string;
  parentChannelId?: string;
};

function toSessionMeta(session: SessionRef, cfg?: CoreConfig): SessionMeta {
  const alias =
    cfg && session.platform === "discord"
      ? bestEffortAliasForDiscordChannelId({
          channelId: session.channelId,
          cfg,
        })
      : undefined;

  if (session.platform === "discord") {
    return {
      platform: session.platform,
      channelId: session.channelId,
      alias,
      guildId: session.guildId,
      parentChannelId: session.parentChannelId,
    };
  }
  return {
    platform: session.platform,
    channelId: session.channelId,
    alias,
  };
}

function toPreviewText(text: string, maxChars = 128): { preview: string; truncated: boolean } {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return {
      preview: compact,
      truncated: false,
    };
  }

  return {
    preview: compact.slice(0, maxChars),
    truncated: true,
  };
}

function toCompactMessage(
  msg: SurfaceMessage,
  opts: { includeRaw: boolean; includeAttachments: boolean; referenced?: SurfaceMessage },
): Record<string, unknown> {
  const discord = msg.session.platform === "discord" ? projectDiscordMessage(msg) : undefined;
  const out: Record<string, unknown> = {
    messageId: msg.ref.messageId,
    userId: msg.userId,
    userName: msg.userName,
    richText: discord?.displayText ?? msg.text,
    ts: msg.ts,
  };

  if (typeof msg.editedTs === "number") out["editedTs"] = msg.editedTs;
  if (typeof msg.deleted === "boolean") out["deleted"] = msg.deleted;

  if (msg.session.platform === "discord") {
    const meta = discord?.typeMeta;
    if (meta) {
      if (typeof meta.typeName === "string") out["platformMessageType"] = meta.typeName;
      else if (typeof meta.typeId === "number") out["platformMessageType"] = String(meta.typeId);
      out["platformMessageKind"] = getDiscordMessageKind(meta);
      if (opts.includeRaw) {
        if (typeof meta.typeId === "number") out["platformMessageTypeId"] = meta.typeId;
        if (typeof meta.isSystem === "boolean") out["platformIsSystem"] = meta.isSystem;
        if (typeof meta.isChat === "boolean") out["platformIsChat"] = meta.isChat;
      }
    }
  }

  const attachments = discord?.attachments.map(toAttachmentMeta) ?? [];
  const mediaFiles = attachments.filter((a) => a.kind !== "file");
  const hints = buildAttachmentHints(attachments);

  out["attachmentCount"] = hints.attachmentCount;
  out["mediaCount"] = hints.mediaCount;
  out["mediaKinds"] = hints.mediaKinds;

  if (opts.includeRaw) {
    out["hasAttachments"] = hints.hasAttachments;
    out["hasMedia"] = hints.hasMedia;
  }

  if (opts.includeAttachments) {
    out["attachments"] = attachments;
    out["mediaFiles"] = mediaFiles;
  }

  if (opts.includeRaw && msg.raw !== undefined) {
    out["raw"] = msg.raw;
  }

  if (opts.referenced) {
    out["referenced"] = toCompactMessage(opts.referenced, {
      includeRaw: opts.includeRaw,
      includeAttachments: opts.includeAttachments,
    });
  }

  return out;
}

function buildMessagesListOutput(params: {
  session: SessionRef;
  cfg?: CoreConfig;
  messages: readonly SurfaceMessage[];
  order: MessageListOrder;
  includeRaw: boolean;
  includeAttachments: boolean;
  referencedByMessageKey?: Map<string, SurfaceMessage>;
}): {
  meta: {
    session: SessionMeta;
    order: MessageListOrder;
    count: number;
  };
  messages: Record<string, unknown>[];
} {
  const sorted = sortSurfaceMessages(params.messages, params.order);
  const session = sorted[0]?.session ?? params.session;

  return {
    meta: {
      session: toSessionMeta(session, params.cfg),
      order: params.order,
      count: sorted.length,
    },
    messages: sorted.map((msg) =>
      toCompactMessage(msg, {
        includeRaw: params.includeRaw,
        includeAttachments: params.includeAttachments,
        referenced: params.referencedByMessageKey?.get(surfaceMessageKey(msg)),
      }),
    ),
  };
}

function buildMessagesReadOutput(params: {
  session: SessionRef;
  cfg?: CoreConfig;
  message: SurfaceMessage | null;
  referenced?: SurfaceMessage | null;
  includeRaw: boolean;
}): {
  meta: {
    session: SessionMeta;
  };
  message: Record<string, unknown> | null;
} {
  const session = params.message?.session ?? params.session;
  return {
    meta: {
      session: toSessionMeta(session, params.cfg),
    },
    message: params.message
      ? toCompactMessage(params.message, {
          includeRaw: params.includeRaw,
          includeAttachments: true,
          referenced: params.referenced ?? undefined,
        })
      : null,
  };
}

const sessionsListInputSchema = baseInputSchema
  .extend({
    limit: sessionsListLimitSchema,
  })
  .strict();

const activitiesRecentAgentWritesInputSchema = baseInputSchema.extend({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max recent writes to return (default: 20)."),
});

const sessionsListParticipantsInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe("Max participants (default: 200)."),
});

const messagesListInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max messages (default: 50)"),
  beforeMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional message id cursor (list messages before this id)"),
  afterMessageId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional message id cursor (list messages after this id)"),
  order: MESSAGE_LIST_ORDER_SCHEMA.optional().describe(
    "Optional sort order for returned messages (default: ts_desc).",
  ),
  includeRaw: z.coerce
    .boolean()
    .optional()
    .describe("Include raw platform payloads (default: false)."),
  includeAttachments: z.coerce
    .boolean()
    .optional()
    .describe(
      "Include full attachment/media metadata arrays (default: false; list always includes attachment/media hints).",
    ),
});

const messagesReadInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
  includeRaw: z.coerce
    .boolean()
    .optional()
    .describe("Include raw platform payloads (default: false)."),
});

const messagesSearchInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  query: z.string().min(1).describe("Search query (full-text, session-scoped)."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Max matches (default: 20, max: 100)"),
  order: MESSAGE_SEARCH_ORDER_SCHEMA.optional().describe(
    "Sort order for hits (default: relevance).",
  ),
});

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

const messagesSendInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  text: z.string().min(1),
  replyToMessageId: z.string().min(1).optional(),
  silent: z.coerce
    .boolean()
    .optional()
    .describe("Disable all notifications for this message (mentions + reply ping)."),
  paths: optionalNonEmptyStringListInputSchema.describe(
    "Local file paths to attach (resolved relative to request cwd)",
  ),
  filenames: optionalNonEmptyStringListInputSchema.describe(
    "Optional filenames for each attachment",
  ),
  mimeTypes: optionalNonEmptyStringListInputSchema.describe(
    "Optional mime types for each attachment",
  ),
});

const messagesEditInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z.string().min(1),
  text: z.string().min(1),
});

const messagesDeleteInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z.string().min(1),
});

const reactionsListInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
});

const reactionsListDetailedInputSchema = reactionsListInputSchema;

const reactionsAddInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
  reaction: z.string().min(1).describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
});

const reactionsRemoveInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  messageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
  reaction: z.string().min(1).describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
});

export class Surface implements ServerTool {
  id = "surface";
  private readonly tool: ServerTool;

  constructor(
    private readonly params: {
      adapterResolver: SurfaceAdapterResolver;
      config?: CoreConfig;
      getConfig?: () => Promise<CoreConfig>;
      discordSearch?: DiscordSearchService;
      transcriptStore?: TranscriptStore;
    },
  ) {
    this.tool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "surface.help": callable({
          name: "Surface Help",
          description:
            "Explain surface terminology (client/platform/sessionId/messageId) and common sessionId formats.",
          inputSchema: helpInputSchema,
          validation: "zod",
          run: (input, opts) => this.callHelp(input, opts?.context),
        }),
        "surface.activities.recentAgentWrites": callable({
          name: "Surface Activities Recent Agent Writes",
          description:
            "List recent visible writes produced by the agent, with session ids, message ids, and thin previews.",
          inputSchema: activitiesRecentAgentWritesInputSchema,
          validation: "zod",
          run: (input) => this.callActivitiesRecentAgentWrites(input),
        }),
        "surface.sessions.list": callable({
          name: "Surface Sessions List",
          description:
            "List sessions through the selected registered adapter. The adapter may return an explicit unsupported result.",
          inputSchema: sessionsListInputSchema,
          validation: "zod",
          run: (input, opts) => this.callSessionsList(input, opts?.context),
        }),
        "surface.sessions.listParticipants": callable({
          name: "Surface Sessions List Participants",
          description:
            "List current participants through the selected registered adapter. Discord uses thread members or guild members; other adapters may return unsupported.",
          inputSchema: sessionsListParticipantsInputSchema,
          validation: "zod",
          run: (input, opts) => this.callSessionsListParticipants(input, opts?.context),
        }),
        "surface.messages.list": callable({
          name: "Surface Messages List",
          description: "List messages for a session.",
          inputSchema: messagesListInputSchema,
          validation: "zod",
          run: (input, opts) => this.callMessagesList(input, opts?.context),
        }),
        "surface.messages.read": callable({
          name: "Surface Messages Read",
          description: "Read a message by id.",
          inputSchema: messagesReadInputSchema,
          validation: "zod",
          run: (input, opts) => this.callMessagesRead(input, opts?.context),
        }),
        "surface.messages.search": callable({
          name: "Surface Messages Search",
          description:
            "Deprecated: search indexed messages in a single Discord session. Prefer discovery.search for memory retrieval.",
          inputSchema: messagesSearchInputSchema,
          validation: "zod",
          primaryPositional: "query",
          hidden: true,
          run: (input, opts) => this.callMessagesSearch(input, opts?.context),
        }),
        "surface.messages.send": callable({
          name: "Surface Messages Send",
          description: "Send a message to a session.",
          inputSchema: messagesSendInputSchema,
          validation: "zod",
          primaryPositional: "text",
          run: (input, opts) => this.callMessagesSend(input, opts?.context),
        }),
        "surface.messages.edit": callable({
          name: "Surface Messages Edit",
          description: "Edit a message.",
          inputSchema: messagesEditInputSchema,
          validation: "zod",
          run: (input, opts) => this.callMessagesEdit(input, opts?.context),
        }),
        "surface.messages.delete": callable({
          name: "Surface Messages Delete",
          description: "Delete a message.",
          inputSchema: messagesDeleteInputSchema,
          validation: "zod",
          run: (input, opts) => this.callMessagesDelete(input, opts?.context),
        }),
        "surface.reactions.list": callable({
          name: "Surface Reactions List",
          description: "List reactions for a message (emoji + count).",
          inputSchema: reactionsListInputSchema,
          validation: "zod",
          run: (input, opts) => this.callReactionsList(input, opts?.context),
        }),
        "surface.reactions.listDetailed": callable({
          name: "Surface Reactions List Detailed",
          description: "List reactions for a message with per-user details.",
          inputSchema: reactionsListDetailedInputSchema,
          validation: "zod",
          run: (input, opts) => this.callReactionsListDetailed(input, opts?.context),
        }),
        "surface.reactions.add": callable({
          name: "Surface Reactions Add",
          description: "Add a reaction to a message.",
          inputSchema: reactionsAddInputSchema,
          validation: "zod",
          run: (input, opts) => this.callReactionsAdd(input, opts?.context),
        }),
        "surface.reactions.remove": callable({
          name: "Surface Reactions Remove",
          description: "Remove a reaction from a message.",
          inputSchema: reactionsRemoveInputSchema,
          validation: "zod",
          run: (input, opts) => this.callReactionsRemove(input, opts?.context),
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return await this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return await this.tool.call(callableId, input, opts);
  }

  private async callHelp(
    input: z.output<typeof helpInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const adapterResolver = this.params.adapterResolver;
    const getCfg = this.getCfg.bind(this);
    return Result.gen(async function* () {
      const ctxClientRaw = ctx?.requestClient;
      const ctxClient = isAdapterPlatform(ctxClientRaw) ? ctxClientRaw : "unknown";
      const contextAdapter = adapterResolver.resolve(ctxClient);
      const registeredPlatforms = adapterResolver.registeredPlatforms();
      let effective = contextAdapter;
      if (input.client) {
        effective = yield* resolveSurfaceAdapter({
          inputClient: input.client,
          ctx,
          resolver: adapterResolver,
        });
      } else if (!effective) {
        effective =
          registeredPlatforms
            .map((platform) => adapterResolver.resolve(platform))
            .filter((resolved) => resolved?.protocol.toolTargets !== undefined)
            .sort(
              (left, right) =>
                left!.protocol.toolTargets!.helpFallbackPriority -
                right!.protocol.toolTargets!.helpFallbackPriority,
            )[0] ?? null;
      }
      const cfg = yield* Result.await(getCfg());
      const contextSessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId : null;
      const targetHelp = effective?.protocol.toolTargets?.describeSessionIds({
        contextSessionId,
        config: cfg,
      });

      return Result.ok({
        tool: "surface" as const,
        supportedClients: registeredPlatforms,
        context: {
          requestClient: ctxClient,
          sessionId: contextSessionId,
          alias: targetHelp?.contextAlias,
        },
        terminology: {
          client:
            "Surface client/platform. A registered request-context adapter is authoritative; an explicit conflicting --client fails closed. Otherwise pass --client to select a registered adapter.",
          adapterResolution:
            "supportedClients lists registered executable adapters only. It does not predict support for individual operations; each operation returns its declared runtime result.",
          session:
            "A conversation container. For Discord, a session maps to a channel; for GitHub, a session maps to an issue/PR thread.",
          sessionId:
            "The CLI/session selector used by most surface.* tools. If omitted, surface tools default to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
          alias:
            "Human-friendly Discord session alias from cfg.entity.sessions.discord. Prefer aliases over raw channel ids when available.",
          messageId:
            "A platform-specific message identifier inside a session/channel. Many surface tools can default this to the origin message when requestId is 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>'.",
          replyToMessageId: "When sending a message, optionally reply to an existing messageId.",
          silent: "When true, suppress all notifications for this send (mentions + reply ping).",
          attachments:
            "Outbound: local files offered to the selected adapter (paths resolved relative to request cwd; unsupported adapters reject them explicitly). Inbound: message attachment/media metadata is first-class on surface.messages.read and hinted on surface.messages.list.",
        },
        sessionIdFormats: targetHelp?.sessionIdFormats ?? null,
        relatedConfigKeys: {
          requestClientEnv: "LILAC_REQUEST_CLIENT",
          sessionIdEnv: "LILAC_SESSION_ID",
          discordSessionAliases: "cfg.entity.sessions.discord",
          surfaceAllowlistChannels: "cfg.surface.discord.allowedChannelIds",
          surfaceAllowlistGuilds: "cfg.surface.discord.allowedGuildIds",
        },
      });
    });
  }

  private async getCfg(): Promise<ResultType<CoreConfig, ServerToolFailure>> {
    if (this.params.config) return Result.ok(this.params.config);
    if (this.params.getConfig) {
      return Result.tryPromise({
        try: this.params.getConfig,
        catch: captureSurfaceFailure,
      }).then((result) => result.mapError((failure) => surfaceExternalFailure(failure)));
    }
    return Result.err(
      surfaceFailure(
        "unavailable",
        "surface tool requires core config (tool server must be started with config)",
      ),
    );
  }

  private resolveAdapter(
    inputClient: SurfaceClient | undefined,
    ctx: RequestContext | undefined,
  ): ResultType<ResolvedSurfaceAdapter, ServerToolFailure> {
    return resolveSurfaceAdapter({
      inputClient,
      ctx,
      resolver: this.params.adapterResolver,
    });
  }

  private async resolveSessionTarget(params: {
    readonly resolved: ResolvedSurfaceAdapter;
    readonly sessionId: string;
  }): Promise<
    ResultType<
      {
        readonly resolved: ResolvedSurfaceAdapter;
        readonly sessionRef: SessionRef;
        readonly cfg?: CoreConfig;
      },
      ServerToolFailure
    >
  > {
    const routing = params.resolved.protocol.toolTargets;
    if (!routing) {
      return Result.err(
        surfaceFailure(
          "unavailable",
          `surface tool: client '${params.resolved.platform}' does not provide target routing`,
        ),
      );
    }
    const configResult = await this.getCfg();
    return configResult.andThenAsync(async (config) => {
      const target: ResultType<
        { readonly sessionRef: SessionRef; readonly config?: CoreConfig },
        SurfaceToolTargetInvalid
      > = await routing.resolveSession({
        selector: params.sessionId,
        adapter: params.resolved.adapter,
        getConfig: async () => config,
      });
      return surfaceTargetResult(target).map((targetValue) => ({
        resolved: params.resolved,
        sessionRef: targetValue.sessionRef,
        cfg: targetValue.config,
      }));
    });
  }

  private async resolveMessageTarget(params: {
    readonly resolved: ResolvedSurfaceAdapter;
    readonly sessionId: string;
    readonly messageId: string;
    readonly burstDiscordCache?: boolean;
  }): Promise<
    ResultType<
      {
        readonly resolved: ResolvedSurfaceAdapter;
        readonly sessionRef: SessionRef;
        readonly cfg?: CoreConfig;
        readonly msgRef: MsgRef;
      },
      ServerToolFailure
    >
  > {
    return (await this.resolveSessionTarget(params)).andThenAsync(async (target) => {
      const msgRef = createSurfaceMessageRef(target.sessionRef, params.messageId);
      if (
        params.burstDiscordCache &&
        target.resolved.platform === "discord" &&
        hasCacheBurstProvider(target.resolved.adapter)
      ) {
        const adapter = target.resolved.adapter;
        const burst = await Result.tryPromise({
          try: () =>
            adapter.burstCache({
              msgRef,
              sessionRef: target.sessionRef,
              reason: "surface_tool",
            }),
          catch: captureSurfaceFailure,
        });
        return burst
          .mapError((failure) => surfaceExternalFailure(failure))
          .map(() => ({ ...target, msgRef }));
      }
      return Result.ok({ ...target, msgRef });
    });
  }

  private async readRecentAgentWriteText(row: RecentAgentWriteSnapshot): Promise<string> {
    if (!isAdapterPlatform(row.client)) return row.finalText ?? "";
    const resolved = this.params.adapterResolver.resolve(row.client);
    if (!resolved) return row.finalText ?? "";
    const msg = await resolved.adapter.readMsg(
      createSurfaceMessageRef(
        resolved.protocol.refs.createSessionRef(row.sessionId),
        row.messageId,
      ),
    );
    return msg.match({
      ok: (value) => value?.text ?? row.finalText ?? "",
      err: () => row.finalText ?? "",
    });
  }

  private linkSentMessageToTranscript(ref: MsgRef, ctx: RequestContext | undefined): void {
    const requestId = ctx?.requestId;
    if (!requestId || !this.params.transcriptStore) return;
    if (!ctx?.sessionId || !isHeartbeatSessionId(ctx.sessionId)) return;

    {
      const attempt = Result.try({
        try: () => {
          this.params.transcriptStore!.linkSurfaceMessagesToRequest({
            requestId,
            created: [ref],
            last: ref,
          });
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const cause = attempt.error.cause;
        if (Panic.is(cause)) preserveToolPanic(cause);
        // Best-effort only. Do not fail the send on transcript linkage issues.
      }
    }
  }

  private async callActivitiesRecentAgentWrites(
    input: z.output<typeof activitiesRecentAgentWritesInputSchema>,
  ): Promise<ServerToolResult> {
    const transcriptStore = this.params.transcriptStore;
    const listRecentAgentWrites = transcriptStore?.listRecentAgentWrites;

    if (!transcriptStore || !listRecentAgentWrites) {
      return Result.err(
        surfaceFailure(
          "unavailable",
          "surface.activities.recentAgentWrites is unavailable: transcript store is not initialized.",
        ),
      );
    }

    const cfgResult = await this.getCfg();
    return cfgResult.andThenAsync(async (cfg) => {
      const targetLimit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 20)));

      const out: Array<{
        sessionId: string;
        messageId: string;
        alias?: string;
        client: string;
        requestId: string;
        preview: string;
        updatedTs: number;
        truncated: boolean;
      }> = [];

      let offset = 0;
      const pageSize = Math.min(200, Math.max(targetLimit, 20));

      while (out.length < targetLimit) {
        const rows = listRecentAgentWrites.call(transcriptStore, {
          limit: pageSize,
          offset,
          client: input.client,
        });
        if (rows.length === 0) break;

        offset += rows.length;

        for (const row of rows) {
          if (row.client === "discord") {
            const discord = this.params.adapterResolver.resolve("discord");
            if (!discord) continue;
            const guildId = await resolveGuildIdForChannel({
              adapter: discord.adapter,
              channelId: row.sessionId,
            });

            const allowed = shouldAllowDiscordChannel({
              cfg,
              channelId: row.sessionId,
              guildId,
            });
            const include = allowed.match({ ok: (value) => value, err: () => false });
            if (!include) {
              continue;
            }
          }

          const text = (
            await Result.tryPromise({
              try: () => this.readRecentAgentWriteText(row),
              catch: captureSurfaceFailure,
            })
          )
            .mapError((failure) => surfaceExternalFailure(failure))
            .match({
              ok: (value) => value,
              err: () => row.finalText ?? "",
            });

          const preview = toPreviewText(text);

          out.push({
            sessionId: row.sessionId,
            messageId: row.messageId,
            alias:
              row.client === "discord"
                ? bestEffortAliasForDiscordChannelId({
                    channelId: row.sessionId,
                    cfg,
                  })
                : undefined,
            client: row.client,
            requestId: row.requestId,
            preview: preview.preview,
            updatedTs: row.updatedTs,
            truncated: preview.truncated,
          });

          if (out.length >= targetLimit) break;
        }

        if (rows.length < pageSize) break;
      }

      return Result.ok(out);
    });
  }

  private async callSessionsList(
    input: z.output<typeof sessionsListInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolvedResult = this.resolveAdapter(input.client, ctx);
    return resolvedResult.andThenAsync(async (resolved) => {
      const cfgResult =
        resolved.platform === "discord" ? await this.getCfg() : Result.ok(undefined);
      return cfgResult.andThenAsync(async (cfg) => {
        const limit = input.limit ?? Number.POSITIVE_INFINITY;

        const sessionsResult = surfaceOperationResult(await resolved.adapter.listSessions());
        return sessionsResult.andThen((sessions) => {
          const out: Array<{
            channelId: string;
            guildId?: string;
            parentChannelId?: string;
            kind: string;
            title?: string;
            alias?: string;
          }> = [];

          for (const s of sessions) {
            const channelId = s.ref.channelId;
            const guildId = s.ref.platform === "discord" ? s.ref.guildId : undefined;
            const parentChannelId =
              s.ref.platform === "discord" ? s.ref.parentChannelId : undefined;

            if (s.ref.platform === "discord" && cfg) {
              const allowed = shouldAllowDiscordChannel({
                cfg,
                channelId,
                guildId,
              });
              const include = allowed.match({ ok: (value) => value, err: () => false });
              if (!include) continue;
            }

            out.push({
              channelId,
              guildId,
              parentChannelId,
              kind: s.kind,
              title: s.title,
              alias: cfg ? bestEffortAliasForDiscordChannelId({ channelId, cfg }) : undefined,
            });

            if (out.length >= limit) break;
          }

          return Result.ok(out);
        });
      });
    });
  }

  private async callSessionsListParticipants(
    decodedInput: z.output<typeof sessionsListParticipantsInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveSessionTarget = this.resolveSessionTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const input = yield* withDefaultSessionId(decodedInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const target = yield* Result.await(resolveSessionTarget({ resolved, sessionId }));
      const participants = yield* surfaceOperationResult(
        await target.resolved.adapter.listSessionParticipants(target.sessionRef, {
          limit: input.limit,
        }),
      );

      return Result.ok({
        meta: {
          session: toSessionMeta(target.sessionRef, target.cfg),
          source: participants.source,
          count: participants.participants.length,
        },
        participants: participants.participants,
      });
    });
  }

  private async callMessagesList(
    decodedInput: z.output<typeof messagesListInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveSessionTarget = this.resolveSessionTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const input = yield* withDefaultSessionId(decodedInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const target = yield* Result.await(resolveSessionTarget({ resolved, sessionId }));
      if (
        target.resolved.platform === "discord" &&
        hasCacheBurstProvider(target.resolved.adapter)
      ) {
        const adapter = target.resolved.adapter;
        yield* Result.await(
          Result.tryPromise({
            try: () =>
              adapter.burstCache({
                sessionRef: target.sessionRef,
                reason: "surface_tool",
              }),
            catch: captureSurfaceFailure,
          }).then((result) => result.mapError((failure) => surfaceExternalFailure(failure))),
        );
      }
      const messages = yield* surfaceOperationResult(
        await target.resolved.adapter.listMsg(target.sessionRef, {
          limit: input.limit ?? 50,
          beforeMessageId: input.beforeMessageId,
          afterMessageId: input.afterMessageId,
        }),
      );
      const discordCfg = target.resolved.platform === "discord" ? target.cfg : undefined;
      const filtered: SurfaceMessage[] = [];
      for (const message of messages) {
        if (!discordCfg) {
          filtered.push(message);
          continue;
        }
        if (message.session.platform !== "discord") continue;
        const allowed = yield* shouldAllowDiscordChannel({
          cfg: discordCfg,
          channelId: message.session.channelId,
          guildId: message.session.guildId,
        });
        if (allowed) filtered.push(message);
      }
      const referencedByMessageKey =
        target.resolved.platform === "discord" && discordCfg
          ? yield* Result.await(
              resolveDiscordReferencedMessages({
                adapter: target.resolved.adapter,
                allowChannel: (channel) =>
                  shouldAllowDiscordChannel({ cfg: discordCfg, ...channel }),
                messages: filtered,
              }),
            )
          : undefined;

      return Result.ok(
        buildMessagesListOutput({
          session: target.sessionRef,
          cfg: target.cfg,
          messages: filtered,
          order: input.order ?? "ts_desc",
          includeRaw: input.includeRaw ?? false,
          includeAttachments: input.includeAttachments ?? false,
          referencedByMessageKey,
        }),
      );
    });
  }

  private async callMessagesRead(
    decodedInput: z.output<typeof messagesReadInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveSessionTarget = this.resolveSessionTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const sessionInput = yield* withDefaultSessionId(decodedInput, ctx);
      const input = yield* withDefaultMessageId(sessionInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const messageId = yield* mustPresentString(input.messageId, "messageId");
      const target = yield* Result.await(resolveSessionTarget({ resolved, sessionId }));
      const msgRef = createSurfaceMessageRef(target.sessionRef, messageId);
      if (
        target.resolved.platform === "discord" &&
        hasCacheBurstProvider(target.resolved.adapter)
      ) {
        const adapter = target.resolved.adapter;
        yield* Result.await(
          Result.tryPromise({
            try: () =>
              adapter.burstCache({
                msgRef,
                sessionRef: target.sessionRef,
                reason: "surface_tool",
              }),
            catch: captureSurfaceFailure,
          }).then((result) => result.mapError((failure) => surfaceExternalFailure(failure))),
        );
      }
      const msg = yield* surfaceOperationResult(await target.resolved.adapter.readMsg(msgRef));
      if (!msg) {
        return Result.ok(
          buildMessagesReadOutput({
            session: target.sessionRef,
            cfg: target.cfg,
            message: null,
            includeRaw: input.includeRaw ?? false,
          }),
        );
      }
      if (target.resolved.platform === "discord" && target.cfg) {
        const allowed =
          msg.session.platform === "discord" &&
          (yield* shouldAllowDiscordChannel({
            cfg: target.cfg,
            channelId: msg.session.channelId,
            guildId: msg.session.guildId,
          }));
        if (!allowed) {
          return Result.ok(
            buildMessagesReadOutput({
              session: target.sessionRef,
              cfg: target.cfg,
              message: null,
              includeRaw: input.includeRaw ?? false,
            }),
          );
        }
      }
      const referenced =
        target.resolved.platform === "discord" && target.cfg
          ? yield* Result.await(
              resolveDiscordReferencedMessage({
                adapter: target.resolved.adapter,
                allowChannel: (channel) =>
                  shouldAllowDiscordChannel({ cfg: target.cfg!, ...channel }),
                message: msg,
              }),
            )
          : undefined;
      return Result.ok(
        buildMessagesReadOutput({
          session: target.sessionRef,
          cfg: target.cfg,
          message: msg,
          referenced,
          includeRaw: input.includeRaw ?? false,
        }),
      );
    });
  }

  private async callMessagesSearch(
    decodedInput: z.output<typeof messagesSearchInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolvedResult = this.resolveAdapter(decodedInput.client, ctx);
    return resolvedResult.andThenAsync(async (resolved) => {
      const inputResult = withDefaultSessionId(decodedInput, ctx);
      return inputResult.andThenAsync(async (input) => {
        const sessionIdResult = mustPresentString(input.sessionId, "sessionId");
        return sessionIdResult.andThenAsync(async (sessionId) => {
          return (await this.resolveSessionTarget({ resolved, sessionId })).andThenAsync(
            async (target) => {
              if (
                target.resolved.platform !== "discord" ||
                target.sessionRef.platform !== "discord" ||
                !target.cfg
              ) {
                return Result.err(
                  surfaceFailure(
                    "unavailable",
                    "surface.messages.search is a Discord-owned sidecar and is unavailable for GitHub; use discovery.search for shared memory retrieval.",
                  ),
                );
              }

              const search = this.params.discordSearch;
              if (!search) {
                return Result.err(
                  surfaceFailure(
                    "unavailable",
                    "surface.messages.search is unavailable: Discord search index is not initialized.",
                  ),
                );
              }

              const result = await search.searchSession({
                sessionRef: target.sessionRef,
                query: input.query,
                limit: input.limit,
              });

              const userAliasById = buildDiscordUserAliasById(target.cfg);
              const baseHits = result.hits.map((hit) => ({
                ...hit,
                userAlias: userAliasById.get(hit.userId),
              }));

              const order: MessageSearchOrder = input.order ?? "relevance";
              const hits =
                order === "relevance"
                  ? baseHits
                  : [...baseHits]
                      .sort((a, b) => compareSurfaceMessageChronological(a, b))
                      .map((hit) => hit);

              if (order === "ts_desc") {
                hits.reverse();
              }

              const attachmentHintsByMessageId = new Map<string, SurfaceMessageAttachmentHints>();
              await Promise.all(
                hits.map(async (hit) => {
                  const read = await Result.tryPromise({
                    try: () => target.resolved.adapter.readMsg(hit.ref),
                    catch: captureSurfaceFailure,
                  });
                  const msg = read
                    .mapError((failure) => surfaceExternalFailure(failure))
                    .match({
                      ok: (result) => result.match({ ok: (value) => value, err: () => null }),
                      err: () => null,
                    });
                  const attachments = msg ? getMessageAttachmentMeta(msg) : [];
                  attachmentHintsByMessageId.set(
                    hit.ref.messageId,
                    buildAttachmentHints(attachments),
                  );
                }),
              );

              return Result.ok({
                meta: {
                  session: toSessionMeta(target.sessionRef, target.cfg),
                  order,
                  count: hits.length,
                },
                query: input.query,
                heal: result.heal,
                hits: hits.map((hit) => ({
                  messageId: hit.ref.messageId,
                  userId: hit.userId,
                  userName: hit.userName,
                  userAlias: hit.userAlias,
                  richText: hit.text,
                  ts: hit.ts,
                  editedTs: hit.editedTs,
                  score: hit.score,
                  ...(attachmentHintsByMessageId.get(hit.ref.messageId) ??
                    buildAttachmentHints([])),
                })),
              });
            },
          );
        });
      });
    });
  }

  private async callMessagesSend(
    decodedInput: z.output<typeof messagesSendInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveSessionTarget = this.resolveSessionTarget.bind(this);
    const linkSentMessageToTranscript = this.linkSentMessageToTranscript.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const input = yield* withDefaultSessionId(decodedInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const target = yield* Result.await(resolveSessionTarget({ resolved, sessionId }));

      const replyTo = input.replyToMessageId
        ? createSurfaceMessageRef(target.sessionRef, input.replyToMessageId)
        : undefined;

      const paths = input.paths ?? [];
      const sendOpts =
        replyTo || input.silent === true
          ? {
              ...(replyTo ? { replyTo } : {}),
              ...(input.silent === true ? { silent: true } : {}),
            }
          : undefined;
      yield* surfaceOperationResult(
        await target.resolved.adapter.prepareSendMsg(
          target.sessionRef,
          { text: input.text, attachmentCount: paths.length, actionCount: 0 },
          sendOpts,
        ),
      );

      const cwd = ctx?.cwd ?? process.cwd();

      const attachments = yield* paths.length > 0
        ? await loadLocalAttachments({
            cwd,
            paths,
            filenames: input.filenames,
            mimeTypes: input.mimeTypes,
            context: ctx,
          })
        : Result.ok([]);

      const ref = yield* surfaceOperationResult(
        await target.resolved.adapter.sendMsg(
          target.sessionRef,
          {
            text: input.text,
            attachments,
          },
          sendOpts,
        ),
      );

      linkSentMessageToTranscript(ref, ctx);

      return Result.ok({
        ok: true as const,
        ref,
        session: toSessionMeta(target.sessionRef, target.cfg),
      });
    });
  }

  private async callMessagesEdit(
    decodedInput: z.output<typeof messagesEditInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveSessionTarget = this.resolveSessionTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const input = yield* withDefaultSessionId(decodedInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const target = yield* Result.await(resolveSessionTarget({ resolved, sessionId }));
      yield* surfaceOperationResult(
        await target.resolved.adapter.editMsg(
          createSurfaceMessageRef(target.sessionRef, input.messageId),
          { text: input.text },
        ),
      );
      return Result.ok({ ok: true as const });
    });
  }

  private async callMessagesDelete(
    decodedInput: z.output<typeof messagesDeleteInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveSessionTarget = this.resolveSessionTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const input = yield* withDefaultSessionId(decodedInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const target = yield* Result.await(resolveSessionTarget({ resolved, sessionId }));
      yield* surfaceOperationResult(
        await target.resolved.adapter.deleteMsg(
          createSurfaceMessageRef(target.sessionRef, input.messageId),
        ),
      );
      return Result.ok({ ok: true as const });
    });
  }

  private async callReactionsList(
    decodedInput: z.output<typeof reactionsListInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveMessageTarget = this.resolveMessageTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const sessionInput = yield* withDefaultSessionId(decodedInput, ctx);
      const input = yield* withDefaultMessageId(sessionInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const messageId = yield* mustPresentString(input.messageId, "messageId");
      const target = yield* Result.await(
        resolveMessageTarget({
          resolved,
          sessionId,
          messageId,
          burstDiscordCache: true,
        }),
      );
      const details = yield* surfaceOperationResult(
        await target.resolved.adapter.listReactionDetails(target.msgRef),
      );
      const out: SurfaceReactionSummary[] = details.map((detail) => ({
        emoji: detail.emoji,
        count: detail.count,
      }));
      return Result.ok(out);
    });
  }

  private async callReactionsListDetailed(
    decodedInput: z.output<typeof reactionsListDetailedInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveMessageTarget = this.resolveMessageTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const sessionInput = yield* withDefaultSessionId(decodedInput, ctx);
      const input = yield* withDefaultMessageId(sessionInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const messageId = yield* mustPresentString(input.messageId, "messageId");
      const target = yield* Result.await(
        resolveMessageTarget({
          resolved,
          sessionId,
          messageId,
          burstDiscordCache: true,
        }),
      );
      return surfaceOperationResult(
        await target.resolved.adapter.listReactionDetails(target.msgRef),
      );
    });
  }

  private async callReactionsAdd(
    decodedInput: z.output<typeof reactionsAddInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveMessageTarget = this.resolveMessageTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const sessionInput = yield* withDefaultSessionId(decodedInput, ctx);
      const input = yield* withDefaultMessageId(sessionInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const messageId = yield* mustPresentString(input.messageId, "messageId");
      const target = yield* Result.await(resolveMessageTarget({ resolved, sessionId, messageId }));
      yield* surfaceOperationResult(
        await target.resolved.adapter.addReaction(target.msgRef, input.reaction),
      );
      return Result.ok({ ok: true as const });
    });
  }

  private async callReactionsRemove(
    decodedInput: z.output<typeof reactionsRemoveInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const resolveAdapter = this.resolveAdapter.bind(this);
    const resolveMessageTarget = this.resolveMessageTarget.bind(this);
    return Result.gen(async function* () {
      const resolved = yield* resolveAdapter(decodedInput.client, ctx);
      const sessionInput = yield* withDefaultSessionId(decodedInput, ctx);
      const input = yield* withDefaultMessageId(sessionInput, ctx);
      const sessionId = yield* mustPresentString(input.sessionId, "sessionId");
      const messageId = yield* mustPresentString(input.messageId, "messageId");
      const target = yield* Result.await(resolveMessageTarget({ resolved, sessionId, messageId }));
      yield* surfaceOperationResult(
        await target.resolved.adapter.removeReaction(target.msgRef, input.reaction),
      );
      return Result.ok({ ok: true as const });
    });
  }
}
