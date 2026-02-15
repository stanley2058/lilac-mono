import {
  ActivityType,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  Client,
  type CacheType,
  type ChatInputCommandInteraction,
  GatewayIntentBits,
  MessageFlags,
  type MessageContextMenuCommandInteraction,
  MessageType,
  Partials,
  type Interaction,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type TextBasedChannel,
  type User,
} from "discord.js";
import type {
  EvtAdapterMessageCreatedData,
  EvtAdapterMessageDeletedData,
  EvtAdapterMessageUpdatedData,
  EvtAdapterReactionAddedData,
  EvtAdapterReactionRemovedData,
} from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import {
  getCoreConfig,
  resolveLogLevel,
  resolveDiscordDbPath,
  resolveDiscordToken,
} from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
} from "../types";
import type { AdapterEvent } from "../events";
import type {
  AdapterEventHandler,
  AdapterSubscription,
  StartOutputOpts,
  SurfaceAdapter,
} from "../adapter";
import { createDiscordEntityMapper, type EntityMapper } from "../../entity/entity-mapper";
import { DiscordSurfaceStore } from "../store/discord-surface-store";
import { DiscordOutputStream, sendDiscordStyledMessage } from "./output/discord-output-stream";
import { parseCancelCustomId } from "./discord-cancel";
import { buildDiscordSessionDividerText } from "./discord-session-divider";

export type DiscordAdapterOptions = {
  /** Dependency injection for tests. */
  config?: CoreConfig;
};

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

function getChannelName<T extends { isDMBased?: () => boolean } | { name?: string }>(
  channel: T | null,
): string | undefined {
  if (!channel) return undefined;
  if ("isDMBased" in channel && typeof channel.isDMBased === "function" && channel.isDMBased()) {
    return "dm";
  }
  const n = "name" in channel ? channel.name : undefined;
  return typeof n === "string" ? n : undefined;
}

function getMessageTs(msg: Message): number {
  // createdTimestamp is ms
  return msg.createdTimestamp;
}

function getMessageEditedTs(msg: Message): number | undefined {
  return msg.editedTimestamp ?? undefined;
}

function getDisplayName(msg: Message): string {
  const memberName = msg.member && "displayName" in msg.member ? msg.member.displayName : undefined;
  return memberName ?? msg.author.globalName ?? msg.author.username;
}

function getEmbedDescriptions(msg: Message): string[] {
  const out: string[] = [];
  for (const emb of msg.embeds) {
    const d = emb.description;
    if (typeof d === "string" && d.trim().length > 0) {
      out.push(d);
    }
  }
  return out;
}

function getDisplayTextFromDiscordMessage(msg: Message): string {
  const content = msg.content ?? "";
  if (content.trim().length > 0) return content;

  const desc = getEmbedDescriptions(msg).join("\n\n").trim();
  if (desc.length > 0) return desc;

  return "";
}

function isDiscordChatLikeMessage(msg: Message): boolean {
  // Treat only real chat/reply messages as context candidates.
  // Discord system messages can still have MessageType.Default; exclude via `msg.system`.
  if (msg.system) return false;
  return msg.type === MessageType.Default || msg.type === MessageType.Reply;
}

function getDiscordMessageTypeName(msg: Message): string {
  // `MessageType` is a numeric enum; reverse mapping yields a stable label.
  const name = (MessageType as unknown as Record<number, unknown>)[msg.type];
  return typeof name === "string" && name.length > 0 ? name : String(msg.type);
}

function previewText(text: string, max = 400): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

function shouldAllowMessage(params: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): boolean {
  const allowedChannelIds = new Set(params.cfg.surface.discord.allowedChannelIds);
  const allowedGuildIds = new Set(params.cfg.surface.discord.allowedGuildIds);

  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return false;

  if (allowedChannelIds.has(params.channelId)) return true;

  const gid = params.guildId ?? null;
  if (gid && allowedGuildIds.has(gid)) return true;

  return false;
}

type SendableDiscordChannel = {
  send(options: unknown): Promise<unknown>;
};

function isTextSendableChannel(ch: unknown): ch is SendableDiscordChannel {
  if (!ch || typeof ch !== "object") return false;
  if (!("send" in ch)) return false;
  const send = (ch as Record<string, unknown>)["send"];
  return typeof send === "function";
}

export function isRoutableDiscordUserMessage(msg: Message): boolean {
  if (msg.author.bot) return false;
  if (msg.system) return false;

  return msg.type === MessageType.Default || msg.type === MessageType.Reply;
}

function compareDiscordSnowflake(a: string, b: string): number {
  // Prefer numeric comparison (snowflakes are numeric strings).
  // Fall back to localeCompare if parsing fails.
  try {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  } catch {
    return a.localeCompare(b);
  }
}

const CONTEXT_MENU_CANCEL_REQUEST_NAME = "Cancel Request";

export class DiscordAdapter implements SurfaceAdapter {
  private client: Client | null = null;
  private store: DiscordSurfaceStore | null = null;
  private cfg: CoreConfig | null = null;
  private entityMapper: EntityMapper | null = null;
  private handlers = new Set<AdapterEventHandler>();

  private readonly logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "surface:discord",
  });

  private self: SurfaceSelf | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts?: DiscordAdapterOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const cfg = this.opts?.config ?? (await getCoreConfig());
    this.cfg = cfg;

    this.logger.info("connecting", {
      botName: cfg.surface.discord.botName,
      tokenEnv: cfg.surface.discord.tokenEnv,
      allowedChannelIds: cfg.surface.discord.allowedChannelIds.length,
      allowedGuildIds: cfg.surface.discord.allowedGuildIds.length,
    });

    const dbPath = resolveDiscordDbPath(cfg);
    this.store = new DiscordSurfaceStore(dbPath);
    this.entityMapper = createDiscordEntityMapper({ cfg, store: this.store });

    this.logger.info("discord store initialized", { dbPath });

    const token = resolveDiscordToken(cfg);

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });

    client.on("clientReady", async () => {
      const user = client.user;
      if (!user) return;

      const botName = cfg.surface.discord.botName;

      this.self = {
        platform: "discord",
        userId: user.id,
        userName: botName,
      };

      this.logger.info("ready", {
        userId: user.id,
        botName,
      });

      // Register/refresh slash commands on boot.
      // Strategy:
      // 1) check existence
      // 2) ALWAYS update if exists
      // 3) register if not exist
      // This avoids stale command definitions when iterating.
      await this.registerSlashCommands().catch((e: unknown) => {
        this.logger.error("slash command registration failed", e);
      });

      const statusMessage = cfg.surface.discord.statusMessage;
      const applyPresence = () => {
        if (!statusMessage) return;
        try {
          client.user?.setPresence({
            activities: [
              {
                name: statusMessage,
                state: statusMessage,
                type: ActivityType.Custom,
              },
            ],
            status: "online",
          });
        } catch {
          // ignore
        }
      };

      applyPresence();

      // Discord can clear custom presence over time; refresh periodically.
      if (statusMessage) {
        this.presenceTimer = setInterval(
          () => {
            applyPresence();
          },
          30 * 60 * 1000,
        );
      }
    });

    client.on("messageCreate", async (msg) => {
      await this.onMessageCreate(msg);
    });

    client.on("messageUpdate", async (_old, next) => {
      const msg = next.partial ? await next.fetch().catch(() => null) : next;
      if (!msg) return;
      await this.onMessageUpdate(msg);
    });

    client.on("messageDelete", async (deleted) => {
      const msg = deleted.partial ? await deleted.fetch().catch(() => null) : deleted;
      await this.onMessageDelete(msg, deleted.id, deleted.channelId);
    });

    client.on("messageReactionAdd", async (reaction, user) => {
      const r = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
      if (!r) return;
      await this.onReactionAdd(
        r.message,
        r.emoji.toString(),
        user?.id,
        user?.username ?? undefined,
      );
    });

    client.on("messageReactionRemove", async (reaction, user) => {
      const r = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
      if (!r) return;
      await this.onReactionRemove(
        r.message,
        r.emoji.toString(),
        user?.id,
        user?.username ?? undefined,
      );
    });

    client.on("interactionCreate", async (interaction) => {
      await this.onInteractionCreate(interaction);
    });

    await client.login(token);

    this.logger.info("login ok");

    this.client = client;
  }

  async disconnect(): Promise<void> {
    this.logger.info("disconnecting");

    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }

    const c = this.client;
    this.client = null;

    try {
      await c?.destroy();
    } catch {
      // ignore
    }

    this.store?.close();
    this.store = null;
    this.entityMapper = null;

    this.logger.info("disconnected");
  }

  async getSelf(): Promise<SurfaceSelf> {
    if (this.self) return this.self;
    if (!this.client?.user || !this.cfg) {
      throw new Error("DiscordAdapter not connected");
    }
    return {
      platform: "discord",
      userId: this.client.user.id,
      userName: this.cfg.surface.discord.botName,
    };
  }

  async getCapabilities(): Promise<AdapterCapabilities> {
    return {
      platform: "discord",
      send: true,
      edit: true,
      delete: true,
      reactions: true,
      readHistory: true,
      threads: true,
      markRead: true,
    };
  }

  async listSessions(): Promise<SurfaceSession[]> {
    const store = this.mustStore();
    const sessions = store.listSessions();
    return sessions.map((s) => ({
      ref: asDiscordSessionRef({
        channelId: s.channel_id,
        guildId: s.guild_id,
        parentChannelId: s.parent_channel_id,
      }),
      title: s.name ?? undefined,
      kind: s.type,
    }));
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

    const ch =
      client.channels.cache.get(channelId) ??
      (await client.channels.fetch(channelId).catch(() => null));
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

  /** Lightweight Discord API fetch to get a channel's guildId (no history). */
  async fetchGuildIdForChannel(channelId: string): Promise<string | null> {
    const client = this.mustClient();

    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return null;

    return ch && "guildId" in ch ? ch.guildId : null;
  }

  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<import("../adapter").SurfaceOutputStream> {
    const cfg = this.cfg;
    const client = this.mustClient();
    if (!cfg) throw new Error("DiscordAdapter not connected");

    // TODO: plumb config for smart splitting.
    const useSmartSplitting = true;

    const mentionCfg = cfg.surface.discord.mentionNotifications;
    const mentionPingEnabled = mentionCfg.enabled === true && opts?.sessionMode === "active";

    return new DiscordOutputStream({
      client,
      sessionRef,
      opts,
      useSmartSplitting,
      rewriteText: this.entityMapper?.rewriteOutgoingText,
      reasoningDisplayMode: cfg.agent.reasoningDisplay ?? "simple",
      mentionPing: {
        enabled: mentionPingEnabled,
        maxUsers: mentionCfg.maxUsers,
        extractUserIds: this.entityMapper?.extractOutgoingMentionUserIds,
      },
    });
  }

  async startTyping(sessionRef: SessionRef): Promise<{ stop(): Promise<void> }> {
    const client = this.mustClient();
    if (sessionRef.platform !== "discord") {
      throw new Error("Unsupported platform");
    }

    const ch = (await client.channels
      .fetch(sessionRef.channelId)
      .catch(() => null)) as TextBasedChannel | null;

    const sendTyping = ch && "sendTyping" in ch ? ch.sendTyping : null;

    if (!sendTyping) return { stop: async () => {} };

    // Discord typing indicators last ~10s; refresh a bit earlier.
    const REFRESH_MS = 8000;

    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let consecutiveFailures = 0;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const tick = async () => {
      if (stopped) return;
      try {
        await sendTyping.call(ch);
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
        // Best-effort: avoid spamming if missing perms / rate-limited.
        if (consecutiveFailures >= 3) {
          stop();
        }
      }
    };

    // Fire once immediately, then refresh.
    tick().catch((e) => this.logger.error(e));
    timer = setInterval(() => {
      tick().catch((e) => this.logger.error(e));
    }, REFRESH_MS);

    return {
      stop: async () => {
        stop();
      },
    };
  }

  async sendMsg(sessionRef: SessionRef, content: ContentOpts, opts?: SendOpts): Promise<MsgRef> {
    const client = this.mustClient();
    if (sessionRef.platform !== "discord") throw new Error("Unsupported platform");

    const useSmartSplitting = true;

    return await sendDiscordStyledMessage({
      client,
      sessionRef,
      content,
      opts: opts?.replyTo ? { replyTo: opts.replyTo } : undefined,
      useSmartSplitting,
      rewriteText: this.entityMapper?.rewriteOutgoingText,
    });
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const msg = await this.fetchDiscordMessage({
      channelId: msgRef.channelId,
      messageId: msgRef.messageId,
    });

    if (!msg) return null;

    return this.toSurfaceMessageFromDiscordMessage(msg);
  }

  async listMsg(sessionRef: SessionRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    if (sessionRef.platform !== "discord") throw new Error("Unsupported platform");

    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));

    const messages = await this.fetchDiscordMessages({
      channelId: sessionRef.channelId,
      limit,
      beforeMessageId: opts?.beforeMessageId,
      afterMessageId: opts?.afterMessageId,
    });

    return messages.map((m) => this.toSurfaceMessageFromDiscordMessage(m));
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<void> {
    const client = this.mustClient();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const channel = await client.channels.fetch(msgRef.channelId).catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      throw new Error(`Discord channel not found: ${msgRef.channelId}`);
    }

    const msg = await channel.messages.fetch(msgRef.messageId);

    const raw = content.text ?? "";
    const rewritten = this.entityMapper?.rewriteOutgoingText(raw) ?? raw;
    await msg.edit({ content: rewritten });
  }

  async deleteMsg(msgRef: MsgRef): Promise<void> {
    const client = this.mustClient();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const channel = await client.channels.fetch(msgRef.channelId).catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      throw new Error(`Discord channel not found: ${msgRef.channelId}`);
    }

    const msg = await channel.messages.fetch(msgRef.messageId);
    await msg.delete();
  }

  async getReplyContext(msgRef: MsgRef, opts?: LimitOpts): Promise<SurfaceMessage[]> {
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));

    const messages = await this.fetchDiscordMessages({
      channelId: msgRef.channelId,
      limit,
      aroundMessageId: msgRef.messageId,
    });

    return messages
      .map((m) => this.toSurfaceMessageFromDiscordMessage(m))
      .sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return compareDiscordSnowflake(a.ref.messageId, b.ref.messageId);
      });
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<void> {
    const client = this.mustClient();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const channel = await client.channels.fetch(msgRef.channelId).catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      throw new Error(`Discord channel not found: ${msgRef.channelId}`);
    }
    const msg = await channel.messages.fetch({
      message: msgRef.messageId,
      cache: false,
      force: true,
    });
    await msg.react(reaction);
  }

  async removeReaction(msgRef: MsgRef, reaction: string): Promise<void> {
    const client = this.mustClient();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const channel = await client.channels.fetch(msgRef.channelId).catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      throw new Error(`Discord channel not found: ${msgRef.channelId}`);
    }
    const msg = await channel.messages.fetch({
      message: msgRef.messageId,
      cache: false,
      force: true,
    });
    const r = msg.reactions.resolve(reaction);
    await r?.remove();
  }

  async listReactions(msgRef: MsgRef): Promise<string[]> {
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const msg = await this.fetchDiscordMessage({
      channelId: msgRef.channelId,
      messageId: msgRef.messageId,
    });
    if (!msg) return [];

    return [...new Set([...msg.reactions.cache.values()].map((r) => r.emoji.toString()))].sort(
      (a, b) => a.localeCompare(b),
    );
  }

  async listReactionDetails(msgRef: MsgRef): Promise<SurfaceReactionDetail[]> {
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const store = this.mustStore();

    const msg = await this.fetchDiscordMessage({
      channelId: msgRef.channelId,
      messageId: msgRef.messageId,
    });
    if (!msg) return [];

    const now = Date.now();

    const out: SurfaceReactionDetail[] = [];
    const reactions = [...msg.reactions.cache.values()];

    for (const reaction of reactions) {
      const emoji = reaction.emoji.toString();

      const users = await this.fetchAllReactionUsers(reaction, {
        maxUsers: 1000,
      });

      const list = [...users.values()]
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

    return out;
  }

  private async fetchAllReactionUsers(
    reaction: MessageReaction,
    opts: { maxUsers: number },
  ): Promise<Map<string, User>> {
    const out = new Map<string, User>();

    const pageLimit = 100;
    let after: string | undefined;

    while (out.size < opts.maxUsers) {
      const res = await reaction.users
        .fetch({ limit: pageLimit, ...(after ? { after } : {}) })
        .catch(() => null);
      if (!res || res.size === 0) break;

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

    return out;
  }

  async subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription> {
    this.handlers.add(handler);
    return {
      stop: async () => {
        this.handlers.delete(handler);
      },
    };
  }

  async getUnRead(sessionRef: SessionRef): Promise<SurfaceMessage[]> {
    const store = this.mustStore();
    if (sessionRef.platform !== "discord") throw new Error("Unsupported platform");

    const rs = store.getOrInitReadState(sessionRef.channelId);

    // Best-effort: fetch a recent window and filter locally.
    const recent = await this.listMsg(sessionRef, { limit: 100 });

    const unread = recent.filter((m) => {
      if (m.deleted) return false;
      if (m.ts > rs.last_read_ts) return true;
      if (m.ts < rs.last_read_ts) return false;
      return compareDiscordSnowflake(m.ref.messageId, rs.last_read_message_id) > 0;
    });

    unread.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return compareDiscordSnowflake(a.ref.messageId, b.ref.messageId);
    });

    return unread;
  }

  async markRead(sessionRef: SessionRef, upToMsgRef?: MsgRef): Promise<void> {
    const store = this.mustStore();
    if (sessionRef.platform !== "discord") throw new Error("Unsupported platform");

    if (upToMsgRef) {
      if (upToMsgRef.platform !== "discord") throw new Error("Unsupported platform");

      const msg = await this.fetchDiscordMessage({
        channelId: upToMsgRef.channelId,
        messageId: upToMsgRef.messageId,
      });

      if (!msg) return;

      store.setReadState({
        channelId: sessionRef.channelId,
        lastReadTs: getMessageTs(msg),
        lastReadMessageId: msg.id,
      });
      return;
    }

    const latest = await this.fetchLatestDiscordMessage(sessionRef.channelId);
    if (!latest) return;
    store.setReadState({
      channelId: sessionRef.channelId,
      lastReadTs: getMessageTs(latest),
      lastReadMessageId: latest.id,
    });
  }

  // --- internals ---

  private mustClient(): Client {
    if (!this.client) throw new Error("DiscordAdapter not connected");
    return this.client;
  }

  private mustStore(): DiscordSurfaceStore {
    if (!this.store) throw new Error("DiscordAdapter not connected");
    return this.store;
  }

  private emit(evt: AdapterEvent) {
    for (const h of this.handlers) {
      Promise.resolve()
        .then(() => h(evt))
        .catch(() => {
          // ignore
        });
    }
  }

  private async onInteractionCreate(interaction: Interaction<CacheType>) {
    if (interaction.isChatInputCommand()) {
      await this.onChatInputCommand(interaction);
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      await this.onMessageContextMenuCommand(interaction);
      return;
    }

    if (!interaction.isButton()) return;

    const parsed = parseCancelCustomId(interaction.customId);
    if (!parsed) return;

    // Guard against mismatched sessions (e.g. copied components).
    if (interaction.channelId && parsed.sessionId !== interaction.channelId) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "This cancel button is not for this channel.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: "This cancel button is not for this channel.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // ignore
      }
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
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: "Cancel requested.",
          flags: MessageFlags.Ephemeral,
        });
      } else {
        await interaction.reply({
          content: "Cancel requested.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch {
      // ignore
    }
  }

  private async onMessageContextMenuCommand(
    interaction: MessageContextMenuCommandInteraction<CacheType>,
  ): Promise<void> {
    if (interaction.commandName !== CONTEXT_MENU_CANCEL_REQUEST_NAME) return;

    const cfg = this.cfg;
    if (!cfg) {
      try {
        await interaction.reply({
          content: "Bot is not ready yet.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    const channelId = interaction.channelId;
    const guildId = interaction.guildId;
    if (!channelId) {
      try {
        await interaction.reply({
          content: "This command must be used in a channel.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      try {
        await interaction.reply({
          content: "Not allowed in this channel.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    const targetMessageId = interaction.targetMessage?.id;
    if (!targetMessageId) {
      try {
        await interaction.reply({
          content: "Could not resolve target message.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    this.emit({
      type: "adapter.request.cancel",
      platform: "discord",
      ts: Date.now(),
      requestId: `discord:${channelId}:${targetMessageId}`,
      sessionId: channelId,
      cancelScope: "active_or_queued",
      source: "context_menu",
      userId: interaction.user?.id ?? undefined,
      messageId: targetMessageId,
    });

    try {
      await interaction.reply({
        content: "Cancel requested.",
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // ignore
    }
  }

  private async registerSlashCommands(): Promise<void> {
    const client = this.client;
    if (!client) return;

    const app = client.application;
    if (!app) return;

    // Ensure the application is fetched (discord.js sometimes lazily loads it).
    await app.fetch().catch(() => null);

    const slashDefinition = {
      name: "lilac",
      description: "Lilac bot commands",
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "divider",
          description: "Insert a session divider for context",
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: "label",
              description: "Optional label for the divider",
              required: false,
            },
          ],
        },
      ],
    } as const;

    const cancelContextMenuDefinition = {
      name: CONTEXT_MENU_CANCEL_REQUEST_NAME,
      type: ApplicationCommandType.Message,
    } as const;

    // Force-sync (bulk overwrite) so stale commands are removed.
    // This is intentional: we treat the current code's command list as the
    // source of truth for this application.
    const desired = [slashDefinition, cancelContextMenuDefinition];
    await app.commands.set(desired).catch((e: unknown) => {
      this.logger.error("slash command sync failed", e);
      return null;
    });
    this.logger.info("slash commands synced", {
      scope: "global",
      count: desired.length,
    });

    // Global-only strategy: clear guild-scoped commands to avoid duplicate
    // entries in Discord command pickers.
    const guilds = await client.guilds.fetch().catch(() => null);
    const guildIds = guilds ? [...guilds.keys()] : [];
    for (const guildId of guildIds) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;

      await guild.commands.set([]).catch((e: unknown) => {
        this.logger.error("guild slash command sync failed", { guildId }, e);
        return null;
      });
      this.logger.info("slash commands synced", {
        scope: "guild",
        guildId,
        count: 0,
      });
    }
  }

  private async onChatInputCommand(
    interaction: ChatInputCommandInteraction<CacheType>,
  ): Promise<void> {
    const cfg = this.cfg;
    const client = this.client;
    const self = this.self;

    if (!cfg || !client || !self) {
      // Not ready; best-effort ack.
      try {
        await interaction.reply({
          content: "Bot is not ready yet.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    if (interaction.commandName !== "lilac") return;

    const channelId = interaction.channelId;
    const guildId = interaction.guildId;

    if (!channelId) {
      try {
        await interaction.reply({
          content: "This command must be used in a channel.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    if (!shouldAllowMessage({ cfg, channelId, guildId })) {
      try {
        await interaction.reply({
          content: "Not allowed in this channel.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    let sub: string | null = null;
    try {
      sub = interaction.options.getSubcommand();
    } catch {
      sub = null;
    }

    if (sub !== "divider") {
      try {
        await interaction.reply({
          content: "Unknown subcommand.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }
      return;
    }

    const label = interaction.options.getString("label");

    const content = buildDiscordSessionDividerText({
      label,
      createdByUserId: interaction.user?.id ?? null,
      createdByUserName: interaction.user?.username ?? null,
    });

    try {
      // Defer immediately to avoid the 3s interaction timeout.
      try {
        await interaction.deferReply({
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // ignore
      }

      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!isTextSendableChannel(ch)) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: "Channel not found or not text-based.",
          });
        } else {
          await interaction.reply({
            content: "Channel not found or not text-based.",
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }

      await ch.send({
        content,
        allowedMentions: { parse: [] },
      });

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Inserted session divider." });
      } else {
        await interaction.reply({
          content: "Inserted session divider.",
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content: `Failed to insert divider: ${msg}`,
          });
        } else {
          await interaction.reply({
            content: `Failed to insert divider: ${msg}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // ignore
      }
    }
  }

  private async fetchDiscordMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<Message | null> {
    const cfg = this.cfg;
    const client = this.client;
    if (!cfg || !client) return null;

    const ch = await client.channels.fetch(input.channelId).catch(() => null);
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return null;

    const msg = await ch.messages.fetch(input.messageId).catch(() => null);
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
    if (!cfg || !client) return [];

    const ch = await client.channels.fetch(input.channelId).catch(() => null);
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return [];

    // Allowlist is channel/guild scoped; for list operations the channel is authoritative.
    const guildId = "guildId" in ch ? ch.guildId : null;

    if (!shouldAllowMessage({ cfg, channelId: input.channelId, guildId })) {
      return [];
    }

    const limit = Math.min(200, Math.max(1, Math.floor(input.limit)));

    // `around` and `after` are not paged (Discord API caps at 100 anyway).
    if (input.aroundMessageId) {
      const res = await ch.messages
        .fetch({
          limit: Math.min(100, limit),
          around: input.aroundMessageId,
        })
        .catch(() => null);
      return res ? [...res.values()] : [];
    }

    if (input.afterMessageId) {
      const res = await ch.messages
        .fetch({
          limit: Math.min(100, limit),
          after: input.afterMessageId,
        })
        .catch(() => null);
      return res ? [...res.values()] : [];
    }

    // Default / before-cursor: page backwards using `before`.
    const out: Message[] = [];
    let before = input.beforeMessageId;

    while (out.length < limit) {
      const pageSize = Math.min(100, limit - out.length);
      const res = await ch.messages
        .fetch({
          limit: pageSize,
          before,
        })
        .catch(() => null);
      if (!res) break;

      const page = [...res.values()];
      if (page.length === 0) break;

      out.push(...page);

      // `res.values()` yields newest->oldest; the last entry is the oldest.
      before = page[page.length - 1]!.id;
    }

    return out;
  }

  private toSurfaceMessageFromDiscordMessage(msg: Message): SurfaceMessage {
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) {
      throw new Error("DiscordAdapter not connected");
    }

    const channelId = msg.channelId;
    const guildId = msg.guildId;

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind: "channel" | "thread" | "dm" =
      "isDMBased" in msg.channel &&
      typeof msg.channel.isDMBased === "function" &&
      msg.channel.isDMBased()
        ? "dm"
        : parentChannelId
          ? "thread"
          : "channel";

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

    const attachments = [...msg.attachments.values()].map((a) => ({
      url: a.url,
      filename: a.name ?? undefined,
      mimeType: a.contentType ?? undefined,
      size: typeof a.size === "number" ? a.size : undefined,
    }));

    const displayText = getDisplayTextFromDiscordMessage(msg);
    const normalizedContent = this.entityMapper?.normalizeIncomingText(displayText) ?? displayText;

    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId,
    });

    return {
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedContent,
      ts,
      editedTs,
      deleted: false,
      raw: {
        id: msg.id,
        channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        embeds: getEmbedDescriptions(msg),
        reference: msg.reference ?? undefined,
        editedTs,
        attachments,
        discord: {
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
        },
      },
    };
  }

  private async onMessageCreate(msg: Message | PartialMessage) {
    if (msg.partial) {
      const full = await msg.fetch().catch(() => null);
      if (!full) return;
      await this.onMessageCreate(full);
      return;
    }
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

    const sessionKind: "channel" | "thread" | "dm" =
      "isDMBased" in msg.channel &&
      typeof msg.channel.isDMBased === "function" &&
      msg.channel.isDMBased()
        ? "dm"
        : parentChannelId
          ? "thread"
          : "channel";

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

    const attachments = [...msg.attachments.values()].map((a) => ({
      url: a.url,
      filename: a.name ?? undefined,
      mimeType: a.contentType ?? undefined,
      size: typeof a.size === "number" ? a.size : undefined,
    }));

    const displayText = getDisplayTextFromDiscordMessage(msg);
    const normalizedContent = this.entityMapper?.normalizeIncomingText(displayText) ?? displayText;

    const sessionRef = asDiscordSessionRef({
      channelId,
      guildId,
      parentChannelId,
    });

    const surfaceMsg: SurfaceMessage = {
      ref: asDiscordMsgRef(channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedContent,
      ts,
      editedTs,
      raw: {
        discord: {
          id: msg.id,
          system: msg.system,
          type: msg.type,
          typeName: getDiscordMessageTypeName(msg),
          isChat: isDiscordChatLikeMessage(msg),
          isDMBased: sessionKind === "dm",
          mentionsBot: false,
          replyToBot: false,
          replyToMessageId: msg.reference?.messageId ?? undefined,
          guildId: guildId ?? undefined,
          parentChannelId: parentChannelId ?? undefined,
          attachments,
        },
      },
    };

    // Trigger metadata for bus router is only needed when we emit an adapter event.
    if (!shouldEmitAdapterEvent) return;

    const botId = client.user?.id;
    if (!botId) return;

    const isMention = msg.mentions.users.has(botId);
    const isReplyToBot = await this.isReplyToBot(msg, botId);

    const rawDiscord = surfaceMsg.raw as { discord?: Record<string, unknown> } | undefined;
    if (rawDiscord?.discord) {
      rawDiscord.discord["mentionsBot"] = isMention;
      rawDiscord.discord["replyToBot"] = isReplyToBot;
    }

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

    const refId = msg.reference?.messageId;
    if (!refId) return false;

    try {
      const channel = msg.channel;
      if (!channel?.messages?.fetch) return false;
      const parent = await channel.messages.fetch(refId);
      return parent?.author?.id === botUserId;
    } catch {
      return false;
    }
  }

  private async onMessageUpdate(msg: Message | PartialMessage) {
    if (msg.partial) {
      const full = await msg.fetch().catch(() => null);
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

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread() ? msg.channel.parentId : null;

    const sessionKind: "channel" | "thread" | "dm" =
      "isDMBased" in msg.channel &&
      typeof msg.channel.isDMBased === "function" &&
      msg.channel.isDMBased()
        ? "dm"
        : parentChannelId
          ? "thread"
          : "channel";

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

    const attachments = [...msg.attachments.values()].map((a) => ({
      url: a.url,
      filename: a.name ?? undefined,
      mimeType: a.contentType ?? undefined,
      size: typeof a.size === "number" ? a.size : undefined,
    }));

    const displayText = getDisplayTextFromDiscordMessage(msg);
    const normalizedContent = this.entityMapper?.normalizeIncomingText(displayText) ?? displayText;

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
      text: normalizedContent,
      ts,
      editedTs,
      raw: {
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
          replyToMessageId: msg.reference?.messageId ?? undefined,
          guildId: guildId ?? undefined,
          parentChannelId: parentChannelId ?? undefined,
          attachments,
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

    // Message caching removed: do not persist deletions. Still emit the event.
    let guildId: string | null = msg?.guildId ?? null;

    // If we didn't get a guild id from the event, best-effort resolve from channel.
    if (!guildId) {
      const client = this.client;
      const ch = client ? await client.channels.fetch(channelId).catch(() => null) : null;
      guildId = ch && "guildId" in ch ? ch.guildId : null;
    }

    // Allowlist check should still apply even when Discord sends partial delete events.
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

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
      const full = await msg.fetch().catch(() => null);
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
      const full = await msg.fetch().catch(() => null);
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

// --- Bus mapping helpers (used by bridge) ---

export function toBusEvtAdapterMessageCreated(evt: {
  message: SurfaceMessage;
  channelName?: string;
}): EvtAdapterMessageCreatedData {
  return {
    platform: "discord",
    channelId: evt.message.session.channelId,
    channelName: evt.channelName,
    messageId: evt.message.ref.messageId,
    userId: evt.message.userId,
    userName: evt.message.userName,
    text: evt.message.text,
    ts: evt.message.ts,
    raw: evt.message.raw,
  };
}

export function toBusEvtAdapterMessageUpdated(evt: {
  message: SurfaceMessage;
  channelName?: string;
}): EvtAdapterMessageUpdatedData {
  return {
    platform: "discord",
    channelId: evt.message.session.channelId,
    channelName: evt.channelName,
    messageId: evt.message.ref.messageId,
    userId: evt.message.userId,
    userName: evt.message.userName,
    text: evt.message.text,
    ts: evt.message.ts,
    raw: evt.message.raw,
  };
}

export function toBusEvtAdapterMessageDeleted(evt: {
  messageRef: MsgRef;
  session: SessionRef;
  channelName?: string;
  ts: number;
  raw?: unknown;
}): EvtAdapterMessageDeletedData {
  return {
    platform: "discord",
    channelId: evt.session.channelId,
    channelName: evt.channelName,
    messageId: evt.messageRef.messageId,
    ts: evt.ts,
    raw: evt.raw,
  };
}

export function toBusEvtAdapterReactionAdded(evt: {
  messageRef: MsgRef;
  session: SessionRef;
  channelName?: string;
  reaction: string;
  userId?: string;
  userName?: string;
  ts: number;
  raw?: unknown;
}): EvtAdapterReactionAddedData {
  return {
    platform: "discord",
    channelId: evt.session.channelId,
    channelName: evt.channelName,
    messageId: evt.messageRef.messageId,
    reaction: evt.reaction,
    userId: evt.userId,
    userName: evt.userName,
    ts: evt.ts,
    raw: evt.raw,
  };
}

export function toBusEvtAdapterReactionRemoved(evt: {
  messageRef: MsgRef;
  session: SessionRef;
  channelName?: string;
  reaction: string;
  userId?: string;
  userName?: string;
  ts: number;
  raw?: unknown;
}): EvtAdapterReactionRemovedData {
  return {
    platform: "discord",
    channelId: evt.session.channelId,
    channelName: evt.channelName,
    messageId: evt.messageRef.messageId,
    reaction: evt.reaction,
    userId: evt.userId,
    userName: evt.userName,
    ts: evt.ts,
    raw: evt.raw,
  };
}
