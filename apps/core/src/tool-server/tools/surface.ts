import { z } from "zod";
import fs from "node:fs/promises";
import { basename } from "node:path";
import { fileTypeFromBuffer } from "file-type/core";
import { isAdapterPlatform } from "../../shared/is-adapter-platform";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  hasCacheBurstProvider,
  type SurfaceAdapter,
} from "../../surface/adapter";
import type {
  MsgRef,
  SessionRef,
  SurfaceAttachment,
  SurfaceReactionDetail,
  SurfaceReactionSummary,
  SurfaceSession,
} from "../../surface/types";
import type { RequestContext, ServerTool } from "../types";

import {
  bestEffortTokenForDiscordChannelId,
  resolveDiscordSessionId,
} from "./resolve-discord-session-id";
import { zodObjectToCliLines } from "./zod-cli";
import {
  inferMimeTypeFromFilename,
  resolveToolPath,
} from "../../shared/attachment-utils";

const surfaceClientSchema = z
  .enum(["discord", "whatsapp", "slack", "telegram", "web"])
  .describe(
    "Surface client/platform (required if request client is unknown / not provided)",
  );

type SurfaceClient = z.infer<typeof surfaceClientSchema>;

function inferDiscordOriginFromRequestId(
  requestId: string | undefined,
): { sessionId: string; messageId: string } | null {
  if (!requestId) return null;
  const m = /^discord:([^:]+):([^:]+)$/.exec(requestId);
  if (!m) return null;
  return { sessionId: m[1]!, messageId: m[2]! };
}

function resolveClient(params: {
  inputClient?: SurfaceClient;
  ctx?: RequestContext;
}): SurfaceClient {
  const ctxClientRaw = params.ctx?.requestClient;
  const ctxClient = isAdapterPlatform(ctxClientRaw) ? ctxClientRaw : "unknown";

  if (ctxClient !== "unknown") {
    if (params.inputClient && params.inputClient !== ctxClient) {
      throw new Error(
        `Client mismatch: context requestClient is '${ctxClient}' but input client is '${params.inputClient}'`,
      );
    }
    // context is authoritative
    return ctxClient;
  }

  if (!params.inputClient) {
    throw new Error(
      "surface tool requires --client when request client is unknown (set LILAC_REQUEST_CLIENT or pass --client=<client>)",
    );
  }

  return params.inputClient;
}

function ensureDiscordClient(client: SurfaceClient): "discord" {
  if (client !== "discord") {
    throw new Error(
      `surface tool: client '${client}' is not supported yet (only 'discord' is currently implemented)`,
    );
  }
  return "discord";
}

function mustDiscordSurfaceConfig(cfg: CoreConfig) {
  const discord = cfg.surface.discord;
  if (!discord) throw new Error("surface.discord config missing");
  return discord;
}

function shouldAllowDiscordChannel(params: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): boolean {
  const discord = mustDiscordSurfaceConfig(params.cfg);

  const allowedChannelIds = new Set(discord.allowedChannelIds);
  const allowedGuildIds = new Set(discord.allowedGuildIds);

  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return false;

  if (allowedChannelIds.has(params.channelId)) return true;

  const gid = params.guildId ?? null;
  if (gid && allowedGuildIds.has(gid)) return true;

  return false;
}

function asDiscordSessionRef(
  channelId: string,
  guildId?: string,
  parentChannelId?: string,
): SessionRef {
  return {
    platform: "discord",
    channelId,
    guildId,
    parentChannelId,
  };
}

function asDiscordMsgRef(channelId: string, messageId: string): MsgRef {
  return { platform: "discord", channelId, messageId };
}

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export async function loadLocalAttachments(params: {
  cwd: string;
  paths: string[];
  filenames?: string[];
  mimeTypes?: string[];
}): Promise<SurfaceAttachment[]> {
  let totalBytes = 0;

  const out: SurfaceAttachment[] = [];

  for (let i = 0; i < params.paths.length; i++) {
    const inputPath = params.paths[i]!;
    const resolvedPath = resolveToolPath(params.cwd, inputPath);

    const st = await fs.stat(resolvedPath);
    if (!st.isFile()) {
      throw new Error(`Not a file: ${resolvedPath}`);
    }

    if (st.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
      throw new Error(
        `Attachment too large (${st.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${resolvedPath}`,
      );
    }

    totalBytes += st.size;
    if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
      throw new Error(
        `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
      );
    }

    const bytes = await fs.readFile(resolvedPath);

    const filename =
      (params.filenames && params.filenames[i]) ?? basename(resolvedPath);

    const typeFromBytes = await fileTypeFromBuffer(bytes);

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

  return out;
}

type GuildIdResolver = {
  fetchGuildIdForChannel(channelId: string): Promise<string | null>;
};

type ReactionDetailsProvider = {
  listReactionDetails(msgRef: MsgRef): Promise<SurfaceReactionDetail[]>;
};

function hasGuildIdResolver(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & GuildIdResolver {
  return (
    typeof (adapter as unknown as { fetchGuildIdForChannel?: unknown })
      .fetchGuildIdForChannel === "function"
  );
}

function hasReactionDetailsProvider(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & ReactionDetailsProvider {
  return (
    typeof (adapter as unknown as { listReactionDetails?: unknown })
      .listReactionDetails === "function"
  );
}

async function tryGetCachedSession(
  adapter: SurfaceAdapter,
  channelId: string,
): Promise<SurfaceSession | null> {
  const sessions = await adapter.listSessions();
  for (const s of sessions) {
    if (s.ref.platform !== "discord") continue;
    if (s.ref.channelId === channelId) return s;
  }
  return null;
}

async function resolveGuildIdForChannel(params: {
  adapter: SurfaceAdapter;
  channelId: string;
}): Promise<string | null> {
  const sess = await tryGetCachedSession(params.adapter, params.channelId);
  if (sess?.ref.platform === "discord") {
    return sess.ref.guildId ?? null;
  }

  if (hasGuildIdResolver(params.adapter)) {
    try {
      return await params.adapter.fetchGuildIdForChannel(params.channelId);
    } catch {
      return null;
    }
  }

  return null;
}

const baseInputSchema = z.object({
  client: surfaceClientSchema.optional(),
});

const helpInputSchema = baseInputSchema;

function withDefaultSessionId(
  rawInput: Record<string, unknown>,
  ctx: RequestContext | undefined,
): Record<string, unknown> {
  const hasOwn = Object.prototype.hasOwnProperty.call(rawInput, "sessionId");
  const value = rawInput["sessionId"];

  // If explicitly provided (even null/empty), defer to schema validation.
  if (hasOwn && value !== undefined) return rawInput;

  const ctxSessionId =
    typeof ctx?.sessionId === "string" && ctx.sessionId.length > 0
      ? ctx.sessionId
      : inferDiscordOriginFromRequestId(ctx?.requestId)?.sessionId;

  if (ctxSessionId) {
    return { ...rawInput, sessionId: ctxSessionId };
  }

  throw new Error(
    "surface tool requires --session-id when request session is unknown (set LILAC_SESSION_ID or pass --session-id=<id>)",
  );
}

function withDefaultMessageId(
  rawInput: Record<string, unknown>,
  ctx: RequestContext | undefined,
): Record<string, unknown> {
  const hasOwn = Object.prototype.hasOwnProperty.call(rawInput, "messageId");
  const value = rawInput["messageId"];

  // If explicitly provided (even null/empty), defer to schema validation.
  if (hasOwn && value !== undefined) return rawInput;

  const inferred = inferDiscordOriginFromRequestId(ctx?.requestId);
  if (inferred?.messageId) {
    return { ...rawInput, messageId: inferred.messageId };
  }

  const rid = typeof ctx?.requestId === "string" ? ctx.requestId : undefined;
  const hint = rid ? ` (requestId='${rid}')` : " (no requestId in context)";

  throw new Error(
    `surface tool requires --message-id when origin message is unknown${hint}. ` +
      "This is expected for active-mode gated batches (requestId like 'req:<uuid>'); pass --message-id explicitly.",
  );
}

function mustPresentString(v: unknown, label: string): string {
  if (typeof v === "string" && v.length > 0) return v;
  throw new Error(`surface tool internal error: missing ${label}`);
}

const sessionsListInputSchema = baseInputSchema;

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
      "Target message id. If omitted and the current requestId is 'discord:<sessionId>:<messageId>', defaults to that origin message.",
    ),
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
  paths: z
    .array(z.string().min(1))
    .optional()
    .describe("Local file paths to attach (resolved relative to request cwd)"),
  filenames: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional filenames for each attachment"),
  mimeTypes: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional mime types for each attachment"),
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
      "Target message id. If omitted and the current requestId is 'discord:<sessionId>:<messageId>', defaults to that origin message.",
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
      "Target message id. If omitted and the current requestId is 'discord:<sessionId>:<messageId>', defaults to that origin message.",
    ),
  reaction: z
    .string()
    .min(1)
    .describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
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
      "Target message id. If omitted and the current requestId is 'discord:<sessionId>:<messageId>', defaults to that origin message.",
    ),
  reaction: z
    .string()
    .min(1)
    .describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
});

export class Surface implements ServerTool {
  id = "surface";

  constructor(
    private readonly params: {
      adapter: SurfaceAdapter;
      config?: CoreConfig;
      getConfig?: () => Promise<CoreConfig>;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "surface.help",
        name: "Surface Help",
        description:
          "Explain surface terminology (client/platform/sessionId/messageId) and common sessionId formats.",
        shortInput: zodObjectToCliLines(helpInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(helpInputSchema),
      },
      {
        callableId: "surface.sessions.list",
        name: "Surface Sessions List",
        description:
          "List cached sessions. Provide --client if request client is unknown.",
        shortInput: zodObjectToCliLines(sessionsListInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(sessionsListInputSchema),
      },
      {
        callableId: "surface.messages.list",
        name: "Surface Messages List",
        description: "List messages for a session.",
        shortInput: zodObjectToCliLines(messagesListInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(messagesListInputSchema),
      },
      {
        callableId: "surface.messages.read",
        name: "Surface Messages Read",
        description: "Read a message by id.",
        shortInput: zodObjectToCliLines(messagesReadInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(messagesReadInputSchema),
      },
      {
        callableId: "surface.messages.send",
        name: "Surface Messages Send",
        description: "Send a message to a session.",
        shortInput: zodObjectToCliLines(messagesSendInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(messagesSendInputSchema),
      },
      {
        callableId: "surface.messages.edit",
        name: "Surface Messages Edit",
        description: "Edit a message.",
        shortInput: zodObjectToCliLines(messagesEditInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(messagesEditInputSchema),
      },
      {
        callableId: "surface.messages.delete",
        name: "Surface Messages Delete",
        description: "Delete a message.",
        shortInput: zodObjectToCliLines(messagesDeleteInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(messagesDeleteInputSchema),
      },
      {
        callableId: "surface.reactions.list",
        name: "Surface Reactions List",
        description: "List reactions for a message (emoji + count).",
        shortInput: zodObjectToCliLines(reactionsListInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(reactionsListInputSchema),
      },
      {
        callableId: "surface.reactions.listDetailed",
        name: "Surface Reactions List Detailed",
        description:
          "List reactions for a message with per-user details (Discord only).",
        shortInput: zodObjectToCliLines(reactionsListDetailedInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(reactionsListDetailedInputSchema),
      },
      {
        callableId: "surface.reactions.add",
        name: "Surface Reactions Add",
        description: "Add a reaction to a message.",
        shortInput: zodObjectToCliLines(reactionsAddInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(reactionsAddInputSchema),
      },
      {
        callableId: "surface.reactions.remove",
        name: "Surface Reactions Remove",
        description: "Remove a reaction from a message.",
        shortInput: zodObjectToCliLines(reactionsRemoveInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(reactionsRemoveInputSchema),
      },
    ];
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
      messages?: readonly unknown[];
    },
  ): Promise<unknown> {
    if (callableId === "surface.help") {
      return await this.callHelp(input, opts?.context);
    }
    if (callableId === "surface.sessions.list") {
      return await this.callSessionsList(input, opts?.context);
    }
    if (callableId === "surface.messages.list") {
      return await this.callMessagesList(input, opts?.context);
    }
    if (callableId === "surface.messages.read") {
      return await this.callMessagesRead(input, opts?.context);
    }
    if (callableId === "surface.messages.send") {
      return await this.callMessagesSend(input, opts?.context);
    }
    if (callableId === "surface.messages.edit") {
      return await this.callMessagesEdit(input, opts?.context);
    }
    if (callableId === "surface.messages.delete") {
      return await this.callMessagesDelete(input, opts?.context);
    }
    if (callableId === "surface.reactions.list") {
      return await this.callReactionsList(input, opts?.context);
    }
    if (callableId === "surface.reactions.listDetailed") {
      return await this.callReactionsListDetailed(input, opts?.context);
    }
    if (callableId === "surface.reactions.add") {
      return await this.callReactionsAdd(input, opts?.context);
    }
    if (callableId === "surface.reactions.remove") {
      return await this.callReactionsRemove(input, opts?.context);
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }

  private async callHelp(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = helpInputSchema.parse(rawInput);

    const ctxClientRaw = ctx?.requestClient;
    const ctxClient = isAdapterPlatform(ctxClientRaw)
      ? ctxClientRaw
      : "unknown";
    const effectiveClient =
      input.client ?? (ctxClient !== "unknown" ? ctxClient : undefined);

    return {
      tool: "surface" as const,
      supportedClients: ["discord"] as const,
      context: {
        requestClient: ctxClient,
        sessionId: typeof ctx?.sessionId === "string" ? ctx.sessionId : null,
      },
      terminology: {
        client:
          "Surface client/platform. If the request context has a known client (LILAC_REQUEST_CLIENT), --client is optional; otherwise pass --client explicitly.",
        session:
          "A conversation container. For Discord, a session maps to a channel.",
        sessionId:
          "The CLI/session selector used by most surface.* tools. If omitted, surface tools default to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
        messageId:
          "A platform-specific message identifier inside a session/channel. Many surface tools can default this to the origin message when requestId is 'discord:<sessionId>:<messageId>'.",
        replyToMessageId:
          "When sending a message, optionally reply to an existing messageId.",
        attachments:
          "Local files attached to an outbound message (paths resolved relative to request cwd).",
      },
      sessionIdFormats:
        effectiveClient === "discord" || effectiveClient === undefined
          ? {
              client: "discord" as const,
              accepted: [
                {
                  format: "123456789012345678",
                  meaning: "Raw Discord channel id",
                },
                {
                  format: "<#123456789012345678>",
                  meaning: "Discord channel mention",
                },
                {
                  format: "dev-chat",
                  meaning:
                    "Configured token alias (cfg.entity.sessions.discord maps token -> channelId)",
                },
              ],
              notes: [
                "Only Discord is implemented today; other clients are reserved.",
                "If the request has no session context, you must pass --session-id (or set LILAC_SESSION_ID). Some requests also allow inferring sessionId/messageId from requestId when it is 'discord:<sessionId>:<messageId>'.",
              ],
            }
          : {
              client: effectiveClient,
              accepted: [],
              notes: [
                "Only Discord is implemented today; pass --client=discord (or set LILAC_REQUEST_CLIENT=discord).",
              ],
            },
      relatedConfigKeys: {
        requestClientEnv: "LILAC_REQUEST_CLIENT",
        sessionIdEnv: "LILAC_SESSION_ID",
        discordSessionAliases: "cfg.entity.sessions.discord",
        surfaceAllowlistChannels: "cfg.surface.discord.allowedChannelIds",
        surfaceAllowlistGuilds: "cfg.surface.discord.allowedGuildIds",
      },
    };
  }

  private async getCfg(): Promise<CoreConfig> {
    if (this.params.config) return this.params.config;
    if (this.params.getConfig) return this.params.getConfig();
    throw new Error(
      "surface tool requires core config (tool server must be started with config)",
    );
  }

  private async callSessionsList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = sessionsListInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const sessions = await this.params.adapter.listSessions();
    const out: Array<{
      channelId: string;
      guildId?: string;
      parentChannelId?: string;
      kind: string;
      title?: string;
      token?: string;
    }> = [];

    for (const s of sessions) {
      if (s.ref.platform !== "discord") continue;

      const channelId = s.ref.channelId;
      const guildId = s.ref.guildId;
      const parentChannelId = s.ref.parentChannelId;

      if (
        !shouldAllowDiscordChannel({
          cfg,
          channelId,
          guildId,
        })
      ) {
        continue;
      }

      out.push({
        channelId,
        guildId,
        parentChannelId,
        kind: s.kind,
        title: s.title,
        token: bestEffortTokenForDiscordChannelId({
          channelId,
          cfg,
        }),
      });
    }

    return out;
  }

  private async callMessagesList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesListInputSchema.parse(
      withDefaultSessionId(rawInput, ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        sessionRef,
        reason: "surface_tool",
      });
    }

    const limit = input.limit ?? 50;
    const messages = await this.params.adapter.listMsg(sessionRef, {
      limit,
      beforeMessageId: input.beforeMessageId,
      afterMessageId: input.afterMessageId,
    });

    // Adapter store should only contain allowed messages, but keep tool-side filtering anyway.
    return messages.filter((m) =>
      shouldAllowDiscordChannel({
        cfg,
        channelId: m.session.channelId,
        guildId: m.session.guildId,
      }),
    );
  }

  private async callMessagesRead(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesReadInputSchema.parse(
      withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    const msgRef = asDiscordMsgRef(
      channelId,
      mustPresentString(input.messageId, "messageId"),
    );

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        msgRef,
        sessionRef: asDiscordSessionRef(channelId, guildId ?? undefined),
        reason: "surface_tool",
      });
    }

    const msg = await this.params.adapter.readMsg(msgRef);

    if (!msg) return null;

    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId: msg.session.channelId,
        guildId: msg.session.guildId,
      })
    ) {
      return null;
    }

    return msg;
  }

  private async callMessagesSend(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesSendInputSchema.parse(
      withDefaultSessionId(rawInput, ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);

    const replyTo = input.replyToMessageId
      ? asDiscordMsgRef(channelId, input.replyToMessageId)
      : undefined;

    const cwd = ctx?.cwd ?? process.cwd();

    const paths = input.paths ?? [];
    if (paths.length > 0) {
      if (paths.length > 10) {
        throw new Error(
          `Too many attachments (${paths.length}). Max is 10 per message.`,
        );
      }
    }

    const attachments =
      paths.length > 0
        ? await loadLocalAttachments({
            cwd,
            paths,
            filenames: input.filenames,
            mimeTypes: input.mimeTypes,
          })
        : [];

    const ref = await this.params.adapter.sendMsg(
      sessionRef,
      {
        text: input.text,
        attachments,
      },
      replyTo ? { replyTo } : undefined,
    );

    return { ok: true as const, ref };
  }

  private async callMessagesEdit(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesEditInputSchema.parse(
      withDefaultSessionId(rawInput, ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.editMsg(
      asDiscordMsgRef(channelId, input.messageId),
      {
        text: input.text,
      },
    );

    return { ok: true as const };
  }

  private async callMessagesDelete(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesDeleteInputSchema.parse(
      withDefaultSessionId(rawInput, ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.deleteMsg(
      asDiscordMsgRef(channelId, input.messageId),
    );
    return { ok: true as const };
  }

  private async callReactionsList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = reactionsListInputSchema.parse(
      withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    if (!hasReactionDetailsProvider(this.params.adapter)) {
      throw new Error(
        "surface.reactions.list requires an adapter that supports reaction details",
      );
    }

    const msgRef = asDiscordMsgRef(
      channelId,
      mustPresentString(input.messageId, "messageId"),
    );

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        msgRef,
        sessionRef: asDiscordSessionRef(channelId, guildId ?? undefined),
        reason: "surface_tool",
      });
    }

    const details = await this.params.adapter.listReactionDetails(msgRef);

    const out: SurfaceReactionSummary[] = details.map((d) => ({
      emoji: d.emoji,
      count: d.count,
    }));

    return out;
  }

  private async callReactionsListDetailed(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = reactionsListDetailedInputSchema.parse(
      withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    if (!hasReactionDetailsProvider(this.params.adapter)) {
      throw new Error(
        "surface.reactions.listDetailed is not supported by the current adapter",
      );
    }

    const msgRef = asDiscordMsgRef(
      channelId,
      mustPresentString(input.messageId, "messageId"),
    );

    if (hasCacheBurstProvider(this.params.adapter)) {
      await this.params.adapter.burstCache({
        msgRef,
        sessionRef: asDiscordSessionRef(channelId, guildId ?? undefined),
        reason: "surface_tool",
      });
    }

    return await this.params.adapter.listReactionDetails(msgRef);
  }

  private async callReactionsAdd(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = reactionsAddInputSchema.parse(
      withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.addReaction(
      asDiscordMsgRef(
        channelId,
        mustPresentString(input.messageId, "messageId"),
      ),
      input.reaction,
    );

    return { ok: true as const };
  }

  private async callReactionsRemove(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = reactionsRemoveInputSchema.parse(
      withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const cfg = await this.getCfg();

    const channelId = resolveDiscordSessionId({
      sessionId: mustPresentString(input.sessionId, "sessionId"),
      cfg,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.removeReaction(
      asDiscordMsgRef(
        channelId,
        mustPresentString(input.messageId, "messageId"),
      ),
      input.reaction,
    );

    return { ok: true as const };
  }
}
