import { AsyncLocalStorage } from "node:async_hooks";
import { DiscordPresence } from "./discord-presence";

import {
  ActivityType,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type CacheWithLimitsOptions,
  type CacheType,
  Client,
  EmbedBuilder,
  type GuildMember,
  type ChatInputCommandInteraction,
  GatewayIntentBits,
  MessageFlags,
  type MessageContextMenuCommandInteraction,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
  Options,
  PermissionFlagsBits,
  Partials,
  type Presence,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type User,
} from "discord.js";
import { z } from "zod";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import type { CoreConfig, CustomCommandArgDef } from "@stanley2058/lilac-utils";
import {
  CUSTOM_COMMAND_PROMPT_ARG_KEY,
  createLogger,
  formatTaggedErrorForLog,
  getCoreConfig,
  resolveRouterSessionConfig,
  resolveModelRefResult,
  resolveDiscordDbPath,
  resolveDiscordTokenResult,
} from "@stanley2058/lilac-utils";
import type {
  ContentOpts,
  DiscordMsgRef,
  DiscordSessionRef,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceSessionParticipant,
  SurfaceSessionParticipantsResult,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
} from "../types";
import type { AdapterEvent } from "../events";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceRateLimited,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  type SurfaceOperation,
  type SurfaceOperationError,
  type SurfaceOperationResult,
  type AdapterEventHandler,
  type AdapterSubscription,
  type SurfaceMergeBlockPlanOptions,
  type SurfaceReplyChainPlanOptions,
  type SurfaceSendPreparationInput,
  type StartOutputOpts,
  type StartTypingOpts,
  type SurfaceAdapter,
} from "../adapter";
import { settleSurfaceFallback, type SurfaceFallbackCapture } from "../adapter";
import { createDiscordEntityMapper, type EntityMapper } from "../../entity/entity-mapper";
import { DiscordSurfaceStore, type DbDiscordMessageRelation } from "../store/discord-surface-store";
import { splitByDiscordWindowOldestToNewest } from "./merge-window";
import { DiscordOutputStream, sendDiscordStyledMessage } from "./output/discord-output-stream";
import { DiscordTableImageRenderer } from "./output/discord-table-image-renderer";
import { parseCancelCustomId } from "./discord-cancel";
import { buildDiscordActionComponentsResult, parseDiscordActionCustomId } from "./discord-actions";
import {
  buildDiscordQuestionModal,
  DISCORD_QUESTION_CUSTOM_INPUT_ID,
  parseDiscordQuestionActionId,
  parseDiscordQuestionModalCustomId,
} from "./discord-question-interactions";
import { discordQuestionInteractionContent } from "./discord-question-port";
import type {
  SurfaceQuestionAnswer,
  SurfaceQuestionAnswerDisposition,
  SurfaceQuestionAnswerHandler,
  SurfaceQuestionActivity,
  SurfaceQuestionActivityHandler,
  SurfaceQuestionInteractionUpdate,
} from "../question";

const discordNotFoundErrorSchema = z
  .object({ code: z.union([z.literal(10_003), z.literal(10_008)]) })
  .loose();

function discordNotFoundCode(error: unknown): 10_003 | 10_008 | null {
  const parsed = discordNotFoundErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.code : null;
}

const discordOperationErrorSchema = z
  .object({
    code: z.number().int().optional(),
    status: z.number().int().optional(),
    retry_after: z.number().nonnegative().optional(),
    message: z.string().min(1).optional(),
  })
  .loose();

class CapturedDiscordSurfaceError extends Error {
  readonly code?: number;
  readonly status?: number;
  readonly retry_after?: number;

  constructor(message: string, fields: { code?: number; status?: number; retryAfter?: number }) {
    super(message);
    this.code = fields.code;
    this.status = fields.status;
    this.retry_after = fields.retryAfter;
  }
}

export function captureDiscordSurfaceError(cause: unknown): Error | Panic {
  if (Panic.is(cause)) return cause;
  if (cause instanceof Error) return cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "number"
      ? cause.code
      : undefined;
  const status =
    typeof cause === "object" &&
    cause !== null &&
    "status" in cause &&
    typeof cause.status === "number"
      ? cause.status
      : undefined;
  const retryAfter =
    typeof cause === "object" &&
    cause !== null &&
    "retry_after" in cause &&
    typeof cause.retry_after === "number"
      ? cause.retry_after
      : undefined;
  const message =
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
      ? cause.message
      : "Discord operation failed";
  return new CapturedDiscordSurfaceError(message, { code, status, retryAfter });
}

export function classifyDiscordSurfaceError(
  operation: SurfaceOperation,
  error: unknown,
  messageOverride?: string,
): SurfaceOperationError | null {
  if (error instanceof DiscordAdapterUnavailable) {
    return new SurfaceUnavailable({ platform: "discord", operation, message: error.message });
  }
  const parsed = discordOperationErrorSchema.safeParse(error);
  if (!parsed.success) return null;
  const { code, status, retry_after: retryAfterSeconds } = parsed.data;
  const message = messageOverride ?? parsed.data.message ?? "Discord operation failed";
  if (code === 10_003 || code === 10_008 || status === 404) {
    return new SurfaceMessageNotFound({ platform: "discord", operation, message });
  }
  if (code === 50_001 || code === 50_013 || status === 401 || status === 403) {
    return new SurfacePermissionDenied({ platform: "discord", operation, message });
  }
  if (code === 20_028 || code === 20_029 || status === 429) {
    return new SurfaceRateLimited({
      platform: "discord",
      operation,
      ...(retryAfterSeconds === undefined
        ? {}
        : { retryAfterMs: Math.ceil(retryAfterSeconds * 1000) }),
      message,
    });
  }
  if (code === 50_035 || status === 400) {
    return new SurfaceInvalidInput({
      platform: "discord",
      operation,
      field: "request",
      message,
    });
  }
  if (status !== undefined && status >= 500) {
    return new SurfaceUnavailable({ platform: "discord", operation, message });
  }
  return null;
}

const DISCORD_EMBED_DESCRIPTION_MAX_CHARS = 4096;

/** EmbedBuilder throws an untyped validation error past Discord's description limit. */
function oversizedEmbedDescription(
  operation: SurfaceOperation,
  description: string,
): SurfaceInvalidInput | null {
  if (description.length <= DISCORD_EMBED_DESCRIPTION_MAX_CHARS) return null;
  return new SurfaceInvalidInput({
    platform: "discord",
    operation,
    field: "content.text",
    message: `Discord embed text has ${description.length} characters; the limit is ${DISCORD_EMBED_DESCRIPTION_MAX_CHARS}`,
  });
}

export function classifyDiscordSurfaceNotFound(
  error: unknown,
  message = "Discord resource not found",
): SurfaceMessageNotFound | null {
  const classified = classifyDiscordSurfaceError("read-message", error, message);
  return classified instanceof SurfaceMessageNotFound ? classified : null;
}
import { buildDiscordSessionDividerText } from "./discord-session-divider";
import { formatDiscordMessageRequestId, formatDiscordSlashRequestId } from "../bridge/request-ids";
import { beginDiscordMessageLatencyTrace } from "../bridge/request-latency-trace";
import {
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
  resolveTextSendableChannel,
  shouldAllowMessage,
  tryEditOrReplyEphemeral,
  tryReplyEphemeral,
} from "./discord-channel-guards";
import {
  buildForwardMessageSnapshots,
  collectDiscordAttachmentMeta,
  getChannelName,
  getDiscordMessageTypeName,
  getDisplayName,
  getForwardSnapshotPayload,
  getMessageEditedTs,
  getMessageEmbeds,
  getMessageTs,
  getReplyReference,
  getStoredTextFromDiscordMessage,
  isDiscordChatLikeMessage,
  normalizeDiscordReference,
  previewText,
  sortSurfaceParticipants,
  toSurfaceParticipantActivities,
} from "./discord-message-meta";
import {
  resolveDiscordSurfaceEditTargetResult,
  resolveEffectiveSessionModelOverride,
} from "./discord-session-model";
import type { MarkdownTableRenderOptions } from "../../shared/markdown-table-renderer";
import type { DiscordMarkdownMathRenderOptions } from "./output/discord-markdown-math-renderer";
import {
  customCommandInvocationErrorText,
  type CustomCommandManager,
} from "../../custom-commands/manager";
import { adaptToolResultToHost } from "../../tools/tool-result-adapters";
import { getSessionMode, resolveSessionConfigId } from "./discord-request-router/common";
import type { DiscordContextReportProvider } from "./discord-context-report";

export {
  hasExplicitDiscordUserMentionInContent,
  isExplicitDiscordUserMention,
  isRoutableDiscordUserMessage,
} from "./discord-channel-guards";
export {
  resolveDiscordSurfaceEditTargetResult,
  resolveEffectiveSessionModelOverride,
} from "./discord-session-model";

export type DiscordAdapterOptions = {
  /** Dependency injection for tests. */
  config?: CoreConfig;
  getConfig?: () => Promise<CoreConfig>;
  customCommands?: CustomCommandManager;
  contextReport?: DiscordContextReportProvider;
  /** Direct Core fatal-supervisor handoff. */
  reportFatalPanic: (panic: Panic) => void;
};

export const DISCORD_CACHE_LIMITS = {
  MessageManager: 200,
  GuildMemberManager: 256,
  PresenceManager: 256,
  ThreadMemberManager: 256,
  UserManager: 2_048,
  ReactionManager: 25,
  ReactionUserManager: 0,
} as const;

export const DISCORD_CACHE_SETTINGS = {
  ...Options.DefaultMakeCacheSettings,
  GuildMemberManager: {
    maxSize: DISCORD_CACHE_LIMITS.GuildMemberManager,
    keepOverLimit: (member) => member.id === member.client.user?.id,
  },
  PresenceManager: DISCORD_CACHE_LIMITS.PresenceManager,
  ThreadMemberManager: DISCORD_CACHE_LIMITS.ThreadMemberManager,
  UserManager: DISCORD_CACHE_LIMITS.UserManager,
  ReactionManager: DISCORD_CACHE_LIMITS.ReactionManager,
  ReactionUserManager: DISCORD_CACHE_LIMITS.ReactionUserManager,
} satisfies CacheWithLimitsOptions;

type DiscordAggregateCacheSizeKey = Exclude<
  keyof typeof DISCORD_CACHE_LIMITS,
  "ReactionManager" | "ReactionUserManager"
>;

export type DiscordAdapterCacheSnapshot = {
  perManagerLimits: typeof DISCORD_CACHE_LIMITS;
  aggregateSizes: Record<DiscordAggregateCacheSizeKey, number>;
};

export type DiscordAdapterHealthSnapshot = {
  connectionState: "idle" | "connecting" | "ready" | "disconnected";
  isReady: boolean;
  readyAt?: number;
  lastDisconnectAt?: number;
  lastDisconnectCode?: number;
  lastErrorAt?: number;
  lastError?: string;
  lastResumeAt?: number;
  lastGatewayEventAt?: number;
  gatewayPingMs?: number;
  lastGatewayPingAt?: number;
  cache?: DiscordAdapterCacheSnapshot;
};

type DiscordQuestionInteractionUpdateState = "not-attempted" | "succeeded" | "failed";

type DiscordQuestionDispatchResult = {
  readonly disposition: SurfaceQuestionAnswerDisposition | "failed";
  readonly interactionUpdate: DiscordQuestionInteractionUpdateState;
};

export class DiscordAdapterUnavailable extends TaggedError("DiscordAdapterUnavailable")<{
  readonly message: string;
}> {}

export class DiscordPlatformUnsupported extends TaggedError("DiscordPlatformUnsupported")<{
  readonly platform: string;
  readonly message: string;
}> {}

export class DiscordChannelUnavailable extends TaggedError("DiscordChannelUnavailable")<{
  readonly channelId: string;
  readonly message: string;
}> {}

export class DiscordInvariantViolation extends TaggedError("DiscordInvariantViolation")<{
  readonly message: string;
}> {}

export class DiscordExternalCallFailed extends TaggedError("DiscordExternalCallFailed")<{
  readonly operation: string;
  readonly message: string;
}> {}

function selectResultValue<T, E extends Error>(result: ResultType<T, E>): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: (error) => () => adaptToolResultToHost(Result.err(error)),
  });
  return select();
}

function selectResultValueOr<T, E>(result: ResultType<T, E>, fallback: T): T {
  const select = result.match<() => T>({
    ok: (value) => () => value,
    err: () => () => fallback,
  });
  return select();
}

function discordSessionRefResult(
  operation: SurfaceOperation,
  sessionRef: SessionRef,
  refRole = "sessionRef",
): SurfaceOperationResult<DiscordSessionRef> {
  if (sessionRef.platform === "discord") return Result.ok(sessionRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "discord",
      receivedPlatform: sessionRef.platform,
      message: `Expected a Discord ${refRole}, received '${sessionRef.platform}'`,
    }),
  );
}

function discordMsgRefResult(
  operation: SurfaceOperation,
  msgRef: MsgRef,
  refRole = "msgRef",
): SurfaceOperationResult<DiscordMsgRef> {
  if (msgRef.platform === "discord") return Result.ok(msgRef);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole,
      expectedPlatform: "discord",
      receivedPlatform: msgRef.platform,
      message: `Expected a Discord ${refRole}, received '${msgRef.platform}'`,
    }),
  );
}

function discordAccentColorResult(
  operation: "send-message" | "edit-message",
  accentColor: number | undefined,
): SurfaceOperationResult<void> {
  if (
    accentColor === undefined ||
    (Number.isInteger(accentColor) && accentColor >= 0 && accentColor <= 0xffffff)
  ) {
    return Result.ok(undefined);
  }
  return Result.err(
    new SurfaceInvalidInput({
      platform: "discord",
      operation,
      field: "content.accentColor",
      message: "Discord embed accent color must be an integer from 0x000000 to 0xFFFFFF",
    }),
  );
}

function discordNestedMsgRefResult(input: {
  operation: SurfaceOperation;
  sessionRef: DiscordSessionRef;
  msgRef: MsgRef;
  refRole: string;
}): SurfaceOperationResult<DiscordMsgRef> {
  const ref = discordMsgRefResult(input.operation, input.msgRef, input.refRole);
  return ref.andThen((value) =>
    value.channelId === input.sessionRef.channelId
      ? Result.ok(value)
      : Result.err(
          new SurfaceSessionMismatch({
            operation: input.operation,
            refRole: input.refRole,
            expectedSessionId: input.sessionRef.channelId,
            receivedSessionId: value.channelId,
            message: `Discord ${input.refRole} belongs to session '${value.channelId}'`,
          }),
        ),
  );
}

function prepareDiscordSendResult(
  sessionRef: SessionRef,
  input: SurfaceSendPreparationInput,
  opts?: SendOpts,
): SurfaceOperationResult<DiscordSessionRef> {
  const discordRefResult = discordSessionRefResult("send-message", sessionRef);
  const refError = discordRefResult.match({ ok: () => null, err: (error) => error });
  if (refError) return Result.err(refError);
  const discordRef = selectResultValue(discordRefResult);
  if (opts?.replyTo) {
    const nestedRef = discordNestedMsgRefResult({
      operation: "send-message",
      sessionRef: discordRef,
      msgRef: opts.replyTo,
      refRole: "replyTo",
    });
    const nestedRefError = nestedRef.match({ ok: () => null, err: (error) => error });
    if (nestedRefError) return Result.err(nestedRefError);
  }
  const hasText = Boolean(input.text?.trim());
  if (!hasText && input.attachmentCount === 0 && input.actionCount === 0) {
    return Result.err(
      new SurfaceInvalidInput({
        platform: "discord",
        operation: "send-message",
        field: "content",
        message: "Discord message content must include text, an attachment, or an action",
      }),
    );
  }
  return Result.ok(discordRef);
}

async function captureDiscordOperation<T>(
  operation: SurfaceOperation,
  effect: () => Promise<T>,
): Promise<SurfaceOperationResult<T>> {
  {
    const attempt = await Result.tryPromise({
      try: async () => {
        return Result.ok(await effect());
      },
      catch: (cause) => ({ restoreCause: () => cause }),
    });

    if (attempt.isErr()) {
      const cause = attempt.error.restoreCause();
      if (Panic.is(cause)) throw cause;
      const classified = classifyDiscordSurfaceError(operation, cause);
      if (classified) return Result.err(classified);
      throw cause;
    }
    return attempt.value;
  }
}

function externalCallFailure(operation: string): DiscordExternalCallFailed {
  return new DiscordExternalCallFailed({
    operation,
    message: `Discord SDK call failed: ${operation}`,
  });
}

function captureNullSurfaceFallback(cause: unknown): SurfaceFallbackCapture<null> {
  return Panic.is(cause)
    ? { kind: "panic", panic: cause, fallback: null }
    : { kind: "fallback", fallback: null };
}

function captureUndefinedSurfaceFallback(cause: unknown): SurfaceFallbackCapture<undefined> {
  return Panic.is(cause)
    ? { kind: "panic", panic: cause, fallback: undefined }
    : { kind: "fallback", fallback: undefined };
}

function asDiscordSessionRef(input: {
  channelId: string;
  guildId?: string | null;
  parentChannelId?: string | null;
}): SessionRef {
  return {
    platform: "discord",
    channelId: input.channelId,
    guildId: input.guildId ?? undefined,
    parentChannelId: input.parentChannelId ?? undefined,
  };
}

function asDiscordMsgRef(channelId: string, messageId: string): MsgRef {
  return { platform: "discord", channelId, messageId };
}

function resolveMarkdownTableRenderOptions(
  cfg: CoreConfig | null | undefined,
): MarkdownTableRenderOptions | undefined {
  const tableRender = cfg?.surface.discord.markdownTableRender;
  if (!tableRender || tableRender.enabled !== true) {
    return undefined;
  }

  return {
    style: tableRender.style ?? "unicode",
    maxWidth: tableRender.maxWidth ?? 80,
    fallbackMode: tableRender.fallbackMode ?? "list",
  };
}

function resolveMarkdownMathRenderOptions(
  cfg: CoreConfig | null | undefined,
): DiscordMarkdownMathRenderOptions | undefined {
  const mathRender = cfg?.surface.discord.markdownMathRender;
  if (!mathRender || mathRender.enabled !== true) {
    return undefined;
  }

  return {
    maxWidth: mathRender.maxWidth,
    fallbackMode: mathRender.fallbackMode,
  };
}

export function resolveOutputNotificationEnabled(input: {
  configured?: boolean;
  silent?: boolean;
}): boolean {
  if (input.silent === true) return false;
  if (typeof input.configured === "boolean") return input.configured;
  return true;
}

function getLatestGatewayPingAt(client: Client): number | undefined {
  let latestGatewayPingAt: number | undefined;
  for (const shard of client.ws.shards.values()) {
    if (!Number.isFinite(shard.lastPingTimestamp) || shard.lastPingTimestamp < 0) {
      continue;
    }
    latestGatewayPingAt =
      latestGatewayPingAt === undefined
        ? shard.lastPingTimestamp
        : Math.max(latestGatewayPingAt, shard.lastPingTimestamp);
  }
  return latestGatewayPingAt;
}

function getDiscordCacheSnapshot(client: Client | null): DiscordAdapterCacheSnapshot {
  const aggregateSizes: DiscordAdapterCacheSnapshot["aggregateSizes"] = {
    MessageManager: 0,
    GuildMemberManager: 0,
    PresenceManager: 0,
    ThreadMemberManager: 0,
    UserManager: client?.users.cache.size ?? 0,
  };

  if (client) {
    for (const guild of client.guilds.cache.values()) {
      aggregateSizes.GuildMemberManager += guild.members.cache.size;
      aggregateSizes.PresenceManager += guild.presences.cache.size;
    }

    for (const channel of client.channels.cache.values()) {
      if ("isThread" in channel && channel.isThread()) {
        aggregateSizes.ThreadMemberManager += channel.members.cache.size;
      }
      if (!("messages" in channel)) continue;
      aggregateSizes.MessageManager += channel.messages.cache.size;
    }
  }

  return {
    perManagerLimits: { ...DISCORD_CACHE_LIMITS },
    aggregateSizes,
  };
}

function compareDiscordSnowflake(a: string, b: string): number {
  // Prefer numeric comparison (snowflakes are numeric strings).
  // Fall back to localeCompare if parsing fails.
  if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  }
  return a.localeCompare(b);
}

const CONTEXT_MENU_CANCEL_REQUEST_NAME = "Cancel Request";

const DISCORD_BOT_INVITE_SCOPES = "bot applications.commands";
const DISCORD_STANDARD_INVITE_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.UseExternalEmojis;

function buildDiscordBotInviteUrl(input: { clientId: string; permissions: bigint }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    scope: DISCORD_BOT_INVITE_SCOPES,
    permissions: input.permissions.toString(),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function buildDiscordSlashOption(arg: CustomCommandArgDef) {
  if (arg.type === "number") {
    return {
      type: ApplicationCommandOptionType.Number as const,
      name: arg.key,
      description: arg.description ?? arg.key,
      required: arg.required ?? false,
    };
  }
  if (arg.type === "boolean") {
    return {
      type: ApplicationCommandOptionType.Boolean as const,
      name: arg.key,
      description: arg.description ?? arg.key,
      required: arg.required ?? false,
    };
  }
  return {
    type: ApplicationCommandOptionType.String as const,
    name: arg.key,
    description: arg.description ?? arg.key,
    required: arg.required ?? false,
    ...(arg.choices?.length
      ? {
          choices: arg.choices.slice(0, 25).map((choice) => ({
            name: choice,
            value: choice,
          })),
        }
      : {}),
  };
}

function readDiscordSlashOption(
  interaction: ChatInputCommandInteraction<CacheType>,
  arg: CustomCommandArgDef,
): string | number | boolean | null {
  switch (arg.type) {
    case "string":
      return interaction.options.getString(arg.key);
    case "number":
      return interaction.options.getNumber(arg.key);
    case "boolean":
      return interaction.options.getBoolean(arg.key);
  }
}

function resolveDiscordSessionKind(
  isDm: boolean,
  parentChannelId: string | null,
): "channel" | "thread" | "dm" {
  if (isDm) return "dm";
  return parentChannelId ? "thread" : "channel";
}

export class DiscordAdapter implements SurfaceAdapter {
  private readonly tableImageRenderer = new DiscordTableImageRenderer();
  private client: Client | null = null;
  private store: DiscordSurfaceStore | null = null;
  private cfg: CoreConfig | null = null;
  private entityMapper: EntityMapper | null = null;
  private coreConfigReloadHadError = false;
  private lastCoreConfigReloadError: string | null = null;
  private handlers = new Set<AdapterEventHandler>();
  private questionHandlers = new Set<{
    readonly answer: SurfaceQuestionAnswerHandler<"discord">;
    readonly activity: SurfaceQuestionActivityHandler<"discord">;
  }>();
  private sessionModelOverrides = new Map<string, string>();
  private readonly requestReadSnapshots = new AsyncLocalStorage<
    Map<string, Promise<Message | null>>
  >();

  private readonly logger = createLogger({
    module: "surface:discord",
  });

  private self: SurfaceSelf | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  readonly presence = new DiscordPresence(() => {
    this.superviseDiscordCallback("presence-activity", () => this.applyConfiguredPresence());
  });
  private appliedPresenceStatus: "online" | "idle" | undefined;
  private appliedStatusMessage: string | null | undefined;
  private healthState: Omit<DiscordAdapterHealthSnapshot, "cache"> = {
    connectionState: "idle",
    isReady: false,
  };

  constructor(private readonly opts: DiscordAdapterOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    this.healthState = {
      connectionState: "connecting",
      isReady: false,
    };

    const cfg = this.opts?.config ?? (await this.resolveCoreConfig());
    this.cfg = cfg;

    this.logger.debug("connecting", {
      botName: cfg.surface.discord.botName,
      tokenEnv: cfg.surface.discord.tokenEnv,
      allowedChannelIds: cfg.surface.discord.allowedChannelIds.length,
      allowedGuildIds: cfg.surface.discord.allowedGuildIds.length,
    });

    const dbPath = resolveDiscordDbPath(cfg);
    this.store = new DiscordSurfaceStore(dbPath);
    this.entityMapper = createDiscordEntityMapper({ cfg, store: this.store });

    this.logger.debug("discord store initialized", { dbPath });

    const tokenResult = resolveDiscordTokenResult(cfg);
    const token = tokenResult.match({
      ok: (value) => () => value,
      err: (error) => () => {
        switch (error._tag) {
          case "DiscordTokenMissing":
            throw error;
        }
      },
    })();

    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ];

    if (cfg.surface.discord.memberPresence === true) {
      intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences);
    }

    const client = new Client({
      intents,
      partials: [
        Partials.User,
        Partials.GuildMember,
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
        Partials.ThreadMember,
      ],
      makeCache: Options.cacheWithLimits(DISCORD_CACHE_SETTINGS),
    });

    client.on("clientReady", () => {
      this.superviseDiscordCallback("clientReady", async () => {
        const user = client.user;
        if (!user) return;

        const botName = cfg.surface.discord.botName;

        this.self = {
          platform: "discord",
          userId: user.id,
          userName: botName,
        };

        this.store?.upsertUserName({
          userId: user.id,
          username: botName,
          globalName: botName,
          displayName: botName,
          updatedTs: Date.now(),
        });

        this.logger.info("ready", {
          userId: user.id,
          botName,
        });
        this.noteGatewayEvent("ready");
        this.healthState = {
          ...this.healthState,
          connectionState: "ready",
          isReady: true,
          readyAt: Date.now(),
          lastDisconnectAt: undefined,
          lastDisconnectCode: undefined,
        };
        this.refreshGatewayPing(client);

        const applicationId = client.application?.id ?? user.id;
        this.logger.info(
          buildDiscordBotInviteUrl({
            clientId: applicationId,
            permissions: DISCORD_STANDARD_INVITE_PERMISSIONS,
          }),
        );
        this.logger.info(
          buildDiscordBotInviteUrl({
            clientId: applicationId,
            permissions: PermissionFlagsBits.Administrator,
          }),
        );

        this.presence.start();
        this.applyConfiguredPresence({ client, force: true });

        // Register/refresh slash commands on boot.
        // Strategy:
        // 1) check existence
        // 2) ALWAYS update if exists
        // 3) register if not exist
        // This avoids stale command definitions when iterating.
        const registered = settleSurfaceFallback(
          await Result.tryPromise({
            try: () => this.registerSlashCommands(),
            catch: (cause) => {
              const fallback = externalCallFailure("register-slash-commands");
              return Panic.is(cause)
                ? { kind: "panic", panic: cause, fallback }
                : { kind: "fallback", fallback };
            },
          }),
        );
        registered.match({
          ok: () => undefined,
          err: (error) => {
            this.logger.error("slash command registration failed", {
              ...formatTaggedErrorForLog(error),
            });
          },
        });

        // Discord can clear custom presence over time; refresh periodically.
        this.presenceTimer = setInterval(
          () => {
            this.superviseDiscordCallback("presence-refresh", () => {
              this.applyConfiguredPresence({ client, force: true });
            });
          },
          30 * 60 * 1000,
        );
      });
    });

    client.on("shardReady", () => {
      this.noteGatewayEvent("shardReady");
      this.healthState = {
        ...this.healthState,
        connectionState: "ready",
        isReady: true,
        readyAt: this.healthState.readyAt ?? Date.now(),
      };
      this.refreshGatewayPing(client);
    });

    client.on("shardResume", () => {
      this.noteGatewayEvent("shardResume");
      this.healthState = {
        ...this.healthState,
        connectionState: "ready",
        isReady: true,
        lastResumeAt: Date.now(),
      };
      this.refreshGatewayPing(client);
    });

    client.on("shardDisconnect", (event) => {
      this.noteGatewayEvent("shardDisconnect");
      this.healthState = {
        ...this.healthState,
        connectionState: "disconnected",
        isReady: false,
        lastDisconnectAt: Date.now(),
        lastDisconnectCode: typeof event?.code === "number" ? event.code : undefined,
      };
    });

    client.on("shardError", (error) => {
      this.noteGatewayEvent("shardError");
      this.healthState = {
        ...this.healthState,
        lastErrorAt: Date.now(),
        lastError: error instanceof Error ? error.message : String(error),
      };
    });

    client.on("invalidated", () => {
      this.noteGatewayEvent("invalidated");
      this.healthState = {
        ...this.healthState,
        connectionState: "disconnected",
        isReady: false,
        lastDisconnectAt: Date.now(),
        lastErrorAt: Date.now(),
        lastError: "Gateway session invalidated",
      };
    });

    client.on("raw", () => {
      this.noteGatewayEvent("raw");
      this.refreshGatewayPing(client);
    });

    client.on("messageCreate", (msg) => {
      const receivedAt = Date.now();
      this.superviseDiscordCallback("messageCreate", () => this.onMessageCreate(msg, receivedAt));
    });

    client.on("messageUpdate", (_old, next) => {
      this.superviseDiscordCallback("messageUpdate", async () => {
        const fetched = next.partial
          ? settleSurfaceFallback(
              await Result.tryPromise({
                try: () => next.fetch(),
                catch: captureNullSurfaceFallback,
              }),
            )
          : Result.ok(next);
        const msg = selectResultValueOr(fetched, null);
        if (!msg) return;
        await this.onMessageUpdate(msg);
      });
    });

    client.on("messageDelete", (deleted) => {
      this.superviseDiscordCallback("messageDelete", async () => {
        const fetched = deleted.partial
          ? settleSurfaceFallback(
              await Result.tryPromise({
                try: () => deleted.fetch(),
                catch: captureNullSurfaceFallback,
              }),
            )
          : Result.ok(deleted);
        const msg = selectResultValueOr(fetched, null);
        await this.onMessageDelete(msg, deleted.id, deleted.channelId);
      });
    });

    client.on("messageReactionAdd", (reaction, user) => {
      this.superviseDiscordCallback("messageReactionAdd", async () => {
        const fetched = reaction.partial
          ? settleSurfaceFallback(
              await Result.tryPromise({
                try: () => reaction.fetch(),
                catch: captureNullSurfaceFallback,
              }),
            )
          : Result.ok(reaction);
        const r = selectResultValueOr(fetched, null);
        if (!r) return;
        await this.onReactionAdd(
          r.message,
          r.emoji.toString(),
          user?.id,
          user?.username ?? undefined,
        );
      });
    });

    client.on("messageReactionRemove", (reaction, user) => {
      this.superviseDiscordCallback("messageReactionRemove", async () => {
        const fetched = reaction.partial
          ? settleSurfaceFallback(
              await Result.tryPromise({
                try: () => reaction.fetch(),
                catch: captureNullSurfaceFallback,
              }),
            )
          : Result.ok(reaction);
        const r = selectResultValueOr(fetched, null);
        if (!r) return;
        await this.onReactionRemove(
          r.message,
          r.emoji.toString(),
          user?.id,
          user?.username ?? undefined,
        );
      });
    });

    client.on("interactionCreate", (interaction) => {
      this.superviseDiscordCallback("interactionCreate", () =>
        this.onInteractionCreate(interaction),
      );
    });

    const loggedIn = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => client.login(token),
        catch: (cause) => {
          const fallback = externalCallFailure("client.login");
          return Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback }
            : { kind: "fallback", fallback };
        },
      }),
    );
    loggedIn.match({
      ok: () => () => undefined,
      err: (error) => () => {
        throw error;
      },
    })();

    this.logger.debug("login ok");

    this.client = client;
    await this.tableImageRenderer.setEnabled(
      resolveMarkdownTableRenderOptions(cfg)?.style === "image",
    );
  }

  async disconnect(): Promise<void> {
    this.logger.info("disconnecting");
    this.presence.stop();

    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    const c = this.client;
    this.client = null;
    const store = this.store;
    this.store = null;
    this.entityMapper = null;

    const [destroyed, rendererClosed] = await Promise.allSettled([
      Promise.resolve().then(() => c?.destroy()),
      this.tableImageRenderer.close(),
    ]);
    const [closed] = await Promise.allSettled([Promise.resolve().then(() => store?.close())]);
    this.healthState = {
      ...this.healthState,
      connectionState: "disconnected",
      isReady: false,
      lastDisconnectAt: Date.now(),
    };

    this.logger.info("disconnected");

    if (destroyed?.status === "rejected" && Panic.is(destroyed.reason)) {
      throw destroyed.reason;
    }
    if (rendererClosed?.status === "rejected" && Panic.is(rendererClosed.reason)) {
      throw rendererClosed.reason;
    }
    if (closed?.status === "rejected") {
      const failure =
        closed.reason instanceof Error ? closed.reason : externalCallFailure("surface-store.close");
      throw failure;
    }
  }

  getHealthSnapshot(options: { includeCache?: boolean } = {}): DiscordAdapterHealthSnapshot {
    if (this.client) {
      this.refreshGatewayPing(this.client);
    }
    return {
      ...this.healthState,
      ...(options.includeCache ? { cache: getDiscordCacheSnapshot(this.client) } : {}),
    };
  }

  async refreshCoreConfig(): Promise<void> {
    await this.reloadCoreConfigIfNeeded();
  }

  async getSelf(): Promise<SurfaceSelf> {
    if (this.self) return this.self;
    if (!this.client?.user || !this.cfg) {
      throw new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" });
    }
    return {
      platform: "discord",
      userId: this.client.user.id,
      userName: this.cfg.surface.discord.botName,
    };
  }

  async listSessions(opts?: { limit?: number }): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    const storeResult = this.storeResult();
    const storeError = storeResult.match({ ok: () => null, err: (error) => error });
    if (storeError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-sessions",
          message: storeError.message,
        }),
      );
    }
    const store = selectResultValue(storeResult);
    const sessions = store.listSessions(opts?.limit);
    return Result.ok(
      sessions.map((s) => ({
        ref: asDiscordSessionRef({
          channelId: s.channel_id,
          guildId: s.guild_id,
          parentChannelId: s.parent_channel_id,
        }),
        title: s.name ?? undefined,
        updatedAt: s.activity_ts,
        kind: s.type,
      })),
    );
  }

  private async reloadCoreConfigIfNeeded(
    options: { readonly applyPresence?: boolean } = {},
  ): Promise<void> {
    if (this.opts?.config) return;

    const loaded = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => this.resolveCoreConfig(),
        catch: (cause) => {
          const fallback = externalCallFailure("load-core-config");
          return Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback }
            : { kind: "fallback", fallback };
        },
      }),
    );
    loaded.match({
      ok: (cfg) => {
        this.cfg = cfg;
        if (options.applyPresence !== false) this.applyConfiguredPresence();

        if (this.coreConfigReloadHadError) {
          this.logger.info("core-config reload recovered", {
            path: "core-config.yaml",
          });
        }

        this.coreConfigReloadHadError = false;
        this.lastCoreConfigReloadError = null;
      },
      err: (error) => {
        const msg = formatTaggedErrorForLog(error).errorMessage;
        if (!this.coreConfigReloadHadError || this.lastCoreConfigReloadError !== msg) {
          this.logger.warn("core-config reload failed; using last known config", {
            path: "core-config.yaml",
            error: msg,
          });
        }

        this.coreConfigReloadHadError = true;
        this.lastCoreConfigReloadError = msg;
      },
    });
    if (this.client) {
      await this.tableImageRenderer.setEnabled(
        resolveMarkdownTableRenderOptions(this.cfg)?.style === "image",
      );
    }
  }

  private async resolveCoreConfig(): Promise<CoreConfig> {
    return this.opts?.getConfig ? this.opts.getConfig() : getCoreConfig();
  }

  private applyConfiguredPresence(input: { client?: Client; force?: boolean } = {}): void {
    const client = input.client ?? this.client;
    if (!client?.user || !this.cfg) return;
    const user = client.user;

    const statusMessage = this.cfg.surface.discord.statusMessage?.trim() || null;
    const status = this.presence.status;
    if (
      !input.force &&
      this.appliedStatusMessage === statusMessage &&
      this.appliedPresenceStatus === status
    )
      return;

    const applied = settleSurfaceFallback(
      Result.try({
        try: () => {
          if (statusMessage) {
            user.setPresence({
              activities: [
                {
                  name: statusMessage,
                  state: statusMessage,
                  type: ActivityType.Custom,
                },
              ],
              status,
            });
          } else {
            user.setPresence({ activities: [], status });
          }
          this.appliedStatusMessage = statusMessage;
          this.appliedPresenceStatus = status;
        },
        catch: captureUndefinedSurfaceFallback,
      }),
    );
    void applied;
  }

  async burstCache(input: {
    msgRef?: MsgRef;
    sessionRef?: SessionRef;
    reason: "surface_tool" | "other";
  }): Promise<void> {
    void input.reason;

    const client = this.client;
    if (!client) return;

    const fromMsg =
      input.msgRef && input.msgRef.platform === "discord" ? input.msgRef.channelId : null;
    const fromSession =
      input.sessionRef && input.sessionRef.platform === "discord"
        ? input.sessionRef.channelId
        : null;
    const channelId = fromMsg ?? fromSession;
    if (!channelId) return;

    const fetched = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => client.channels.fetch(channelId),
        catch: captureNullSurfaceFallback,
      }),
    );
    const ch = client.channels.cache.get(channelId) ?? selectResultValueOr(fetched, null);
    if (!ch || !("messages" in ch) || !ch.messages?.cache) return;

    if (input.msgRef && input.msgRef.platform === "discord") {
      const cached = ch.messages.cache.get(input.msgRef.messageId);
      if (cached) {
        for (const r of cached.reactions.cache.values()) {
          r.users.cache.clear();
        }
        cached.reactions.cache.clear();
      }
      ch.messages.cache.delete(input.msgRef.messageId);
      return;
    }

    // "Latest view" reads generally want a fresh channel snapshot.
    ch.messages.cache.clear();
  }

  withRequestReadScope<T>(run: () => Promise<T>): Promise<T> {
    if (this.requestReadSnapshots.getStore()) return run();
    return this.requestReadSnapshots.run(new Map(), run);
  }

  /** Lightweight Discord API fetch to get a channel's guildId (no history). */
  async fetchGuildIdForChannel(channelId: string): Promise<string | null> {
    const client = this.client;
    if (!client) {
      throw new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" });
    }

    const fetched = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => client.channels.fetch(channelId),
        catch: captureNullSurfaceFallback,
      }),
    );
    const ch = selectResultValueOr(fetched, null);
    if (!ch) return null;

    return ch && "guildId" in ch ? ch.guildId : null;
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<import("../adapter").SurfaceOutputStream>> {
    const refResult = discordSessionRefResult("start-output", sessionRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const discordRef = selectResultValue(refResult);
    if (opts?.replyTo) {
      const reply = discordNestedMsgRefResult({
        operation: "start-output",
        sessionRef: discordRef,
        msgRef: opts.replyTo,
        refRole: "replyTo",
      });
      const replyError = reply.match({ ok: () => null, err: (error) => error });
      if (replyError) return Result.err(replyError);
    }
    if (opts?.resumeAt) {
      const resume = discordNestedMsgRefResult({
        operation: "start-output",
        sessionRef: discordRef,
        msgRef: opts.resumeAt,
        refRole: "resumeAt",
      });
      const resumeError = resume.match({ ok: () => null, err: (error) => error });
      if (resumeError) return Result.err(resumeError);
    }
    const cfg = this.cfg;
    const clientResult = this.clientResult();
    const clientError = clientResult.match({ ok: () => null, err: (error) => error });
    if (clientError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "start-output",
          message: clientError.message,
        }),
      );
    }
    const client = selectResultValue(clientResult);
    if (!cfg) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "start-output",
          message: "DiscordAdapter not connected",
        }),
      );
    }
    const markdownTableRender = resolveMarkdownTableRenderOptions(cfg);
    const markdownMathRender = resolveMarkdownMathRenderOptions(cfg);

    // TODO: plumb config for smart splitting.
    const useSmartSplitting = true;

    return Result.ok(
      new DiscordOutputStream({
        client,
        sessionRef: discordRef,
        opts,
        useSmartSplitting,
        rewriteText: this.entityMapper?.rewriteOutgoingText,
        markdownTableRender,
        renderTableImages: this.tableImageRenderer.render,
        markdownMathRender,
        reasoningDisplayMode: cfg.agent.reasoningDisplay ?? "simple",
        outputMode: cfg.surface.discord.outputMode ?? "inline",
        outputPreviewModeFinalStyle: cfg.surface.discord.outputPreviewModeFinalStyle ?? "embed",
        outputPreviewModeFinalText: cfg.surface.discord.outputPreviewModeFinalText ?? "reply-chain",
        outputNotification: resolveOutputNotificationEnabled({
          configured: cfg.surface.discord.outputNotification,
          silent: opts?.silent,
        }),
        workingIndicators: cfg.surface.discord.workingIndicators ?? ["Working"],
      }),
    );
  }

  async startTyping(
    sessionRef: SessionRef,
    opts?: StartTypingOpts,
  ): Promise<SurfaceOperationResult<import("../adapter").TypingIndicatorSubscription>> {
    const refResult = discordSessionRefResult("start-typing", sessionRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const clientResult = this.clientResult();
    const clientError = clientResult.match({ ok: () => null, err: (error) => error });
    if (clientError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "start-typing",
          message: clientError.message,
        }),
      );
    }
    const client = selectResultValue(clientResult);
    const discordRef = selectResultValue(refResult);

    // Discord typing indicators last ~10s; refresh a bit earlier.
    const REFRESH_MS = 8000;

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    // Typing is cosmetic; keep Discord REST latency out of relay startup.
    this.superviseDiscordCallback("typing-indicator-start", async () => {
      const fetched = await captureDiscordOperation("start-typing", () =>
        client.channels.fetch(discordRef.channelId),
      );
      const fetchError = fetched.match({ ok: () => null, err: (error) => error });
      if (fetchError) {
        this.logger.warn(
          "surface typing indicator unavailable",
          formatTaggedErrorForLog(fetchError),
        );
        return;
      }
      if (stopped) return;

      const ch = selectResultValue(fetched);
      const sendTyping = ch && "sendTyping" in ch ? ch.sendTyping : null;
      if (!sendTyping) {
        this.logger.warn("surface typing indicator unavailable", {
          channelId: discordRef.channelId,
          reason: "channel_cannot_send_typing",
        });
        return;
      }

      let consecutiveFailures = 0;
      const tick = async () => {
        if (stopped) return;
        const sent = settleSurfaceFallback(
          await Result.tryPromise({
            try: () => sendTyping.call(ch),
            catch: (cause) => {
              const fallback = externalCallFailure("channel.sendTyping");
              return Panic.is(cause)
                ? { kind: "panic", panic: cause, fallback }
                : { kind: "fallback", fallback };
            },
          }),
        );
        sent.match({
          ok: () => {
            consecutiveFailures = 0;
          },
          err: () => {
            consecutiveFailures += 1;
            if (consecutiveFailures >= 3) stop();
          },
        });
      };

      const initial = await captureDiscordOperation("start-typing", () => sendTyping.call(ch));
      const initialError = initial.match({ ok: () => null, err: (error) => error });
      if (initialError) {
        this.logger.warn(
          "surface typing indicator unavailable",
          formatTaggedErrorForLog(initialError),
        );
        return;
      }
      opts?.onStarted?.();
      if (stopped) return;
      timer = setInterval(() => {
        this.superviseDiscordCallback("typing-indicator", tick);
      }, REFRESH_MS);
    });

    return Result.ok({
      stop: async () => {
        stop();
        return Result.ok(undefined);
      },
    });
  }

  async prepareSendMsg(
    sessionRef: SessionRef,
    input: SurfaceSendPreparationInput,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<void>> {
    const prepared = prepareDiscordSendResult(sessionRef, input, opts);
    return prepared.map(() => undefined);
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    const color = discordAccentColorResult("send-message", content.accentColor);
    const colorError = color.match({ ok: () => null, err: (error) => error });
    if (colorError) return Result.err(colorError);
    const prepared = prepareDiscordSendResult(
      sessionRef,
      {
        text: content.text,
        attachmentCount: content.attachments?.length ?? 0,
        actionCount: content.actions?.length ?? 0,
      },
      opts,
    );
    const prepareError = prepared.match({ ok: () => null, err: (error) => error });
    if (prepareError) return Result.err(prepareError);
    const discordRef = selectResultValue(prepared);
    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    const clientResult = this.clientResult();
    const clientError = clientResult.match({ ok: () => null, err: (error) => error });
    if (clientError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "send-message",
          message: clientError.message,
        }),
      );
    }
    const client = selectResultValue(clientResult);
    const markdownTableRender = resolveMarkdownTableRenderOptions(cfg);
    const markdownMathRender = resolveMarkdownMathRenderOptions(cfg);

    const useSmartSplitting = true;

    if (content.actions && content.actions.length > 0) {
      const fetched = await captureDiscordOperation("send-message", () =>
        client.channels.fetch(discordRef.channelId),
      );
      const fetchError = fetched.match({ ok: () => null, err: (error) => error });
      if (fetchError) return Result.err(fetchError);
      const channel = selectResultValue(fetched);
      if (!channel || !("send" in channel)) {
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "discord",
            operation: "send-message",
            message: `Discord channel not found: ${discordRef.channelId}`,
          }),
        );
      }
      const components = buildDiscordActionComponentsResult(content.actions);
      const componentError = components.match({ ok: () => null, err: (error) => error });
      if (componentError) {
        return Result.err(
          new SurfaceInvalidInput({
            platform: "discord",
            operation: "send-message",
            field: "content.actions",
            message: componentError.message,
          }),
        );
      }
      const text = this.entityMapper?.rewriteOutgoingText(content.text ?? "") ?? content.text ?? "";
      const oversized = oversizedEmbedDescription("send-message", text);
      if (oversized) return Result.err(oversized);
      const embed = new EmbedBuilder().setDescription(text || "*<empty_string>*");
      if (content.accentColor !== undefined) embed.setColor(content.accentColor);
      const sent = await captureDiscordOperation("send-message", async () =>
        channel.send({
          embeds: [embed],
          components: selectResultValue(components),
          files: content.attachments?.map((attachment) => ({
            attachment: Buffer.from(attachment.bytes),
            name: attachment.filename,
          })),
          reply:
            opts?.replyTo?.platform === "discord"
              ? { messageReference: opts.replyTo.messageId }
              : undefined,
          allowedMentions: {
            parse: [],
            repliedUser: opts?.notifyReply === true && opts.silent !== true,
          },
        }),
      );
      return sent.map((message) => asDiscordMsgRef(discordRef.channelId, message.id));
    }

    return await sendDiscordStyledMessage({
      client,
      sessionRef: discordRef,
      content,
      opts: opts?.replyTo ? { replyTo: opts.replyTo } : undefined,
      useSmartSplitting,
      rewriteText: this.entityMapper?.rewriteOutgoingText,
      markdownTableRender,
      markdownMathRender,
      outputNotification: resolveOutputNotificationEnabled({
        configured: cfg?.surface.discord.outputNotification,
        silent: opts?.silent,
      }),
    });
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    const refResult = discordMsgRefResult("read-message", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const discordRef = selectResultValue(refResult);

    const fetched = await captureDiscordOperation("read-message", () =>
      this.fetchRequestScopedDiscordMessage({
        channelId: discordRef.channelId,
        messageId: discordRef.messageId,
      }),
    );
    const fetchError = fetched.match({ ok: () => null, err: (error) => error });
    if (fetchError) return Result.err(fetchError);
    const msg = selectResultValue(fetched);

    if (!msg) return Result.ok(null);

    const projected = this.toSurfaceMessageFromDiscordMessageResult(msg);
    const projectionError = projected.match({ ok: () => null, err: (error) => error });
    if (projectionError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "read-message",
          message: projectionError.message,
        }),
      );
    }
    return Result.ok(selectResultValue(projected));
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const refResult = discordSessionRefResult("list-messages", sessionRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const discordRef = selectResultValue(refResult);

    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));

    const listed = await captureDiscordOperation("list-messages", () =>
      this.fetchDiscordMessages({
        channelId: discordRef.channelId,
        limit,
        beforeMessageId: opts?.beforeMessageId,
        afterMessageId: opts?.afterMessageId,
      }),
    );
    const listError = listed.match({ ok: () => null, err: (error) => error });
    if (listError) return Result.err(listError);
    const messages = selectResultValue(listed);

    const projected: SurfaceMessage[] = [];
    for (const message of messages) {
      const result = this.toSurfaceMessageFromDiscordMessageResult(message);
      const projectionError = result.match({ ok: () => null, err: (error) => error });
      if (projectionError) {
        return Result.err(
          new SurfaceUnavailable({
            platform: "discord",
            operation: "list-messages",
            message: projectionError.message,
          }),
        );
      }
      projected.push(selectResultValue(result));
    }
    return Result.ok(projected);
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    const color = discordAccentColorResult("edit-message", content.accentColor);
    const colorError = color.match({ ok: () => null, err: (error) => error });
    if (colorError) return Result.err(colorError);
    const refResult = discordMsgRefResult("edit-message", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const clientResult = this.clientResult();
    const clientError = clientResult.match({ ok: () => null, err: (error) => error });
    if (clientError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "edit-message",
          message: clientError.message,
        }),
      );
    }
    const client = selectResultValue(clientResult);
    const discordRef = selectResultValue(refResult);
    if (!client.user) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "edit-message",
          message: "Discord client user is unavailable",
        }),
      );
    }

    const channelResult = await captureDiscordOperation("edit-message", () =>
      client.channels.fetch(discordRef.channelId),
    );
    const channelError = channelResult.match({ ok: () => null, err: (error) => error });
    if (channelError) return Result.err(channelError);
    const channel = selectResultValue(channelResult);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "edit-message",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }

    // Gateway updates keep cached messages current, so only a cache miss needs a REST read.
    const messageResult = await captureDiscordOperation("edit-message", () =>
      channel.messages.fetch({ message: discordRef.messageId }),
    );
    const messageError = messageResult.match({ ok: () => null, err: (error) => error });
    if (messageError) return Result.err(messageError);
    const msg = selectResultValue(messageResult);

    const raw = content.text ?? "";
    const rewritten = this.entityMapper?.rewriteOutgoingText(raw) ?? raw;
    const editTarget = resolveDiscordSurfaceEditTargetResult({
      authorId: msg.author?.id,
      selfUserId: client.user.id,
      embedCount: msg.embeds.length,
      content: msg.content,
    });
    const editTargetError = editTarget.match({ ok: () => null, err: (error) => error });
    if (editTargetError) {
      return Result.err(
        new SurfacePermissionDenied({
          platform: "discord",
          operation: "edit-message",
          message: editTargetError.message,
        }),
      );
    }

    const componentsResult =
      content.actions === undefined
        ? undefined
        : buildDiscordActionComponentsResult(content.actions);
    const componentError = componentsResult?.match({ ok: () => null, err: (error) => error });
    if (componentError) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "edit-message",
          field: "content.actions",
          message: componentError.message,
        }),
      );
    }
    const components = componentsResult ? selectResultValue(componentsResult) : undefined;
    const attachmentEdit =
      content.attachments === undefined
        ? {}
        : {
            attachments: [],
            files: content.attachments.map((attachment) => ({
              attachment: Buffer.from(attachment.bytes),
              name: attachment.filename,
            })),
          };

    if (selectResultValue(editTarget) === "content") {
      const edited = await captureDiscordOperation("edit-message", () =>
        msg.edit({ content: rewritten, components, ...attachmentEdit }),
      );
      return edited.map(() => undefined);
    }

    const existingEmbed = msg.embeds[0];
    if (!existingEmbed) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "edit-message",
          field: "message",
          message: "Discord message embed could not be resolved for editing",
        }),
      );
    }

    const oversized = oversizedEmbedDescription("edit-message", rewritten);
    if (oversized) return Result.err(oversized);
    const embed = new EmbedBuilder(existingEmbed.toJSON());
    embed.setDescription(rewritten);
    if (content.accentColor !== undefined) embed.setColor(content.accentColor);
    const edited = await captureDiscordOperation("edit-message", () =>
      msg.edit({ embeds: [embed], components, ...attachmentEdit }),
    );
    return edited.map(() => undefined);
  }

  async deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
    const refResult = discordMsgRefResult("delete-message", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const clientResult = this.clientResult();
    const clientError = clientResult.match({ ok: () => null, err: (error) => error });
    if (clientError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "delete-message",
          message: clientError.message,
        }),
      );
    }
    const client = selectResultValue(clientResult);
    const discordRef = selectResultValue(refResult);

    const fetched = await captureDiscordOperation("delete-message", () =>
      client.channels.fetch(discordRef.channelId),
    );
    const fetchError = fetched.match({ ok: () => null, err: (error) => error });
    if (fetchError) return Result.err(fetchError);
    const channel = selectResultValue(fetched);
    if (!channel || !("messages" in channel) || !channel.messages?.delete) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "delete-message",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }

    const deleted = await captureDiscordOperation("delete-message", () =>
      channel.messages.delete(discordRef.messageId),
    );
    return deleted.map(() => undefined);
  }

  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const refResult = discordMsgRefResult("get-reply-context", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const discordRef = selectResultValue(refResult);

    const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));

    const listed = await captureDiscordOperation("get-reply-context", () =>
      this.fetchDiscordMessages({
        channelId: discordRef.channelId,
        limit,
        aroundMessageId: discordRef.messageId,
      }),
    );
    const listError = listed.match({ ok: () => null, err: (error) => error });
    if (listError) return Result.err(listError);
    const messages = selectResultValue(listed);

    const projected: SurfaceMessage[] = [];
    for (const message of messages) {
      const result = this.toSurfaceMessageFromDiscordMessageResult(message);
      const projectionError = result.match({ ok: () => null, err: (error) => error });
      if (projectionError) {
        return Result.err(
          new SurfaceUnavailable({
            platform: "discord",
            operation: "get-reply-context",
            message: projectionError.message,
          }),
        );
      }
      projected.push(selectResultValue(result));
    }
    return Result.ok(
      projected.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return compareDiscordSnowflake(a.ref.messageId, b.ref.messageId);
      }),
    );
  }

  async planReplyChain(
    msgRef: MsgRef,
    opts?: SurfaceReplyChainPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const refResult = discordMsgRefResult("plan-reply-chain", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    msgRef = selectResultValue(refResult);

    const maxDepth = Math.min(100, Math.max(1, Math.floor(opts?.maxDepth ?? 20)));

    const out: MsgRef[] = [];
    const seen = new Set<string>();

    let currentChannelId = msgRef.channelId;
    let currentMessageId = msgRef.messageId;

    for (let depth = 0; depth < maxDepth; depth++) {
      const key = `${currentChannelId}:${currentMessageId}`;
      if (seen.has(key)) break;
      seen.add(key);

      const relation = await this.ensureMessageRelation("plan-reply-chain", {
        platform: "discord",
        channelId: currentChannelId,
        messageId: currentMessageId,
      });
      const relationError = relation.match({ ok: () => null, err: (error) => error });
      if (relationError) return Result.err(relationError);
      const rel = selectResultValue(relation);

      if (!rel) {
        if (depth === 0) {
          out.push({
            platform: "discord",
            channelId: currentChannelId,
            messageId: currentMessageId,
          });
        }
        break;
      }

      out.push({
        platform: "discord",
        channelId: rel.channel_id,
        messageId: rel.message_id,
      });

      if (!rel.reply_to_message_id) break;

      const replyChannelId = rel.reply_to_channel_id ?? rel.channel_id;
      if (replyChannelId !== msgRef.channelId) break;
      currentChannelId = replyChannelId;
      currentMessageId = rel.reply_to_message_id;
    }

    out.reverse();
    return Result.ok(out);
  }

  async planMergeBlockEndingAt(
    msgRef: MsgRef,
    opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const refResult = discordMsgRefResult("plan-merge-block", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    msgRef = selectResultValue(refResult);

    const lookbackLimit = Math.min(200, Math.max(5, Math.floor(opts?.lookbackLimit ?? 50)));

    const relationResult = await this.ensureMessageRelation("plan-merge-block", msgRef);
    const relationError = relationResult.match({ ok: () => null, err: (error) => error });
    if (relationError) return Result.err(relationError);
    const relation = selectResultValue(relationResult);
    if (!relation) return Result.ok([msgRef]);
    const store = this.store;
    if (!store) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "plan-merge-block",
          message: "DiscordAdapter not connected",
        }),
      );
    }

    const list = store.listMessageRelationsBeforeOrAt({
      channelId: relation.channel_id,
      messageId: relation.message_id,
      limit: lookbackLimit,
    });

    const targetIndex = list.findIndex((m) => m.message_id === relation.message_id);
    if (targetIndex < 0) {
      return Result.ok([
        {
          platform: "discord",
          channelId: relation.channel_id,
          messageId: relation.message_id,
        },
      ]);
    }

    const authorId = list[targetIndex]!.author_id;
    let runStart = targetIndex;
    for (let i = targetIndex - 1; i >= 0; i--) {
      const prev = list[i]!;
      if (prev.author_id !== authorId) break;
      runStart = i;
    }

    const run = list.slice(runStart, targetIndex + 1);

    const groups = splitByDiscordWindowOldestToNewest(
      run.map((m) => ({
        message: m,
        authorId: m.author_id,
        ts: m.ts,
        hardBreakBefore: Boolean(m.reply_to_message_id),
      })),
    );

    const endingGroup = groups[groups.length - 1] ?? [];
    if (endingGroup.length === 0) {
      return Result.ok([
        {
          platform: "discord",
          channelId: relation.channel_id,
          messageId: relation.message_id,
        },
      ]);
    }

    return Result.ok(
      endingGroup.map((item) => ({
        platform: "discord",
        channelId: item.message.channel_id,
        messageId: item.message.message_id,
      })),
    );
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const refResult = discordMsgRefResult("add-reaction", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    if (!reaction.trim()) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "add-reaction",
          field: "reaction",
          message: "Reaction is required",
        }),
      );
    }
    const clientResult = this.clientResult();
    const clientError = clientResult.match({ ok: () => null, err: (error) => error });
    if (clientError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "add-reaction",
          message: clientError.message,
        }),
      );
    }
    const client = selectResultValue(clientResult);
    const discordRef = selectResultValue(refResult);

    const fetched = await captureDiscordOperation("add-reaction", () =>
      client.channels.fetch(discordRef.channelId),
    );
    const fetchError = fetched.match({ ok: () => null, err: (error) => error });
    if (fetchError) return Result.err(fetchError);
    const channel = selectResultValue(fetched);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "add-reaction",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }
    const message = await captureDiscordOperation("add-reaction", () =>
      channel.messages.fetch({
        message: discordRef.messageId,
        cache: false,
        force: true,
      }),
    );
    const messageError = message.match({ ok: () => null, err: (error) => error });
    if (messageError) return Result.err(messageError);
    const reacted = await captureDiscordOperation("add-reaction", () =>
      selectResultValue(message).react(reaction),
    );
    return reacted.map(() => undefined);
  }

  async removeReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    const refResult = discordMsgRefResult("remove-reaction", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    if (!reaction.trim()) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "remove-reaction",
          field: "reaction",
          message: "Reaction is required",
        }),
      );
    }
    const clientResult = this.clientResult();
    const clientError = clientResult.match({ ok: () => null, err: (error) => error });
    if (clientError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "remove-reaction",
          message: clientError.message,
        }),
      );
    }
    const client = selectResultValue(clientResult);
    const discordRef = selectResultValue(refResult);

    const fetched = await captureDiscordOperation("remove-reaction", () =>
      client.channels.fetch(discordRef.channelId),
    );
    const fetchError = fetched.match({ ok: () => null, err: (error) => error });
    if (fetchError) return Result.err(fetchError);
    const channel = selectResultValue(fetched);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "remove-reaction",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }
    const message = await captureDiscordOperation("remove-reaction", () =>
      channel.messages.fetch({
        message: discordRef.messageId,
        cache: false,
        force: true,
      }),
    );
    const messageError = message.match({ ok: () => null, err: (error) => error });
    if (messageError) return Result.err(messageError);
    const resolvedReaction = selectResultValue(message).reactions.resolve(reaction);
    if (!resolvedReaction) return Result.ok(undefined);
    const removed = await captureDiscordOperation("remove-reaction", () =>
      resolvedReaction.remove(),
    );
    return removed.map(() => undefined);
  }

  async listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    const refResult = discordMsgRefResult("list-reactions", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const discordRef = selectResultValue(refResult);

    const fetched = await captureDiscordOperation("list-reactions", () =>
      this.fetchRequestScopedDiscordMessage({
        channelId: discordRef.channelId,
        messageId: discordRef.messageId,
      }),
    );
    const fetchError = fetched.match({ ok: () => null, err: (error) => error });
    if (fetchError) return Result.err(fetchError);
    const msg = selectResultValue(fetched);
    if (!msg) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "list-reactions",
          message: `Discord message not found: ${discordRef.messageId}`,
        }),
      );
    }

    return Result.ok(
      [...new Set([...msg.reactions.cache.values()].map((r) => r.emoji.toString()))].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  }

  async listReactionDetails(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    const refResult = discordMsgRefResult("list-reaction-details", msgRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const storeResult = this.storeResult();
    const storeError = storeResult.match({ ok: () => null, err: (error) => error });
    if (storeError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-reaction-details",
          message: storeError.message,
        }),
      );
    }
    const discordRef = selectResultValue(refResult);
    const store = selectResultValue(storeResult);

    const fetched = await captureDiscordOperation("list-reaction-details", () =>
      this.fetchDiscordMessage({
        channelId: discordRef.channelId,
        messageId: discordRef.messageId,
      }),
    );
    const fetchError = fetched.match({ ok: () => null, err: (error) => error });
    if (fetchError) return Result.err(fetchError);
    const msg = selectResultValue(fetched);
    if (!msg) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "list-reaction-details",
          message: `Discord message not found: ${discordRef.messageId}`,
        }),
      );
    }

    const now = Date.now();

    const out: SurfaceReactionDetail[] = [];
    const reactions = [...msg.reactions.cache.values()];

    for (const reaction of reactions) {
      const emoji = reaction.emoji.toString();

      const users = await this.fetchAllReactionUsers("list-reaction-details", reaction, {
        maxUsers: 1000,
      });
      const userError = users.match({ ok: () => null, err: (error) => error });
      if (userError) return Result.err(userError);

      const list = [...selectResultValue(users).values()]
        .map((u) => {
          const cached = store.getUserName(u.id);
          const cachedName =
            cached?.display_name ?? cached?.global_name ?? cached?.username ?? undefined;
          const liveName = (u.globalName ?? u.username) || undefined;
          const userName = cachedName ?? liveName;

          // Best-effort: keep the name caches warm for entity mapping.
          store.upsertUserName({
            userId: u.id,
            username: u.username,
            globalName: u.globalName ?? undefined,
            displayName: userName,
            updatedTs: now,
          });

          return { userId: u.id, userName };
        })
        .sort((a, b) => a.userId.localeCompare(b.userId));

      out.push({
        emoji,
        count: reaction.count ?? list.length,
        users: list,
      });
    }

    out.sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.emoji.localeCompare(b.emoji);
    });

    return Result.ok(out);
  }

  async listSessionParticipants(
    sessionRef: SessionRef,
    opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>> {
    const refResult = discordSessionRefResult("list-session-participants", sessionRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const discordRef = selectResultValue(refResult);

    const cfg = this.cfg;
    const client = this.client;
    const store = this.store;
    if (!cfg || !client || !store) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "list-session-participants",
          message: "DiscordAdapter not connected",
        }),
      );
    }

    const fetched = await captureDiscordOperation("list-session-participants", () =>
      client.channels.fetch(discordRef.channelId),
    );
    const fetchError = fetched.match({ ok: () => null, err: (error) => error });
    if (fetchError) return Result.err(fetchError);
    const ch = selectResultValue(fetched);
    if (!ch) {
      return Result.err(
        new SurfaceMessageNotFound({
          platform: "discord",
          operation: "list-session-participants",
          message: `Discord channel not found: ${discordRef.channelId}`,
        }),
      );
    }

    const guildId = "guildId" in ch ? ch.guildId : null;
    if (
      !shouldAllowMessage({
        cfg,
        channelId: discordRef.channelId,
        guildId,
      })
    ) {
      return Result.err(
        new SurfacePermissionDenied({
          platform: "discord",
          operation: "list-session-participants",
          message: `Not allowed: channelId '${discordRef.channelId}'`,
        }),
      );
    }

    const limit = Math.min(2000, Math.max(1, Math.floor(opts?.limit ?? 200)));

    if ("isThread" in ch && typeof ch.isThread === "function" && ch.isThread()) {
      const out: SurfaceSessionParticipant[] = [];
      let after: string | undefined;
      while (out.length < limit) {
        const pageLimit = Math.min(100, limit - out.length);
        const fetchedMembers = await captureDiscordOperation("list-session-participants", () =>
          ch.members.fetch({
            withMember: true,
            limit: pageLimit,
            ...(after ? { after } : {}),
            cache: false,
          }),
        );
        const memberError = fetchedMembers.match({ ok: () => null, err: (error) => error });
        if (memberError) return Result.err(memberError);
        const members = selectResultValue(fetchedMembers);
        if (members.size === 0) break;

        for (const threadMember of members.values()) {
          if (out.length >= limit) break;
          const userId = threadMember.id;
          if (!userId) continue;

          const member = threadMember.guildMember;
          const user = threadMember.user ?? member.user;
          out.push(
            this.toSurfaceSessionParticipant({
              store,
              userId,
              member,
              user,
              presence: member?.presence ?? ch.guild.presences.cache.get(userId) ?? null,
            }),
          );
        }

        after = members.lastKey() ?? undefined;
        if (!after || members.size < pageLimit) break;
      }

      return Result.ok({
        source: "thread_members",
        participants: sortSurfaceParticipants(out),
      });
    }

    const guild = "guild" in ch ? ch.guild : null;
    if (!guild) {
      return Result.ok({ source: "guild_members", participants: [] });
    }

    const out: SurfaceSessionParticipant[] = [];
    const seenUserIds = new Set<string>();

    let after: string | undefined;
    let exhausted = false;

    while (out.length < limit) {
      const pageLimit = Math.min(1000, Math.max(1, limit - out.length));
      const listed = await captureDiscordOperation("list-session-participants", () =>
        guild.members.list({ limit: pageLimit, ...(after ? { after } : {}), cache: false }),
      );
      const listError = listed.match({ ok: () => null, err: (error) => error });
      if (listError) return Result.err(listError);
      const page = selectResultValue(listed);

      if (page.size === 0) {
        exhausted = true;
        break;
      }

      for (const member of page.values()) {
        if (out.length >= limit) break;

        if ("permissionsFor" in ch && typeof ch.permissionsFor === "function") {
          const permissions = ch.permissionsFor(member);
          if (permissions && !permissions.has(PermissionFlagsBits.ViewChannel)) {
            continue;
          }
        }

        out.push(
          this.toSurfaceSessionParticipant({
            store,
            userId: member.id,
            member,
            user: member.user,
            presence: member.presence ?? guild.presences.cache.get(member.id) ?? null,
          }),
        );
        seenUserIds.add(member.id);
      }

      after = page.lastKey() ?? undefined;
      if (!after || page.size < pageLimit) {
        exhausted = true;
        break;
      }
    }

    if (out.length < limit && exhausted) {
      for (const member of guild.members.cache.values()) {
        if (out.length >= limit) break;
        if (seenUserIds.has(member.id)) continue;

        if ("permissionsFor" in ch && typeof ch.permissionsFor === "function") {
          const permissions = ch.permissionsFor(member);
          if (permissions && !permissions.has(PermissionFlagsBits.ViewChannel)) {
            continue;
          }
        }

        out.push(
          this.toSurfaceSessionParticipant({
            store,
            userId: member.id,
            member,
            user: member.user,
            presence: member.presence ?? guild.presences.cache.get(member.id) ?? null,
          }),
        );
        seenUserIds.add(member.id);
      }
    }

    return Result.ok({
      source: "guild_members",
      participants: sortSurfaceParticipants(out),
    });
  }

  private toSurfaceSessionParticipant(input: {
    store: DiscordSurfaceStore;
    userId: string;
    member?: GuildMember | null;
    user?: User | null;
    presence?: Presence | null;
  }): SurfaceSessionParticipant {
    const store = input.store;
    const now = Date.now();

    const user = input.user ?? input.member?.user ?? null;
    const userName = user?.username;
    const displayName = input.member?.displayName ?? user?.globalName ?? user?.username;
    const presence = input.presence ?? input.member?.presence ?? null;

    if (user) {
      store.upsertUserName({
        userId: input.userId,
        username: user.username,
        globalName: user.globalName ?? undefined,
        displayName,
        updatedTs: now,
      });
    }

    const out: SurfaceSessionParticipant = {
      userId: input.userId,
      ...(userName ? { userName } : {}),
      ...(displayName ? { displayName } : {}),
    };

    if (presence?.status) {
      out.status = presence.status;
    }

    const activities = toSurfaceParticipantActivities(presence);
    if (activities.length > 0) {
      out.activities = activities;
    }

    return out;
  }

  private async fetchAllReactionUsers(
    operation: SurfaceOperation,
    reaction: MessageReaction,
    opts: { maxUsers: number },
  ): Promise<SurfaceOperationResult<Map<string, User>>> {
    const out = new Map<string, User>();

    const pageLimit = 100;
    let after: string | undefined;

    while (out.size < opts.maxUsers) {
      const fetched = await captureDiscordOperation(operation, () =>
        reaction.users.fetch({ limit: pageLimit, ...(after ? { after } : {}) }),
      );
      const fetchError = fetched.match({ ok: () => null, err: (error) => error });
      if (fetchError) return Result.err(fetchError);
      const res = selectResultValue(fetched);
      if (res.size === 0) break;

      for (const u of res.values()) {
        out.set(u.id, u);
      }

      if (res.size < pageLimit) break;
      after = res.lastKey() ?? undefined;
      if (!after) break;

      const expected = reaction.count;
      if (typeof expected === "number" && Number.isFinite(expected) && out.size >= expected) {
        break;
      }
    }

    return Result.ok(out);
  }

  async subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async subscribeQuestionAnswers(
    handler: SurfaceQuestionAnswerHandler<"discord">,
    handleActivity: SurfaceQuestionActivityHandler<"discord">,
  ) {
    const subscription = { answer: handler, activity: handleActivity };
    this.questionHandlers.add(subscription);
    return {
      stop: async () => {
        this.questionHandlers.delete(subscription);
      },
    };
  }

  async getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const refResult = discordSessionRefResult("get-unread", sessionRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const storeResult = this.storeResult();
    const storeError = storeResult.match({ ok: () => null, err: (error) => error });
    if (storeError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "get-unread",
          message: storeError.message,
        }),
      );
    }
    const store = selectResultValue(storeResult);
    const discordRef = selectResultValue(refResult);

    const rs = store.getOrInitReadState(discordRef.channelId);

    // Best-effort: fetch a recent window and filter locally.
    const recent = await this.listMsg(sessionRef, { limit: 100 });
    const recentError = recent.match({ ok: () => null, err: (error) => error });
    if (recentError) return Result.err(recentError);

    const unread = selectResultValue(recent).filter((m) => {
      if (m.deleted) return false;
      if (m.ts > rs.last_read_ts) return true;
      if (m.ts < rs.last_read_ts) return false;
      return compareDiscordSnowflake(m.ref.messageId, rs.last_read_message_id) > 0;
    });

    unread.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return compareDiscordSnowflake(a.ref.messageId, b.ref.messageId);
    });

    return Result.ok(unread);
  }

  async markRead(
    sessionRef: SessionRef,
    upToMsgRef?: MsgRef,
  ): Promise<SurfaceOperationResult<void>> {
    const refResult = discordSessionRefResult("mark-read", sessionRef);
    const refError = refResult.match({ ok: () => null, err: (error) => error });
    if (refError) return Result.err(refError);
    const discordRef = selectResultValue(refResult);
    let discordUpToRef: DiscordMsgRef | undefined;
    if (upToMsgRef) {
      const upToResult = discordNestedMsgRefResult({
        operation: "mark-read",
        sessionRef: discordRef,
        msgRef: upToMsgRef,
        refRole: "upToMsgRef",
      });
      const upToError = upToResult.match({ ok: () => null, err: (error) => error });
      if (upToError) return Result.err(upToError);
      discordUpToRef = selectResultValue(upToResult);
    }
    const storeResult = this.storeResult();
    const storeError = storeResult.match({ ok: () => null, err: (error) => error });
    if (storeError) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation: "mark-read",
          message: storeError.message,
        }),
      );
    }
    const store = selectResultValue(storeResult);

    if (discordUpToRef) {
      const fetched = await captureDiscordOperation("mark-read", () =>
        this.fetchDiscordMessage({
          channelId: discordUpToRef.channelId,
          messageId: discordUpToRef.messageId,
        }),
      );
      const fetchError = fetched.match({ ok: () => null, err: (error) => error });
      if (fetchError) return Result.err(fetchError);
      const msg = selectResultValue(fetched);

      if (!msg) {
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "discord",
            operation: "mark-read",
            message: `Discord message not found: ${discordUpToRef.messageId}`,
          }),
        );
      }

      store.setReadState({
        channelId: discordRef.channelId,
        lastReadTs: getMessageTs(msg),
        lastReadMessageId: msg.id,
      });
      return Result.ok(undefined);
    }

    const fetchedLatest = await captureDiscordOperation("mark-read", () =>
      this.fetchLatestDiscordMessage(discordRef.channelId),
    );
    const fetchLatestError = fetchedLatest.match({ ok: () => null, err: (error) => error });
    if (fetchLatestError) return Result.err(fetchLatestError);
    const latest = selectResultValue(fetchedLatest);
    if (!latest) return Result.ok(undefined);
    store.setReadState({
      channelId: discordRef.channelId,
      lastReadTs: getMessageTs(latest),
      lastReadMessageId: latest.id,
    });
    return Result.ok(undefined);
  }

  // --- internals ---

  private clientResult(): ResultType<Client, DiscordAdapterUnavailable> {
    if (this.client) return Result.ok(this.client);
    return Result.err(new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" }));
  }

  private storeResult(): ResultType<DiscordSurfaceStore, DiscordAdapterUnavailable> {
    if (this.store) return Result.ok(this.store);
    return Result.err(new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" }));
  }

  private async ensureMessageRelation(
    operation: "plan-reply-chain" | "plan-merge-block",
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<DbDiscordMessageRelation | null>> {
    if (msgRef.platform !== "discord") {
      return Result.err(
        new SurfacePlatformMismatch({
          operation,
          refRole: "msgRef",
          expectedPlatform: "discord",
          receivedPlatform: msgRef.platform,
          message: `Expected a Discord msgRef, received '${msgRef.platform}'`,
        }),
      );
    }

    const store = this.store;
    if (!store) {
      return Result.err(
        new SurfaceUnavailable({
          platform: "discord",
          operation,
          message: "DiscordAdapter not connected",
        }),
      );
    }

    const existing = store.getMessageRelation(msgRef.channelId, msgRef.messageId);
    if (existing) return Result.ok(existing);

    const read = await this.readMsg(msgRef);
    const readError = read.match({ ok: () => null, err: (error) => error });
    if (readError) return Result.err(readError);

    return Result.ok(store.getMessageRelation(msgRef.channelId, msgRef.messageId));
  }

  private noteGatewayEvent(_event: string) {
    this.healthState = {
      ...this.healthState,
      lastGatewayEventAt: Date.now(),
    };
    if (this.client) {
      this.refreshGatewayPing(this.client);
    }
  }

  private refreshGatewayPing(client: Client) {
    const ping = client.ws.ping;
    const lastGatewayPingAt = getLatestGatewayPingAt(client);
    if ((!Number.isFinite(ping) || ping < 0) && lastGatewayPingAt === undefined) return;
    this.healthState = {
      ...this.healthState,
      ...(Number.isFinite(ping) && ping >= 0 ? { gatewayPingMs: ping } : {}),
      ...(lastGatewayPingAt !== undefined ? { lastGatewayPingAt } : {}),
    };
  }

  private upsertMessageRelationFromDiscordMessage(msg: Message, input?: { deleted?: boolean }) {
    const store = this.store;
    if (!store) return;

    const replyRef = getReplyReference(msg);

    store.upsertMessageRelation({
      channelId: msg.channelId,
      messageId: msg.id,
      guildId: msg.guildId ?? undefined,
      authorId: msg.author.id,
      authorName: getDisplayName(msg),
      ts: getMessageTs(msg),
      isChat: isDiscordChatLikeMessage(msg),
      replyToChannelId: replyRef?.channelId,
      replyToMessageId: replyRef?.messageId,
      deleted: input?.deleted,
      updatedTs: Date.now(),
    });
  }

  private reportDetachedPanic(panic: Panic): void {
    queueMicrotask(() => {
      this.opts.reportFatalPanic(panic);
    });
  }

  private superviseDiscordCallback(operation: string, callback: () => void | Promise<void>): void {
    const settlement = Promise.allSettled([Promise.resolve().then(callback)]);
    void settlement.then(([result]) => {
      if (!result || result.status === "fulfilled") return;
      if (Panic.is(result.reason)) {
        this.reportDetachedPanic(result.reason);
        return;
      }
      this.logger.error("Discord callback failed", { operation });
    });
  }

  private emit(evt: AdapterEvent) {
    for (const h of this.handlers) {
      const handled = Result.tryPromise({
        try: async () => await Promise.resolve().then(() => h(evt)),
        catch: (cause): { kind: "panic"; panic: Panic } | { kind: "ordinary" } =>
          Panic.is(cause) ? { kind: "panic", panic: cause } : { kind: "ordinary" },
      });
      void handled.then((result) =>
        result.match({
          ok: () => undefined,
          err: (captured) => {
            if (captured.kind === "panic") this.reportDetachedPanic(captured.panic);
          },
        }),
      );
    }
  }

  private async emitAndWait(evt: AdapterEvent): Promise<void> {
    await Promise.all([...this.handlers].map(async (handler) => await handler(evt)));
  }

  private async dispatchQuestionAnswer(
    answer: SurfaceQuestionAnswer<"discord">,
    interaction: ModalMessageModalSubmitInteraction<CacheType> | ButtonInteraction<CacheType>,
  ): Promise<DiscordQuestionDispatchResult> {
    const subscription = this.questionHandlers.values().next().value;
    if (!subscription) return { disposition: "not-found", interactionUpdate: "not-attempted" };
    let interactionUpdate: DiscordQuestionInteractionUpdateState = "not-attempted";
    const handled = await subscription.answer(answer, async (update) => {
      const updated = await this.updateQuestionInteraction(interaction, update);
      interactionUpdate = updated.match<DiscordQuestionInteractionUpdateState>({
        ok: () => "succeeded",
        err: () => "failed",
      });
      return updated;
    });
    const disposition = handled.match<SurfaceQuestionAnswerDisposition | "failed">({
      ok: (value) => value,
      err: () => "failed",
    });
    return { disposition, interactionUpdate };
  }

  private async dispatchQuestionActivity(
    activity: SurfaceQuestionActivity<"discord">,
  ): Promise<SurfaceQuestionAnswerDisposition | "failed"> {
    const subscription = this.questionHandlers.values().next().value;
    if (!subscription) return "not-found";
    const handled = await subscription.activity(activity);
    return handled.match<SurfaceQuestionAnswerDisposition | "failed">({
      ok: (value) => value,
      err: () => "failed",
    });
  }

  private async updateQuestionInteraction(
    interaction: ModalMessageModalSubmitInteraction<CacheType> | ButtonInteraction<CacheType>,
    update: SurfaceQuestionInteractionUpdate,
  ): Promise<SurfaceOperationResult<void>> {
    const content = discordQuestionInteractionContent(update);
    const componentsResult = buildDiscordActionComponentsResult(content.actions ?? []);
    const componentError = componentsResult.match({
      ok: () => null,
      err: (error) => error,
    });
    if (componentError) {
      return Result.err(
        new SurfaceInvalidInput({
          platform: "discord",
          operation: "edit-message",
          field: "content.actions",
          message: componentError.message,
        }),
      );
    }
    const raw = content.text ?? "";
    const rewritten = this.entityMapper?.rewriteOutgoingText(raw) ?? raw;
    const oversized = oversizedEmbedDescription("edit-message", rewritten);
    if (oversized) return Result.err(oversized);
    const embed = new EmbedBuilder().setDescription(rewritten);
    if (content.accentColor !== undefined) embed.setColor(content.accentColor);
    const updated = await captureDiscordOperation("edit-message", () =>
      interaction.update({
        embeds: [embed],
        components: selectResultValue(componentsResult),
      }),
    );
    return updated.map(() => undefined);
  }

  private async acknowledgeQuestionAnswer(
    interaction: ModalSubmitInteraction<CacheType> | ButtonInteraction<CacheType>,
    result: DiscordQuestionDispatchResult,
  ): Promise<void> {
    switch (result.disposition) {
      case "accepted":
        if (result.interactionUpdate === "succeeded") return;
        if (result.interactionUpdate === "failed") {
          await tryReplyEphemeral(
            interaction,
            "Response recorded, but the question display could not be updated.",
          );
          return;
        }
        await this.deferQuestionInteractionUpdate(interaction);
        return;
      case "unauthorized":
        await tryReplyEphemeral(interaction, "This question is for another user.");
        return;
      case "stale":
        await tryReplyEphemeral(interaction, "This question is no longer active.");
        return;
      case "not-found":
        await tryReplyEphemeral(interaction, "This question could not be found.");
        return;
      case "failed":
        if (result.interactionUpdate === "failed") {
          await tryReplyEphemeral(
            interaction,
            "Response recorded, but the question display could not be updated.",
          );
          return;
        }
        await tryReplyEphemeral(interaction, "The response could not be recorded. Please retry.");
        return;
    }
  }

  private async deferQuestionInteractionUpdate(
    interaction: ModalSubmitInteraction<CacheType> | ButtonInteraction<CacheType>,
  ): Promise<boolean> {
    const deferred = settleSurfaceFallback(
      await Result.tryPromise({
        try: async () => {
          await interaction.deferUpdate();
          return true;
        },
        catch: (cause) => {
          const fallback = externalCallFailure("interaction.deferUpdate");
          return Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback }
            : { kind: "fallback", fallback };
        },
      }),
    );
    return deferred.match({
      ok: (acknowledged) => acknowledged,
      err: () => false,
    });
  }

  private async onQuestionModalSubmit(
    interaction: ModalSubmitInteraction<CacheType>,
    token: string,
  ) {
    const channelId = interaction.channelId;
    const userId = interaction.user?.id;
    if (!channelId || !userId) {
      await tryReplyEphemeral(interaction, "Unable to authenticate this response.");
      return;
    }
    if (!interaction.isFromMessage()) {
      await tryReplyEphemeral(interaction, "This response is not attached to a question message.");
      return;
    }
    const text = interaction.fields.getTextInputValue(DISCORD_QUESTION_CUSTOM_INPUT_ID).trim();
    if (!text) {
      await tryReplyEphemeral(interaction, "Enter a response before submitting.");
      return;
    }
    const result = await this.dispatchQuestionAnswer(
      {
        platform: "discord",
        channelId,
        messageRef: {
          platform: "discord",
          channelId,
          messageId: interaction.message.id,
        },
        principal: { platform: "discord", userId },
        token,
        answer: { kind: "custom", text },
      },
      interaction,
    );
    await this.acknowledgeQuestionAnswer(interaction, result);
  }

  private getParentChannelIdFromInteractionChannel(
    interaction: ChatInputCommandInteraction<CacheType> | AutocompleteInteraction<CacheType>,
  ): string | undefined {
    const channel = interaction.channel;
    if (!channel) return undefined;
    if (!("isThread" in channel) || typeof channel.isThread !== "function") return undefined;
    if (!channel.isThread()) return undefined;
    return channel.parentId ?? undefined;
  }

  private getEffectiveSessionModelOverride(input: {
    cfg?: CoreConfig;
    sessionId: string;
    parentChannelId?: string | null;
    guildId?: string | null;
  }): string | undefined {
    const inMemoryOverride = this.getInMemorySessionModelOverride({
      sessionId: input.sessionId,
      parentChannelId: input.parentChannelId,
    });
    if (inMemoryOverride) return inMemoryOverride;

    const cfg = input.cfg;
    if (!cfg) return undefined;
    return resolveRouterSessionConfig(cfg, input).model;
  }

  private getInMemorySessionModelOverride(input: {
    sessionId: string;
    parentChannelId?: string | null;
  }): string | undefined {
    return resolveEffectiveSessionModelOverride({
      sessionId: input.sessionId,
      parentChannelId: input.parentChannelId,
      overrides: this.sessionModelOverrides,
    });
  }

  private getSessionModelRef(input: {
    cfg: CoreConfig;
    sessionId: string;
    parentChannelId?: string | null;
    guildId?: string | null;
  }): string {
    return (
      this.getEffectiveSessionModelOverride({
        cfg: input.cfg,
        sessionId: input.sessionId,
        parentChannelId: input.parentChannelId,
        guildId: input.guildId,
      }) ?? input.cfg.models.main.model
    );
  }

  private async onInteractionCreate(interaction: Interaction<CacheType>) {
    if (interaction.isChatInputCommand()) {
      await this.onChatInputCommand(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      await this.onAutocomplete(interaction);
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      await this.onMessageContextMenuCommand(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      const token = parseDiscordQuestionModalCustomId(interaction.customId);
      if (token) await this.onQuestionModalSubmit(interaction, token);
      return;
    }

    if (!interaction.isButton()) return;

    const actionId = parseDiscordActionCustomId(interaction.customId);
    if (actionId) {
      const channelId = interaction.channelId;
      const messageId = interaction.message?.id;
      const userId = interaction.user?.id;
      if (!channelId || !messageId || !userId) {
        await tryReplyEphemeral(interaction, "Unable to authenticate this workflow action.");
        return;
      }
      const questionAction = parseDiscordQuestionActionId(actionId);
      if (questionAction?.kind === "custom") {
        const disposition = await this.dispatchQuestionActivity({
          platform: "discord",
          channelId,
          messageRef: { platform: "discord", channelId, messageId },
          principal: { platform: "discord", userId },
          token: questionAction.token,
        });
        if (disposition !== "accepted") {
          await this.acknowledgeQuestionAnswer(interaction, {
            disposition,
            interactionUpdate: "not-attempted",
          });
          return;
        }
        const shown = settleSurfaceFallback(
          await Result.tryPromise({
            try: () => interaction.showModal(buildDiscordQuestionModal(questionAction.token)),
            catch: (cause) => {
              const fallback = externalCallFailure("interaction.showModal");
              return Panic.is(cause)
                ? { kind: "panic", panic: cause, fallback }
                : { kind: "fallback", fallback };
            },
          }),
        );
        await shown.match({
          ok: () => Promise.resolve(),
          err: () => tryReplyEphemeral(interaction, "Unable to open the response form."),
        });
        return;
      }
      if (questionAction?.kind === "option") {
        const result = await this.dispatchQuestionAnswer(
          {
            platform: "discord",
            channelId,
            messageRef: { platform: "discord", channelId, messageId },
            principal: { platform: "discord", userId },
            token: questionAction.token,
            answer: { kind: "option", optionIndex: questionAction.optionIndex },
          },
          interaction,
        );
        await this.acknowledgeQuestionAnswer(interaction, result);
        return;
      }
      const published = settleSurfaceFallback(
        await Result.tryPromise({
          try: () =>
            this.emitAndWait({
              type: "adapter.action.invoked",
              platform: "discord",
              ts: Date.now(),
              actionId,
              userId,
              messageRef: { platform: "discord", channelId, messageId },
            }),
          catch: (cause) => {
            const fallback = externalCallFailure("surface-event-handler");
            return Panic.is(cause)
              ? { kind: "panic", panic: cause, fallback }
              : { kind: "fallback", fallback };
          },
        }),
      );
      const publishSucceeded = published.match({ ok: () => true, err: () => false });
      if (publishSucceeded) {
        await tryReplyEphemeral(interaction, "Workflow action received.");
      } else {
        this.logger.error("workflow action durable publication failed", { actionId });
        await tryReplyEphemeral(
          interaction,
          "Workflow action could not be recorded. Please retry.",
        );
      }
      return;
    }

    const parsed = parseCancelCustomId(interaction.customId);
    if (!parsed) return;

    // Guard against mismatched sessions (e.g. copied components).
    if (interaction.channelId && parsed.sessionId !== interaction.channelId) {
      await tryReplyEphemeral(interaction, "This cancel button is not for this channel.");
      return;
    }

    this.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: parsed.requestId,
      sessionId: parsed.sessionId,
      cancelScope: "active_only",
      source: "button",
      userId: interaction.user?.id ?? undefined,
      messageId: interaction.message?.id ?? undefined,
    });

    // Acknowledge quickly; actual cancellation is handled asynchronously via the bus.
    await tryReplyEphemeral(interaction, "Cancel requested.");
  }

  private async onMessageContextMenuCommand(
    interaction: MessageContextMenuCommandInteraction<CacheType>,
  ): Promise<void> {
    if (interaction.commandName !== CONTEXT_MENU_CANCEL_REQUEST_NAME) return;

    const cfg = this.cfg;
    if (!cfg) {
      await tryReplyEphemeral(interaction, "Bot is not ready yet.");
      return;
    }

    const channelId = interaction.channelId;
    const guildId = interaction.guildId;
    if (!channelId) {
      await tryReplyEphemeral(interaction, "This command must be used in a channel.");
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      await tryReplyEphemeral(interaction, "Not allowed in this channel.");
      return;
    }

    const targetMessageId = interaction.targetMessage?.id;
    if (!targetMessageId) {
      await tryReplyEphemeral(interaction, "Could not resolve target message.");
      return;
    }

    this.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: formatDiscordMessageRequestId({ channelId, messageId: targetMessageId }),
      sessionId: channelId,
      cancelScope: "active_or_queued",
      source: "context_menu",
      userId: interaction.user?.id ?? undefined,
      messageId: targetMessageId,
    });

    await tryReplyEphemeral(interaction, "Cancel requested.");
  }

  private async registerSlashCommands(): Promise<void> {
    const client = this.client;
    if (!client) return;

    const app = client.application;
    if (!app) return;

    // Ensure the application is fetched (discord.js sometimes lazily loads it).
    settleSurfaceFallback(
      await Result.tryPromise({
        try: () => app.fetch(),
        catch: captureNullSurfaceFallback,
      }),
    );

    const customOptions = (this.opts?.customCommands?.list() ?? []).map((cmd) => ({
      type: ApplicationCommandOptionType.Subcommand as const,
      name: cmd.def.name,
      description: cmd.def.description,
      options: [
        ...cmd.def.args.map((arg) => buildDiscordSlashOption(arg)),
        {
          type: ApplicationCommandOptionType.String as const,
          name: CUSTOM_COMMAND_PROMPT_ARG_KEY,
          description: "Extra prompt text for the assistant after the command runs",
          required: false,
        },
      ],
    }));

    if (customOptions.length > 24) {
      this.logger.warn("too many custom commands for /lilac; only first 24 will be registered", {
        discovered: customOptions.length,
      });
    }

    const slashDefinition = {
      name: "lilac",
      description: "Lilac bot commands",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand as const,
          name: "divider",
          description: "Insert a session divider for context",
          options: [
            {
              type: ApplicationCommandOptionType.String as const,
              name: "label",
              description: "Optional label for the divider",
              required: false,
            },
          ],
        },
        ...customOptions.slice(0, 24),
      ],
    };

    const modelSlashDefinition = {
      name: "model",
      description: "View or switch this session model",
      options: [
        {
          type: ApplicationCommandOptionType.String as const,
          name: "model",
          description: "Model alias or provider/model",
          required: false,
          autocomplete: true,
        },
      ],
    };

    const contextSlashDefinition = {
      name: "context",
      description: "Show the resting context composition for this session",
    };

    const cancelContextMenuDefinition = {
      name: CONTEXT_MENU_CANCEL_REQUEST_NAME,
      type: ApplicationCommandType.Message as const,
    };

    // Force-sync (bulk overwrite) so stale commands are removed.
    // This is intentional: we treat the current code's command list as the
    // source of truth for this application.
    const desired = [
      slashDefinition,
      modelSlashDefinition,
      contextSlashDefinition,
      cancelContextMenuDefinition,
    ];
    let syncFailed = false;
    const globalSync = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => app.commands.set(desired),
        catch: (cause) => {
          const fallback = externalCallFailure("application.commands.set");
          return Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback }
            : { kind: "fallback", fallback };
        },
      }),
    );
    const globalSyncError = globalSync.match({ ok: () => null, err: (error) => error });
    if (globalSyncError) {
      syncFailed = true;
      this.logger.error("slash command sync failed", {
        ...formatTaggedErrorForLog(globalSyncError),
      });
    } else {
      this.logger.debug("slash command scope synced", {
        scope: "global",
        count: desired.length,
      });
    }

    // Global-only strategy: clear guild-scoped commands to avoid duplicate
    // entries in Discord command pickers.
    const fetchedGuilds = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => client.guilds.fetch(),
        catch: (cause) => {
          const fallback = externalCallFailure("client.guilds.fetch");
          return Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback }
            : { kind: "fallback", fallback };
        },
      }),
    );
    const fetchGuildsError = fetchedGuilds.match({ ok: () => null, err: (error) => error });
    if (fetchGuildsError) {
      syncFailed = true;
      this.logger.error("guild slash command discovery failed", {
        ...formatTaggedErrorForLog(fetchGuildsError),
      });
    }
    const guilds = selectResultValueOr(fetchedGuilds, null);
    const guildIds = guilds ? [...guilds.keys()] : [];
    for (const guildId of guildIds) {
      const fetchedGuild = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => client.guilds.fetch(guildId),
          catch: (cause) => {
            const fallback = externalCallFailure("client.guilds.fetch");
            return Panic.is(cause)
              ? { kind: "panic", panic: cause, fallback }
              : { kind: "fallback", fallback };
          },
        }),
      );
      const fetchGuildError = fetchedGuild.match({ ok: () => null, err: (error) => error });
      if (fetchGuildError) {
        syncFailed = true;
        this.logger.error("guild slash command sync failed", {
          guildId,
          ...formatTaggedErrorForLog(fetchGuildError),
        });
        continue;
      }
      const guild = selectResultValue(fetchedGuild);

      const guildSync = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => guild.commands.set([]),
          catch: (cause) => {
            const fallback = externalCallFailure("guild.commands.set");
            return Panic.is(cause)
              ? { kind: "panic", panic: cause, fallback }
              : { kind: "fallback", fallback };
          },
        }),
      );
      const guildSyncError = guildSync.match({ ok: () => null, err: (error) => error });
      if (guildSyncError) {
        syncFailed = true;
        this.logger.error("guild slash command sync failed", {
          guildId,
          ...formatTaggedErrorForLog(guildSyncError),
        });
      } else {
        this.logger.debug("slash command scope synced", {
          scope: "guild",
          guildId,
          count: 0,
        });
      }
    }
    if (!syncFailed) {
      this.logSlashCommandSyncSuccess(desired.length, guildIds.length);
    }
  }

  private logSlashCommandSyncSuccess(globalCount: number, guildCount: number): void {
    this.logger.info("slash commands synced", { globalCount, guildCount });
  }

  private async onChatInputCommand(
    interaction: ChatInputCommandInteraction<CacheType>,
  ): Promise<void> {
    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    const client = this.client;
    const self = this.self;

    if (!cfg || !client || !self) {
      // Not ready; best-effort ack.
      await tryReplyEphemeral(interaction, "Bot is not ready yet.");
      return;
    }

    if (interaction.commandName === "model") {
      await this.onModelCommand(interaction, cfg);
      return;
    }

    if (interaction.commandName === "context") {
      await this.onContextCommand(interaction, cfg);
      return;
    }

    if (interaction.commandName !== "lilac") return;

    const channelId = interaction.channelId;
    const guildId = interaction.guildId;

    if (!channelId) {
      await tryReplyEphemeral(interaction, "This command must be used in a channel.");
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      await tryReplyEphemeral(interaction, "Not allowed in this channel.");
      return;
    }

    const subcommand = settleSurfaceFallback(
      Result.try({
        try: () => interaction.options.getSubcommand(),
        catch: captureNullSurfaceFallback,
      }),
    );
    const sub = selectResultValueOr(subcommand, null);

    if (sub === "divider") {
      const label = interaction.options.getString("label");

      const content = buildDiscordSessionDividerText({
        label,
        createdByUserId: interaction.user?.id ?? null,
        createdByUserName: interaction.user?.username ?? null,
      });

      // Defer immediately to avoid the 3s interaction timeout.
      settleSurfaceFallback(
        await Result.tryPromise({
          try: () => interaction.deferReply({ flags: MessageFlags.Ephemeral }),
          catch: captureUndefinedSurfaceFallback,
        }),
      );

      const ch = await resolveTextSendableChannel(client, channelId);
      if (!ch) {
        await tryEditOrReplyEphemeral(interaction, "Channel not found or not text-based.");
        return;
      }

      const sent = settleSurfaceFallback(
        await Result.tryPromise({
          try: async () => await ch.send({ content, allowedMentions: { parse: [] } }),
          catch: (cause) => {
            const fallback = externalCallFailure("channel.send-divider");
            return Panic.is(cause)
              ? { kind: "panic", panic: cause, fallback }
              : { kind: "fallback", fallback };
          },
        }),
      );
      const sendError = sent.match({ ok: () => null, err: (error) => error });
      if (sendError) {
        await tryEditOrReplyEphemeral(
          interaction,
          `Failed to insert divider: ${sendError.message}`,
        );
        return;
      }

      await tryEditOrReplyEphemeral(interaction, "Inserted session divider.");
      return;
    }

    const custom = this.opts?.customCommands?.get(sub ?? "");
    if (!custom) {
      await tryReplyEphemeral(interaction, "Unknown subcommand.");
      return;
    }

    const customCommands = this.opts.customCommands;
    if (!customCommands) {
      await tryReplyEphemeral(interaction, "Unknown subcommand.");
      return;
    }
    const preparedArgs = settleSurfaceFallback(
      Result.try({
        try: () => ({
          rawArgs: Object.fromEntries(
            custom.def.args.flatMap((arg) => {
              const value = readDiscordSlashOption(interaction, arg);
              return value === null ? [] : [[arg.key, value] as const];
            }),
          ),
          prompt: interaction.options.getString(CUSTOM_COMMAND_PROMPT_ARG_KEY),
        }),
        catch: (cause) => {
          const fallback = externalCallFailure("interaction.options");
          return Panic.is(cause)
            ? { kind: "panic", panic: cause, fallback }
            : { kind: "fallback", fallback };
        },
      }),
    );
    const prepareError = preparedArgs.match({ ok: () => null, err: (error) => error });
    if (prepareError) {
      await tryEditOrReplyEphemeral(
        interaction,
        `Failed to run custom command: ${prepareError.message}`,
      );
      return;
    }
    const args = selectResultValue(preparedArgs);
    const parsedResult = customCommands.parseSlash({
      name: custom.def.name,
      rawArgs: args.rawArgs,
      prompt: args.prompt,
    });
    const parseError = parsedResult.match({ ok: () => null, err: (error) => error });
    if (parseError) {
      await tryEditOrReplyEphemeral(
        interaction,
        `Failed to run custom command: ${customCommandInvocationErrorText(parseError)}`,
      );
      return;
    }
    const parsed = selectResultValue(parsedResult);
    const preview = customCommands.formatPreview(parsed);
    const parentChannelId = this.getParentChannelIdFromInteractionChannel(interaction);
    const sessionMode = getSessionMode(cfg, channelId, parentChannelId, guildId ?? undefined);
    const sessionConfigId = resolveSessionConfigId({
      cfg,
      sessionId: channelId,
      parentChannelId,
      guildId: guildId ?? undefined,
    });
    const modelOverride = this.getSessionModelRef({
      cfg,
      sessionId: channelId,
      parentChannelId,
      guildId,
    });

    this.superviseDiscordCallback("custom-command-preview", async () => {
      const replied = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => interaction.reply({ content: preview, allowedMentions: { parse: [] } }),
          catch: (cause) => {
            const fallback = externalCallFailure("interaction.reply");
            return Panic.is(cause)
              ? { kind: "panic", panic: cause, fallback }
              : { kind: "fallback", fallback };
          },
        }),
      );
      const replyError = replied.match({ ok: () => null, err: (error) => error });
      if (replyError) {
        await tryEditOrReplyEphemeral(
          interaction,
          `Failed to acknowledge custom command: ${replyError.message}`,
        );
      }
    });

    this.emit({
      type: "adapter.command.invoked",
      platform: "discord",
      ts: Date.now(),
      requestId: formatDiscordSlashRequestId({
        channelId,
        interactionId: interaction.id,
      }),
      sessionId: channelId,
      commandName: custom.def.name,
      args: parsed.args,
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
      text: parsed.text,
      userId: interaction.user?.id ?? undefined,
      userName:
        (interaction.member && "displayName" in interaction.member
          ? interaction.member.displayName
          : undefined) ??
        interaction.user?.globalName ??
        interaction.user?.username ??
        undefined,
      sessionMode,
      sessionConfigId,
      ...(parentChannelId ? { parentChannelId } : {}),
      ...(guildId ? { guildId } : {}),
      modelOverride,
    });
  }

  private async onContextCommand(
    interaction: ChatInputCommandInteraction<CacheType>,
    cfg: CoreConfig,
  ): Promise<void> {
    const channelId = interaction.channelId;
    const guildId = interaction.guildId;
    if (!channelId) {
      await tryReplyEphemeral(interaction, "This command must be used in a channel.");
      return;
    }
    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      await tryReplyEphemeral(interaction, "Not allowed in this channel.");
      return;
    }

    const contextReport = this.opts.contextReport;
    if (!contextReport) {
      await tryReplyEphemeral(interaction, "Context reporting is not ready yet.");
      return;
    }

    settleSurfaceFallback(
      await Result.tryPromise({
        try: () => interaction.deferReply({ flags: MessageFlags.Ephemeral }),
        catch: captureUndefinedSurfaceFallback,
      }),
    );

    const parentChannelId = this.getParentChannelIdFromInteractionChannel(interaction);
    const report = await contextReport({
      source: "rest",
      config: cfg,
      sessionId: channelId,
      requestId: formatDiscordSlashRequestId({
        channelId,
        interactionId: interaction.id,
      }),
      userId: interaction.user?.id,
      ...(parentChannelId ? { parentChannelId } : {}),
      ...(guildId ? { guildId } : {}),
      modelOverride: this.getSessionModelRef({
        cfg,
        sessionId: channelId,
        parentChannelId,
        guildId,
      }),
      messages: [],
    });
    const reportError = report.match({ ok: () => null, err: (error) => error });
    if (reportError) {
      this.logger.warn("context report failed", {
        source: "rest",
        sessionId: channelId,
        ...formatTaggedErrorForLog(reportError),
      });
      await tryEditOrReplyEphemeral(interaction, "Unable to build the context report.");
      return;
    }
    const presentation = report.match({ ok: (value) => value, err: () => null });
    if (!presentation) {
      await tryEditOrReplyEphemeral(interaction, "Unable to build the context report.");
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(presentation.accentColor)
      .setDescription(presentation.text);
    const edited = settleSurfaceFallback(
      await Result.tryPromise({
        try: () => interaction.editReply({ embeds: [embed] }),
        catch: captureUndefinedSurfaceFallback,
      }),
    );
    const editFailed = edited.match({ ok: () => false, err: () => true });
    if (editFailed) {
      this.logger.warn("context report reply failed", {
        source: "rest",
        sessionId: channelId,
      });
    }
  }

  private async onAutocomplete(interaction: AutocompleteInteraction<CacheType>): Promise<void> {
    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    if (!cfg) {
      settleSurfaceFallback(
        await Result.tryPromise({
          try: () => interaction.respond([]),
          catch: captureUndefinedSurfaceFallback,
        }),
      );
      return;
    }

    if (interaction.commandName !== "model") return;

    const focused = interaction.options.getFocused(true);
    if (focused.name !== "model") return;

    const focusedValue =
      typeof focused.value === "string" || typeof focused.value === "number" ? focused.value : "";
    const query = `${focusedValue}`.trim().toLowerCase();
    const aliases = Object.keys(cfg.models.def ?? {}).sort((a, b) => a.localeCompare(b));
    if (aliases.length === 0) {
      settleSurfaceFallback(
        await Result.tryPromise({
          try: () => interaction.respond([]),
          catch: captureUndefinedSurfaceFallback,
        }),
      );
      return;
    }

    const sessionId = interaction.channelId;
    const parentChannelId = this.getParentChannelIdFromInteractionChannel(interaction);
    const current = sessionId
      ? this.getSessionModelRef({
          cfg,
          sessionId,
          parentChannelId,
          guildId: interaction.guildId,
        })
      : cfg.models.main.model;

    const choices: Array<{ name: string; value: string }> = [];
    if (aliases.includes(current) && current.toLowerCase().includes(query)) {
      choices.push({
        name: `${current} (current)`,
        value: current,
      });
    }

    for (const alias of aliases) {
      if (alias === current) continue;
      if (!alias.toLowerCase().includes(query)) continue;
      choices.push({ name: alias, value: alias });
      if (choices.length >= 25) break;
    }

    settleSurfaceFallback(
      await Result.tryPromise({
        try: () => interaction.respond(choices.slice(0, 25)),
        catch: captureUndefinedSurfaceFallback,
      }),
    );
  }

  private async onModelCommand(
    interaction: ChatInputCommandInteraction<CacheType>,
    cfg: CoreConfig,
  ): Promise<void> {
    const channelId = interaction.channelId;
    const guildId = interaction.guildId;

    if (!channelId) {
      await tryReplyEphemeral(interaction, "This command must be used in a channel.");
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      await tryReplyEphemeral(interaction, "Not allowed in this channel.");
      return;
    }

    const parentChannelId = this.getParentChannelIdFromInteractionChannel(interaction);
    const currentRef = this.getSessionModelRef({
      cfg,
      sessionId: channelId,
      parentChannelId,
      guildId,
    });

    const modelInput = interaction.options.getString("model");
    const trimmedModelInput = modelInput?.trim() ?? "";

    if (trimmedModelInput.length === 0) {
      let resolvedDisplay = currentRef;
      const resolved = resolveModelRefResult(
        cfg,
        { model: currentRef },
        "surface.discord.slash.model.current",
      );
      resolvedDisplay = resolved.match({ ok: (value) => value.spec, err: () => resolvedDisplay });

      await tryReplyEphemeral(
        interaction,
        `Current model for this session: \`${currentRef}\` (resolved: \`${resolvedDisplay}\`)`,
      );
      return;
    }

    const resolved = resolveModelRefResult(
      cfg,
      { model: trimmedModelInput },
      "surface.discord.slash.model.override",
    );
    const resolveError = resolved.match({ ok: () => null, err: (error) => error });
    if (resolveError) {
      switch (resolveError._tag) {
        case "ModelResolutionFailed":
          await tryReplyEphemeral(interaction, `Invalid model: ${resolveError.message}`);
          return;
      }
    }
    const resolvedSpec = selectResultValue(resolved).spec;

    this.sessionModelOverrides.set(channelId, trimmedModelInput);

    await tryReplyEphemeral(
      interaction,
      `Session model set to \`${trimmedModelInput}\` (resolved: \`${resolvedSpec}\`)`,
    );
  }

  private async fetchDiscordMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<Message | null> {
    const cfg = this.cfg;
    const client = this.client;
    if (!cfg || !client) {
      throw new DiscordAdapterUnavailable({ message: "Discord adapter is not connected" });
    }

    const fetchedChannel = await Result.tryPromise({
      try: () => client.channels.fetch(input.channelId),
      catch: captureDiscordSurfaceError,
    });
    const channelOutcome = fetchedChannel.match<
      | {
          readonly kind: "value";
          readonly value: Awaited<ReturnType<Client["channels"]["fetch"]>>;
        }
      | { readonly kind: "missing" }
      | { readonly kind: "failure"; readonly cause: Error | Panic }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (cause) => {
        if (Panic.is(cause)) return { kind: "failure", cause };
        if (discordNotFoundCode(cause) !== null) return { kind: "missing" };
        return { kind: "failure", cause };
      },
    });
    if (channelOutcome.kind === "failure") {
      return adaptToolResultToHost(Result.err(channelOutcome.cause));
    }
    const ch = channelOutcome.kind === "value" ? channelOutcome.value : null;
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return null;
    const messageChannel = ch;

    const fetchedMessage = await Result.tryPromise({
      try: () =>
        messageChannel.messages.fetch({
          message: input.messageId,
          cache: false,
          force: true,
        }),
      catch: captureDiscordSurfaceError,
    });
    const messageOutcome = fetchedMessage.match<
      | { readonly kind: "value"; readonly value: Message }
      | { readonly kind: "missing" }
      | { readonly kind: "failure"; readonly cause: Error | Panic }
    >({
      ok: (value) => ({ kind: "value", value }),
      err: (cause) => {
        if (Panic.is(cause)) return { kind: "failure", cause };
        if (discordNotFoundCode(cause) !== null) return { kind: "missing" };
        return { kind: "failure", cause };
      },
    });
    if (messageOutcome.kind === "failure") {
      return adaptToolResultToHost(Result.err(messageOutcome.cause));
    }
    const msg = messageOutcome.kind === "value" ? messageOutcome.value : null;
    if (!msg) return null;

    if (
      !shouldAllowMessage({
        cfg,
        channelId: input.channelId,
        guildId: msg.guildId,
      })
    ) {
      return null;
    }

    return msg;
  }

  private fetchRequestScopedDiscordMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<Message | null> {
    const snapshots = this.requestReadSnapshots.getStore();
    if (!snapshots) return this.fetchDiscordMessage(input);

    const key = `${input.channelId}:${input.messageId}`;
    const existing = snapshots.get(key);
    if (existing) return existing;

    const pending = this.fetchDiscordMessage(input);
    snapshots.set(key, pending);
    return pending;
  }

  private async resolveRequestReadSnapshots(messages: readonly Message[]): Promise<Message[]> {
    const snapshots = this.requestReadSnapshots.getStore();
    if (!snapshots) return [...messages];

    const resolved = await Promise.all(
      messages.map((message) => {
        const key = `${message.channelId}:${message.id}`;
        const existing = snapshots.get(key);
        if (existing) return existing;

        const admitted = Promise.resolve(message);
        snapshots.set(key, admitted);
        return admitted;
      }),
    );
    return resolved.filter((message): message is Message => message !== null);
  }

  private async fetchLatestDiscordMessage(channelId: string): Promise<Message | null> {
    const list = await this.fetchDiscordMessages({ channelId, limit: 1 });
    return list[0] ?? null;
  }

  private async fetchDiscordMessages(input: {
    channelId: string;
    limit: number;
    beforeMessageId?: string;
    afterMessageId?: string;
    aroundMessageId?: string;
  }): Promise<Message[]> {
    const cfg = this.cfg;
    const client = this.client;
    if (!cfg || !client) {
      throw new DiscordAdapterUnavailable({ message: "Discord adapter is not connected" });
    }

    const ch = await client.channels.fetch(input.channelId);
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return [];

    // Allowlist is channel/guild scoped; for list operations the channel is authoritative.
    const guildId = "guildId" in ch ? ch.guildId : null;

    if (!shouldAllowMessage({ cfg, channelId: input.channelId, guildId })) {
      return [];
    }

    const limit = Math.min(200, Math.max(1, Math.floor(input.limit)));

    // `around` and `after` are not paged (Discord API caps at 100 anyway).
    if (input.aroundMessageId) {
      const res = await ch.messages.fetch({
        limit: Math.min(100, limit),
        around: input.aroundMessageId,
        cache: false,
      });
      const messages = [...res.values()];
      return await this.resolveRequestReadSnapshots(messages);
    }

    if (input.afterMessageId) {
      const res = await ch.messages.fetch({
        limit: Math.min(100, limit),
        after: input.afterMessageId,
        cache: false,
      });
      const messages = [...res.values()];
      return await this.resolveRequestReadSnapshots(messages);
    }

    // Default / before-cursor: page backwards using `before`.
    const out: Message[] = [];
    let before = input.beforeMessageId;

    while (out.length < limit) {
      const pageSize = Math.min(100, limit - out.length);
      const res = await ch.messages.fetch({
        limit: pageSize,
        before,
        cache: false,
      });

      const page = [...res.values()];
      if (page.length === 0) break;

      out.push(...page);

      // `res.values()` yields newest->oldest; the last entry is the oldest.
      before = page[page.length - 1]!.id;
    }

    return await this.resolveRequestReadSnapshots(out);
  }

  private toSurfaceMessageFromDiscordMessageResult(
    msg: Message,
  ): ResultType<SurfaceMessage, DiscordAdapterUnavailable> {
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) {
      return Result.err(new DiscordAdapterUnavailable({ message: "DiscordAdapter not connected" }));
    }

    const channelId = msg.channelId;
    const guildId = msg.guildId;

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind = resolveDiscordSessionKind(
      "isDMBased" in msg.channel &&
        typeof msg.channel.isDMBased === "function" &&
        msg.channel.isDMBased(),
      parentChannelId,
    );

    this.upsertMessageRelationFromDiscordMessage(msg);

    // Keep lightweight metadata caches warm (names/sessions), but do not cache message bodies.
    store.upsertSession({
      channelId,
      guildId: guildId ?? undefined,
      parentChannelId: parentChannelId ?? undefined,
      name: channelName,
      type: sessionKind,
      updatedTs: Date.now(),
      raw: {
        channel: { id: channelId, name: channelName, guildId, parentChannelId },
      },
    });

    if (channelName) {
      store.upsertChannelName({
        channelId,
        name: channelName,
        updatedTs: Date.now(),
      });
    }

    const authorName = getDisplayName(msg);

    store.upsertUserName({
      userId: msg.author.id,
      username: msg.author.username,
      globalName: msg.author.globalName ?? undefined,
      displayName: authorName,
      updatedTs: Date.now(),
    });

    const ts = getMessageTs(msg);
    const editedTs = getMessageEditedTs(msg);

    const attachments = collectDiscordAttachmentMeta(msg.attachments.values());
    const embeds = getMessageEmbeds(msg);
    const reference = normalizeDiscordReference(msg);
    const forwardSnapshot = getForwardSnapshotPayload(msg);
    const messageSnapshots = buildForwardMessageSnapshots(forwardSnapshot);
    const storedText = getStoredTextFromDiscordMessage({ msg, forwardSnapshot });
    const normalizedText = this.entityMapper?.normalizeIncomingText(storedText) ?? storedText;

    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId,
    });
    const sessionModelOverride = this.getInMemorySessionModelOverride({
      sessionId: channelId,
      parentChannelId,
    });

    return Result.ok({
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedText,
      ts,
      editedTs,
      deleted: false,
      raw: {
        id: msg.id,
        channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        embeds,
        reference: reference ?? undefined,
        messageSnapshots,
        editedTs,
        attachments,
        discord: {
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
          referenceType: reference?.type,
          messageSnapshots,
          sessionModelOverride,
        },
      },
    });
  }

  private async onMessageCreate(msg: Message | PartialMessage, receivedAt: number = Date.now()) {
    if (msg.partial) {
      const fetched = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => msg.fetch(),
          catch: captureNullSurfaceFallback,
        }),
      );
      const full = selectResultValueOr(fetched, null);
      if (!full) return;
      await this.onMessageCreate(full, receivedAt);
      return;
    }

    await this.reloadCoreConfigIfNeeded();

    const cfg = this.cfg;
    const store = this.store;
    const client = this.client;
    if (!cfg || !store || !client) return;

    // Only route real user chat messages to the request router.
    // We still want to record lightweight metadata (names/sessions) for context.
    const shouldEmitAdapterEvent = isRoutableDiscordUserMessage(msg);

    const guildId = msg.guildId;
    const channelId = msg.channelId;

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      this.logger.debug("message ignored (not allowlisted)", {
        channelId,
        guildId,
        messageId: msg.id,
        userId: msg.author.id,
      });
      return;
    }

    // Updates feed search indexing without admitting bot output to the request router.
    if (msg.author.bot && isDiscordChatLikeMessage(msg)) {
      await this.onMessageUpdate(msg);
      return;
    }

    if (shouldEmitAdapterEvent) {
      beginDiscordMessageLatencyTrace({
        requestId: formatDiscordMessageRequestId({ channelId, messageId: msg.id }),
        sessionId: channelId,
        messageId: msg.id,
        receivedAt,
      });
    }

    this.upsertMessageRelationFromDiscordMessage(msg);

    this.logger.debug("message received", {
      channelId,
      guildId,
      messageId: msg.id,
      userId: msg.author.id,
      isBot: msg.author.bot,
      text:
        typeof msg.content === "string" && msg.content.trim().length > 0
          ? previewText(msg.content)
          : undefined,
    });

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind = resolveDiscordSessionKind(
      "isDMBased" in msg.channel &&
        typeof msg.channel.isDMBased === "function" &&
        msg.channel.isDMBased(),
      parentChannelId,
    );

    store.upsertSession({
      channelId,
      guildId: guildId ?? undefined,
      parentChannelId: parentChannelId ?? undefined,
      name: channelName,
      type: sessionKind,
      updatedTs: Date.now(),
      raw: {
        channel: { id: channelId, name: channelName, guildId, parentChannelId },
      },
    });

    if (channelName) {
      store.upsertChannelName({
        channelId,
        name: channelName,
        updatedTs: Date.now(),
      });
    }

    if (guildId) {
      for (const [roleId, role] of msg.mentions.roles) {
        store.upsertRoleName({
          guildId,
          roleId,
          name: role.name,
          updatedTs: Date.now(),
        });
      }
    }

    for (const [mentionedChannelId, ch] of msg.mentions.channels) {
      const name = "name" in ch ? ch.name : undefined;
      if (typeof name === "string") {
        store.upsertChannelName({
          channelId: mentionedChannelId,
          name,
          updatedTs: Date.now(),
        });
      }
    }

    const authorName = getDisplayName(msg);

    store.upsertUserName({
      userId: msg.author.id,
      username: msg.author.username,
      globalName: msg.author.globalName ?? undefined,
      displayName: authorName,
      updatedTs: Date.now(),
    });

    // Mentioned users
    for (const [id, u] of msg.mentions.users) {
      const member = msg.mentions.members?.get(id);
      const displayName =
        (member && "displayName" in member ? member.displayName : undefined) ??
        u.globalName ??
        u.username;
      store.upsertUserName({
        userId: id,
        username: u.username,
        globalName: u.globalName ?? undefined,
        displayName,
        updatedTs: Date.now(),
      });
    }

    const ts = getMessageTs(msg);
    const editedTs = getMessageEditedTs(msg);

    const attachments = collectDiscordAttachmentMeta(msg.attachments.values());
    const embeds = getMessageEmbeds(msg);
    const reference = normalizeDiscordReference(msg);
    const replyRef = getReplyReference(msg);
    const forwardSnapshot = getForwardSnapshotPayload(msg);
    const messageSnapshots = buildForwardMessageSnapshots(forwardSnapshot);
    const storedText = getStoredTextFromDiscordMessage({ msg, forwardSnapshot });
    const normalizedText = this.entityMapper?.normalizeIncomingText(storedText) ?? storedText;

    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId,
    });
    const sessionModelOverride = this.getInMemorySessionModelOverride({
      sessionId: channelId,
      parentChannelId,
    });

    if (!shouldEmitAdapterEvent) return;

    const botId = client.user?.id;
    if (!botId) return;

    const isMention = isExplicitDiscordUserMention({
      content: msg.content ?? "",
      userId: botId,
      hasParsedMention: msg.mentions.users.has(botId),
    });
    const isReplyToBot = await this.isReplyToBot(msg, botId);

    const surfaceMsg: SurfaceMessage = {
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedText,
      ts,
      editedTs,
      raw: {
        content: msg.content,
        embeds,
        reference: reference ?? undefined,
        messageSnapshots,
        editedTs,
        attachments,
        discord: {
          id: msg.id,
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
          isDMBased: sessionKind === "dm",
          botUserId: botId,
          mentionsBot: isMention,
          replyToBot: isReplyToBot,
          replyToMessageId: replyRef?.messageId,
          referenceType: reference?.type,
          guildId: guildId ?? undefined,
          parentChannelId: parentChannelId ?? undefined,
          sessionModelOverride,
          attachments,
          messageSnapshots,
        },
      },
    };

    this.emit({
      type: "adapter.message.created",
      platform: "discord",
      ts: Date.now(),
      message: surfaceMsg,
      channelName,
    });
  }

  private async isReplyToBot(msg: Message, botUserId: string): Promise<boolean> {
    const client = this.client;
    if (!client) return false;

    const replyRef = getReplyReference(msg);
    if (!replyRef) return false;

    const channel = msg.channel;
    if (!channel?.messages?.fetch) return false;
    const cached = channel.messages.cache.get(replyRef.messageId);
    if (cached) return cached.author?.id === botUserId;
    const fetched = settleSurfaceFallback(
      await Result.tryPromise({
        try: () =>
          channel.messages.fetch({ message: replyRef.messageId, cache: false, force: true }),
        catch: captureNullSurfaceFallback,
      }),
    );
    return fetched.match({ ok: (value) => value?.author?.id === botUserId, err: () => false });
  }

  private async onMessageUpdate(msg: Message | PartialMessage) {
    if (msg.partial) {
      const fetched = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => msg.fetch(),
          catch: captureNullSurfaceFallback,
        }),
      );
      const full = selectResultValueOr(fetched, null);
      if (!full) return;
      await this.onMessageUpdate(full);
      return;
    }
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    const guildId = msg.guildId;
    const channelId = msg.channelId;
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    this.upsertMessageRelationFromDiscordMessage(msg);

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind = resolveDiscordSessionKind(
      "isDMBased" in msg.channel &&
        typeof msg.channel.isDMBased === "function" &&
        msg.channel.isDMBased(),
      parentChannelId,
    );

    store.upsertSession({
      channelId,
      guildId: guildId ?? undefined,
      parentChannelId: parentChannelId ?? undefined,
      name: channelName,
      type: sessionKind,
      updatedTs: Date.now(),
      raw: {
        channel: { id: channelId, name: channelName, guildId, parentChannelId },
      },
    });

    if (channelName) {
      store.upsertChannelName({
        channelId,
        name: channelName,
        updatedTs: Date.now(),
      });
    }

    const ts = getMessageTs(msg);
    const editedTs = getMessageEditedTs(msg);

    const attachments = collectDiscordAttachmentMeta(msg.attachments.values());
    const embeds = getMessageEmbeds(msg);
    const reference = normalizeDiscordReference(msg);
    const replyRef = getReplyReference(msg);
    const forwardSnapshot = getForwardSnapshotPayload(msg);
    const messageSnapshots = buildForwardMessageSnapshots(forwardSnapshot);
    const storedText = getStoredTextFromDiscordMessage({ msg, forwardSnapshot });
    const normalizedText = this.entityMapper?.normalizeIncomingText(storedText) ?? storedText;

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    const authorName = getDisplayName(msg);

    store.upsertUserName({
      userId: msg.author.id,
      username: msg.author.username,
      globalName: msg.author.globalName ?? undefined,
      displayName: authorName,
      updatedTs: Date.now(),
    });

    const surfaceMsg: SurfaceMessage = {
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedText,
      ts,
      editedTs,
      raw: {
        content: msg.content,
        embeds,
        reference: reference ?? undefined,
        messageSnapshots,
        editedTs,
        attachments,
        discord: {
          id: msg.id,
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
          // Best-effort: Discord update event may not expose channel type reliably.
          isDMBased: sessionKind === "dm",
          mentionsBot: false,
          replyToBot: false,
          replyToMessageId: replyRef?.messageId,
          referenceType: reference?.type,
          guildId: guildId ?? undefined,
          parentChannelId: parentChannelId ?? undefined,
          attachments,
          messageSnapshots,
        },
      },
    };

    this.emit({
      type: "adapter.message.updated",
      platform: "discord",
      ts: Date.now(),
      message: surfaceMsg,
      channelName,
    });
  }

  private async onMessageDelete(msg: Message | null, messageId: string, channelId: string) {
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    // We only persist immutable relation metadata + deletion state (no message body cache).
    let guildId: string | null = msg?.guildId ?? null;

    // If we didn't get a guild id from the event, best-effort resolve from channel.
    if (!guildId) {
      const client = this.client;
      const fetched = client
        ? settleSurfaceFallback(
            await Result.tryPromise({
              try: () => client.channels.fetch(channelId),
              catch: captureNullSurfaceFallback,
            }),
          )
        : Result.ok(null);
      const ch = selectResultValueOr(fetched, null);
      guildId = ch && "guildId" in ch ? ch.guildId : null;
    }

    // Allowlist check should still apply even when Discord sends partial delete events.
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    store.markMessageRelationDeleted({
      channelId,
      messageId,
      updatedTs: Date.now(),
    });

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    this.emit({
      type: "adapter.message.deleted",
      platform: "discord",
      ts: Date.now(),
      messageRef: asDiscordMsgRef(channelId, messageId),
      session: sessionRef,
      channelName: sess?.name ?? undefined,
      raw: msg ? { discord: { id: msg.id } } : undefined,
    });
  }

  private async onReactionAdd(
    msg: Message | PartialMessage,
    reaction: string,
    userId?: string,
    userName?: string,
  ) {
    if (msg.partial) {
      const fetched = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => msg.fetch(),
          catch: captureNullSurfaceFallback,
        }),
      );
      const full = selectResultValueOr(fetched, null);
      if (!full) return;
      await this.onReactionAdd(full, reaction, userId, userName);
      return;
    }
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    const channelId = msg.channelId;
    const guildId = msg.guildId;
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    if (userId && userName) {
      store.upsertUserName({
        userId,
        username: userName,
        displayName: userName,
        updatedTs: Date.now(),
      });
    }

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    this.emit({
      type: "adapter.reaction.added",
      platform: "discord",
      ts: Date.now(),
      messageRef: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      channelName: sess?.name ?? getChannelName(msg.channel),
      reaction,
      userId,
      userName,
      raw: { discord: { reaction } },
    });
  }

  private async onReactionRemove(
    msg: Message | PartialMessage,
    reaction: string,
    userId?: string,
    userName?: string,
  ) {
    if (msg.partial) {
      const fetched = settleSurfaceFallback(
        await Result.tryPromise({
          try: () => msg.fetch(),
          catch: captureNullSurfaceFallback,
        }),
      );
      const full = selectResultValueOr(fetched, null);
      if (!full) return;
      await this.onReactionRemove(full, reaction, userId, userName);
      return;
    }
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    const channelId = msg.channelId;
    const guildId = msg.guildId;
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    if (userId && userName) {
      store.upsertUserName({
        userId,
        username: userName,
        displayName: userName,
        updatedTs: Date.now(),
      });
    }

    const sess = store.getSession(channelId);
    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId: sess?.parent_channel_id,
    });

    this.emit({
      type: "adapter.reaction.removed",
      platform: "discord",
      ts: Date.now(),
      messageRef: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      channelName: sess?.name ?? getChannelName(msg.channel),
      reaction,
      userId,
      userName,
      raw: { discord: { reaction } },
    });
  }
}
