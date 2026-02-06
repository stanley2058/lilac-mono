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
import type { DiscordSearchService } from "../../surface/store/discord-search-store";
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

import {
  isGithubIssueTriggerId,
  parseGithubRequestId,
  parseGithubSessionId,
} from "../../github/github-ids";
import {
  createIssueComment,
  createIssueCommentReaction,
  createIssueReaction,
  deleteIssueComment,
  deleteIssueCommentReactionById,
  deleteIssueReactionById,
  editIssueComment,
  getGithubAppSlugOrNull,
  getIssue,
  getIssueComment,
  listIssueCommentReactions,
  listIssueComments,
  listIssueReactions,
  type GithubReaction,
} from "../../github/github-api";

const surfaceClientSchema = z
  .enum(["discord", "github", "whatsapp", "slack", "telegram", "web"])
  .describe(
    "Surface client/platform (required if request client is unknown / not provided)",
  );

type SurfaceClient = z.infer<typeof surfaceClientSchema>;

function isSurfaceClient(x: string): x is SurfaceClient {
  return (
    x === "discord" ||
    x === "github" ||
    x === "whatsapp" ||
    x === "slack" ||
    x === "telegram" ||
    x === "web"
  );
}

function inferDiscordOriginFromRequestId(
  requestId: string | undefined,
): { sessionId: string; messageId: string } | null {
  if (!requestId) return null;
  const m = /^discord:([^:]+):([^:]+)$/.exec(requestId);
  if (!m) return null;
  return { sessionId: m[1]!, messageId: m[2]! };
}

function inferGithubOriginFromRequestId(
  requestId: string | undefined,
): { sessionId: string; messageId: string } | null {
  if (!requestId) return null;
  const parsed = parseGithubRequestId({ requestId });
  if (!parsed) return null;
  return { sessionId: parsed.sessionId, messageId: parsed.triggerId };
}

function resolveClient(params: {
  inputClient?: SurfaceClient;
  ctx?: RequestContext;
}): SurfaceClient {
  const ctxClientRaw = params.ctx?.requestClient;
  const ctxClient =
    typeof ctxClientRaw === "string" && isAdapterPlatform(ctxClientRaw) && isSurfaceClient(ctxClientRaw)
      ? ctxClientRaw
      : "unknown";

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
      `surface tool: client '${client}' is not supported yet (supported: 'discord', 'github')`,
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

function asGithubSessionRef(sessionId: string): SessionRef {
  return { platform: "github", channelId: sessionId };
}

function asGithubMsgRef(sessionId: string, messageId: string): MsgRef {
  return { platform: "github", channelId: sessionId, messageId };
}

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

const GITHUB_REACTION_CONTENTS = [
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
] as const;

type GithubReactionContent = (typeof GITHUB_REACTION_CONTENTS)[number];

function githubReactionEmojiFromContent(content: string): string {
  switch (content) {
    case "+1":
      return "👍";
    case "-1":
      return "👎";
    case "laugh":
      return "😄";
    case "confused":
      return "😕";
    case "heart":
      return "❤️";
    case "hooray":
      return "🎉";
    case "rocket":
      return "🚀";
    case "eyes":
      return "👀";
    default:
      return content;
  }
}

function githubReactionContentFromInput(reaction: string): GithubReactionContent {
  const raw = reaction.trim();
  const alias = raw.startsWith(":") && raw.endsWith(":") ? raw.slice(1, -1) : raw;
  const normalized = alias.trim().toLowerCase();

  // Direct emoji shortcuts.
  switch (raw) {
    case "👍":
      return "+1";
    case "👎":
      return "-1";
    case "😄":
      return "laugh";
    case "😕":
      return "confused";
    case "❤️":
      return "heart";
    case "🎉":
      return "hooray";
    case "🚀":
      return "rocket";
    case "👀":
      return "eyes";
  }

  if (
    normalized === "+1" ||
    normalized === "thumbsup" ||
    normalized === "thumbs_up" ||
    normalized === "like"
  ) {
    return "+1";
  }
  if (
    normalized === "-1" ||
    normalized === "thumbsdown" ||
    normalized === "thumbs_down" ||
    normalized === "dislike"
  ) {
    return "-1";
  }
  if (normalized === "laugh" || normalized === "smile" || normalized === "grin") {
    return "laugh";
  }
  if (
    normalized === "confused" ||
    normalized === "confusion" ||
    normalized === "thinking"
  ) {
    return "confused";
  }
  if (normalized === "heart" || normalized === "love") {
    return "heart";
  }
  if (normalized === "hooray" || normalized === "tada" || normalized === "party") {
    return "hooray";
  }
  if (normalized === "rocket") {
    return "rocket";
  }
  if (normalized === "eyes") {
    return "eyes";
  }

  if ((GITHUB_REACTION_CONTENTS as readonly string[]).includes(normalized)) {
    return normalized as GithubReactionContent;
  }

  throw new Error(
    `Unsupported GitHub reaction '${reaction}'. Supported: ${GITHUB_REACTION_CONTENTS.join(", ")}, or emoji equivalents like 👍 👀 🚀`,
  );
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

function buildDiscordUserAliasById(cfg: CoreConfig): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    const userId = rec.discord;
    if (!out.has(userId)) {
      out.set(userId, alias);
    }
  }

  return out;
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
      : inferDiscordOriginFromRequestId(ctx?.requestId)?.sessionId ??
        inferGithubOriginFromRequestId(ctx?.requestId)?.sessionId;

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
  if (inferred?.messageId) return { ...rawInput, messageId: inferred.messageId };

  const inferredGh = inferGithubOriginFromRequestId(ctx?.requestId);
  if (inferredGh?.messageId) return { ...rawInput, messageId: inferredGh.messageId };

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
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
});

const messagesSearchInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target session/channel. If omitted, defaults to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
    ),
  query: z
    .string()
    .min(1)
    .describe("Search query (full-text, session-scoped)."),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Max matches (default: 20, max: 100)"),
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
      "Target message id. If omitted, may default to the origin message when requestId encodes it (e.g. 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>').",
    ),
  reaction: z
    .string()
    .min(1)
    .describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
});

const defaultGithubApi = {
  getIssue,
  listIssueComments,
  createIssueComment,
  getIssueComment,
  editIssueComment,
  deleteIssueComment,

  createIssueReaction,
  createIssueCommentReaction,
  listIssueReactions,
  listIssueCommentReactions,
  deleteIssueReactionById,
  deleteIssueCommentReactionById,
  getGithubAppSlugOrNull,
};
export type GithubSurfaceApi = typeof defaultGithubApi;

export class Surface implements ServerTool {
  id = "surface";

  constructor(
    private readonly params: {
      adapter: SurfaceAdapter;
      githubApi?: GithubSurfaceApi;
      config?: CoreConfig;
      getConfig?: () => Promise<CoreConfig>;
      discordSearch?: DiscordSearchService;
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
        callableId: "surface.messages.search",
        name: "Surface Messages Search",
        description: "Search indexed messages in a single Discord session.",
        shortInput: zodObjectToCliLines(messagesSearchInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(messagesSearchInputSchema),
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
          "List reactions for a message with per-user details.",
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
    if (callableId === "surface.messages.search") {
      return await this.callMessagesSearch(input, opts?.context);
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
      supportedClients: ["discord", "github"] as const,
      context: {
        requestClient: ctxClient,
        sessionId: typeof ctx?.sessionId === "string" ? ctx.sessionId : null,
      },
      terminology: {
        client:
          "Surface client/platform. If the request context has a known client (LILAC_REQUEST_CLIENT), --client is optional; otherwise pass --client explicitly.",
        session:
          "A conversation container. For Discord, a session maps to a channel; for GitHub, a session maps to an issue/PR thread.",
        sessionId:
          "The CLI/session selector used by most surface.* tools. If omitted, surface tools default to the current request session (LILAC_SESSION_ID, or inferred from requestId when available).",
        messageId:
          "A platform-specific message identifier inside a session/channel. Many surface tools can default this to the origin message when requestId is 'discord:<sessionId>:<messageId>' or 'github:<OWNER/REPO#N>:<triggerId>'.",
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
                "If the request has no session context, you must pass --session-id (or set LILAC_SESSION_ID). Some requests also allow inferring sessionId/messageId from requestId when it is 'discord:<sessionId>:<messageId>'.",
              ],
            }
          : effectiveClient === "github"
          ? {
              client: "github" as const,
              accepted: [
                {
                  format: "OWNER/REPO#123",
                  meaning: "GitHub issue/PR thread",
                },
              ],
              notes: [
                "surface.sessions.list is not implemented for GitHub; use gh to discover issues/PRs.",
                "For GitHub triggers, surface tools can default sessionId/messageId from requestId when it is 'github:<OWNER/REPO#N>:<triggerId>'.",
              ],
            }
          : {
              client: effectiveClient,
              accepted: [],
              notes: [
                "Only Discord and GitHub are implemented today.",
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

  private gh(): GithubSurfaceApi {
    return this.params.githubApi ?? defaultGithubApi;
  }

  private async listGithubReactions(params: {
    thread: { owner: string; repo: string; number: number };
    sessionId: string;
    messageId: string;
  }): Promise<GithubReaction[]> {
    if (isGithubIssueTriggerId({
      sessionId: params.sessionId,
      triggerId: params.messageId,
    })) {
      return await this.gh().listIssueReactions({
        owner: params.thread.owner,
        repo: params.thread.repo,
        issueNumber: params.thread.number,
        limit: 100,
      });
    }

    const commentId = Number(params.messageId);
    if (!Number.isFinite(commentId) || commentId <= 0) {
      throw new Error(`Invalid GitHub commentId '${params.messageId}'`);
    }

    return await this.gh().listIssueCommentReactions({
      owner: params.thread.owner,
      repo: params.thread.repo,
      commentId,
      limit: 100,
    });
  }

  private async callSessionsList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = sessionsListInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    if (client === "github") {
      throw new Error(
        "surface.sessions.list is not supported for GitHub. Use `gh` to list issues/PRs and then pass `--session-id OWNER/REPO#<number>` to other surface.* tools.",
      );
    }
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

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      if (input.beforeMessageId || input.afterMessageId) {
        throw new Error(
          "surface.messages.list for GitHub does not support before/after cursors; use --limit only.",
        );
      }

      const thread = parseGithubSessionId(sessionId);
      const limit = input.limit ?? 50;
      const comments = await this.gh().listIssueComments({
        owner: thread.owner,
        repo: thread.repo,
        number: thread.number,
        limit,
      });

      const sessionRef = asGithubSessionRef(sessionId);
      return comments.map((c) => {
        const login =
          c.user && typeof c.user.login === "string" ? c.user.login : undefined;
        const id = c.user && typeof c.user.id === "number" ? c.user.id : null;

        return {
          ref: asGithubMsgRef(sessionId, String(c.id)),
          session: sessionRef,
          userId: id !== null ? String(id) : login ?? "unknown",
          userName: login,
          text: typeof c.body === "string" ? c.body : "",
          ts: parseIsoMs(c.created_at),
          editedTs: parseIsoMs(c.updated_at),
          raw: {
            htmlUrl: typeof c.html_url === "string" ? c.html_url : undefined,
          },
        };
      });
    }

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
    return messages.filter((m) => {
      if (m.session.platform !== "discord") return false;
      return shouldAllowDiscordChannel({
        cfg,
        channelId: m.session.channelId,
        guildId: m.session.guildId,
      });
    });
  }

  private async callMessagesRead(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesReadInputSchema.parse(
      withDefaultMessageId(withDefaultSessionId(rawInput, ctx), ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);

      if (isGithubIssueTriggerId({ sessionId, triggerId: messageId })) {
        const issue = await this.gh().getIssue({
          owner: thread.owner,
          repo: thread.repo,
          number: thread.number,
        });

        const login =
          issue.user && typeof issue.user.login === "string"
            ? issue.user.login
            : undefined;
        const id =
          issue.user && typeof issue.user.id === "number" ? issue.user.id : null;

        return {
          ref: asGithubMsgRef(sessionId, String(thread.number)),
          session: asGithubSessionRef(sessionId),
          userId: id !== null ? String(id) : login ?? "unknown",
          userName: login,
          text: `Title: ${issue.title}\n\n${issue.body ?? ""}`.trim(),
          ts: parseIsoMs(issue.created_at),
          editedTs: parseIsoMs(issue.updated_at),
          raw: {
            title: issue.title,
            htmlUrl: typeof issue.html_url === "string" ? issue.html_url : undefined,
          },
        };
      }

      const commentId = Number(messageId);
      if (!Number.isFinite(commentId) || commentId <= 0) {
        throw new Error(`Invalid GitHub commentId '${messageId}'`);
      }

      const c = await this.gh().getIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
      });

      const login =
        c.user && typeof c.user.login === "string" ? c.user.login : undefined;
      const id = c.user && typeof c.user.id === "number" ? c.user.id : null;

      return {
        ref: asGithubMsgRef(sessionId, String(c.id)),
        session: asGithubSessionRef(sessionId),
        userId: id !== null ? String(id) : login ?? "unknown",
        userName: login,
        text: typeof c.body === "string" ? c.body : "",
        ts: parseIsoMs(c.created_at),
        editedTs: parseIsoMs(c.updated_at),
        raw: {
          htmlUrl: typeof c.html_url === "string" ? c.html_url : undefined,
        },
      };
    }

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
      msg.session.platform !== "discord" ||
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

  private async callMessagesSearch(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesSearchInputSchema.parse(
      withDefaultSessionId(rawInput, ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      throw new Error(
        "surface.messages.search for GitHub is not supported yet.",
      );
    }

    ensureDiscordClient(client);

    const search = this.params.discordSearch;
    if (!search) {
      throw new Error(
        "surface.messages.search is unavailable: Discord search index is not initialized.",
      );
    }

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
    if (sessionRef.platform !== "discord") {
      throw new Error("surface.messages.search internal error");
    }

    const result = await search.searchSession({
      sessionRef,
      query: input.query,
      limit: input.limit,
    });

    const userAliasById = buildDiscordUserAliasById(cfg);
    const hits = result.hits.map((hit) => ({
      ...hit,
      userAlias: userAliasById.get(hit.userId),
    }));

    return {
      sessionId: channelId,
      query: input.query,
      heal: result.heal,
      hits,
    };
  }

  private async callMessagesSend(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesSendInputSchema.parse(
      withDefaultSessionId(rawInput, ctx),
    );
    const client = resolveClient({ inputClient: input.client, ctx });

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const thread = parseGithubSessionId(sessionId);

      if (input.replyToMessageId) {
        throw new Error(
          "surface.messages.send for GitHub does not support replyToMessageId; post a normal comment and link the target instead.",
        );
      }

      const paths = input.paths ?? [];
      if (paths.length > 0) {
        throw new Error(
          "surface.messages.send for GitHub does not support attachments; use gh or upload elsewhere and link.",
        );
      }

      const res = await this.gh().createIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        issueNumber: thread.number,
        body: input.text,
      });

      return { ok: true as const, ref: asGithubMsgRef(sessionId, String(res.id)) };
    }

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

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const thread = parseGithubSessionId(sessionId);

      if (isGithubIssueTriggerId({ sessionId, triggerId: input.messageId })) {
        throw new Error(
          "Editing the GitHub issue/PR body is not supported via surface.messages.edit. Use gh issue edit / gh pr edit.",
        );
      }

      const commentId = Number(input.messageId);
      if (!Number.isFinite(commentId) || commentId <= 0) {
        throw new Error(`Invalid GitHub commentId '${input.messageId}'`);
      }

      await this.gh().editIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
        body: input.text,
      });

      return { ok: true as const };
    }

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

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const thread = parseGithubSessionId(sessionId);

      if (isGithubIssueTriggerId({ sessionId, triggerId: input.messageId })) {
        throw new Error(
          "Deleting the GitHub issue/PR body is not supported via surface.messages.delete. Use gh issue delete / gh pr (if applicable).",
        );
      }

      const commentId = Number(input.messageId);
      if (!Number.isFinite(commentId) || commentId <= 0) {
        throw new Error(`Invalid GitHub commentId '${input.messageId}'`);
      }

      await this.gh().deleteIssueComment({
        owner: thread.owner,
        repo: thread.repo,
        commentId,
      });

      return { ok: true as const };
    }

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

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);

      const reactions = await this.listGithubReactions({
        thread,
        sessionId,
        messageId,
      });

      const counts = new Map<string, number>();
      for (const r of reactions) {
        counts.set(r.content, (counts.get(r.content) ?? 0) + 1);
      }

      return Array.from(counts.entries()).map(([content, count]) => ({
        emoji: githubReactionEmojiFromContent(content),
        count,
      }));
    }

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

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);

      const reactions = await this.listGithubReactions({
        thread,
        sessionId,
        messageId,
      });

      const byContent = new Map<
        string,
        { count: number; users: Array<{ userId: string; userName?: string }> }
      >();

      for (const r of reactions) {
        const entry = byContent.get(r.content) ?? { count: 0, users: [] };
        entry.count += 1;

        const login =
          r.user && typeof r.user.login === "string" ? r.user.login : undefined;
        const id = r.user && typeof r.user.id === "number" ? r.user.id : null;

        if (login || id !== null) {
          const userId = id !== null ? String(id) : login!;
          if (!entry.users.some((u) => u.userId === userId)) {
            entry.users.push({ userId, userName: login });
          }
        }

        byContent.set(r.content, entry);
      }

      const out: SurfaceReactionDetail[] = Array.from(byContent.entries()).map(
        ([content, v]) => ({
          emoji: githubReactionEmojiFromContent(content),
          count: v.count,
          users: v.users,
        }),
      );

      return out;
    }

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

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);
      const content = githubReactionContentFromInput(input.reaction);

      if (isGithubIssueTriggerId({ sessionId, triggerId: messageId })) {
        await this.gh().createIssueReaction({
          owner: thread.owner,
          repo: thread.repo,
          issueNumber: thread.number,
          content,
        });
      } else {
        const commentId = Number(messageId);
        if (!Number.isFinite(commentId) || commentId <= 0) {
          throw new Error(`Invalid GitHub commentId '${messageId}'`);
        }
        await this.gh().createIssueCommentReaction({
          owner: thread.owner,
          repo: thread.repo,
          commentId,
          content,
        });
      }

      return { ok: true as const };
    }

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

    if (client === "github") {
      const sessionId = mustPresentString(input.sessionId, "sessionId");
      const messageId = mustPresentString(input.messageId, "messageId");
      const thread = parseGithubSessionId(sessionId);
      const content = githubReactionContentFromInput(input.reaction);

      const slug = await this.gh().getGithubAppSlugOrNull();
      if (!slug) {
        throw new Error(
          "Unable to resolve GitHub App slug (required to remove reactions safely). Use gh to remove the reaction instead.",
        );
      }
      const botLogin = `${slug}[bot]`;

      const reactions = await this.listGithubReactions({
        thread,
        sessionId,
        messageId,
      });

      const mine = reactions.filter(
        (r) => r.content === content && r.user?.login === botLogin,
      );

      if (isGithubIssueTriggerId({ sessionId, triggerId: messageId })) {
        for (const r of mine) {
          await this.gh().deleteIssueReactionById({
            owner: thread.owner,
            repo: thread.repo,
            issueNumber: thread.number,
            reactionId: r.id,
          });
        }
      } else {
        const commentId = Number(messageId);
        if (!Number.isFinite(commentId) || commentId <= 0) {
          throw new Error(`Invalid GitHub commentId '${messageId}'`);
        }
        for (const r of mine) {
          await this.gh().deleteIssueCommentReactionById({
            owner: thread.owner,
            repo: thread.repo,
            commentId,
            reactionId: r.id,
          });
        }
      }

      return { ok: true as const };
    }

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
