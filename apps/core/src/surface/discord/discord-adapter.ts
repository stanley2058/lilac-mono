import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type PartialMessage,
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
  resolveDiscordDbPath,
  resolveDiscordToken,
} from "@stanley2058/lilac-utils";
import type {
  AdapterCapabilities,
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
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
import {
  createDiscordEntityMapper,
  type EntityMapper,
} from "../../entity/entity-mapper";
import { DiscordSurfaceStore } from "../store/discord-surface-store";
import {
  DiscordOutputStream,
  sendDiscordStyledMessage,
} from "./output/discord-output-stream";

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

function getChannelName<
  T extends { isDMBased?: () => boolean } | { name?: string },
>(channel: T | null): string | undefined {
  if (!channel) return undefined;
  if (
    "isDMBased" in channel &&
    typeof channel.isDMBased === "function" &&
    channel.isDMBased()
  ) {
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
  const memberName =
    msg.member && "displayName" in msg.member
      ? msg.member.displayName
      : undefined;
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

function shouldAllowMessage(params: {
  cfg: CoreConfig;
  channelId: string;
  guildId?: string | null;
}): boolean {
  const allowedChannelIds = new Set(
    params.cfg.surface.discord.allowedChannelIds,
  );
  const allowedGuildIds = new Set(params.cfg.surface.discord.allowedGuildIds);

  if (allowedChannelIds.size === 0 && allowedGuildIds.size === 0) return false;

  if (allowedChannelIds.has(params.channelId)) return true;

  const gid = params.guildId ?? null;
  if (gid && allowedGuildIds.has(gid)) return true;

  return false;
}

export class DiscordAdapter implements SurfaceAdapter {
  private client: Client | null = null;
  private store: DiscordSurfaceStore | null = null;
  private cfg: CoreConfig | null = null;
  private entityMapper: EntityMapper | null = null;
  private handlers = new Set<AdapterEventHandler>();

  private self: SurfaceSelf | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts?: DiscordAdapterOptions) {}

  async connect(): Promise<void> {
    if (this.client) return;

    const cfg = this.opts?.config ?? (await getCoreConfig());
    this.cfg = cfg;

    const dbPath = resolveDiscordDbPath(cfg);
    this.store = new DiscordSurfaceStore(dbPath);
    this.entityMapper = createDiscordEntityMapper({ cfg, store: this.store });

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
      const msg = deleted.partial
        ? await deleted.fetch().catch(() => null)
        : deleted;
      await this.onMessageDelete(msg, deleted.id, deleted.channelId);
    });

    client.on("messageReactionAdd", async (reaction, user) => {
      const r = reaction.partial
        ? await reaction.fetch().catch(() => null)
        : reaction;
      if (!r) return;
      await this.onReactionAdd(
        r.message,
        r.emoji.toString(),
        user?.id,
        user?.username ?? undefined,
      );
    });

    client.on("messageReactionRemove", async (reaction, user) => {
      const r = reaction.partial
        ? await reaction.fetch().catch(() => null)
        : reaction;
      if (!r) return;
      await this.onReactionRemove(
        r.message,
        r.emoji.toString(),
        user?.id,
        user?.username ?? undefined,
      );
    });

    await client.login(token);

    this.client = client;
  }

  async disconnect(): Promise<void> {
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

  /** Lightweight Discord API fetch to get a channel's guildId (no history). */
  async fetchGuildIdForChannel(channelId: string): Promise<string | null> {
    const client = this.mustClient();

    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return null;

    const maybeGuildId = (ch as unknown as { guildId?: unknown }).guildId;
    return typeof maybeGuildId === "string" && maybeGuildId.length > 0
      ? maybeGuildId
      : null;
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

    return new DiscordOutputStream({
      client,
      sessionRef,
      opts,
      useSmartSplitting,
      rewriteText: this.entityMapper?.rewriteOutgoingText,
    });
  }

  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<MsgRef> {
    const client = this.mustClient();
    if (sessionRef.platform !== "discord")
      throw new Error("Unsupported platform");

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
    const store = this.mustStore();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const existing = store.getMessage(msgRef.channelId, msgRef.messageId);
    if (!existing) {
      // Cache miss: fetch from Discord API and persist.
      const fetched = await this.fetchAndCacheDiscordMessage({
        channelId: msgRef.channelId,
        messageId: msgRef.messageId,
      });
      if (!fetched) return null;
    }

    const row = store.getMessage(msgRef.channelId, msgRef.messageId);
    if (!row) return null;

    const user = store.getUserName(row.author_id);

    const sess = store.getSession(row.channel_id);
    const sessionRef = asDiscordSessionRef({
      channelId: row.channel_id,
      guildId: sess?.guild_id,
      parentChannelId: sess?.parent_channel_id,
    });

    return {
      ref: msgRef,
      session: sessionRef,
      userId: row.author_id,
      userName:
        user?.display_name ?? user?.global_name ?? user?.username ?? undefined,
      text: row.content,
      ts: row.ts,
      editedTs: row.edited_ts ?? undefined,
      deleted: row.deleted_ts != null,
      raw: row.raw_json ? JSON.parse(row.raw_json) : undefined,
    };
  }

  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    const store = this.mustStore();
    if (sessionRef.platform !== "discord")
      throw new Error("Unsupported platform");

    const limit = opts?.limit ?? 50;

    // If the store is empty for this channel, opportunistically fetch from Discord API.
    // This keeps "explore context" usable even after restarts.
    const latest = store.getLatestMessage(sessionRef.channelId);
    if (!latest) {
      await this.fetchAndCacheDiscordMessages({
        channelId: sessionRef.channelId,
        limit,
        beforeMessageId: opts?.beforeMessageId,
        afterMessageId: opts?.afterMessageId,
      });
    }

    let rows = store.listMessages(sessionRef.channelId, limit);

    // If a cursor was requested and we might not have enough cached history, try a best-effort fetch.
    if (opts?.beforeMessageId || opts?.afterMessageId) {
      await this.fetchAndCacheDiscordMessages({
        channelId: sessionRef.channelId,
        limit,
        beforeMessageId: opts?.beforeMessageId,
        afterMessageId: opts?.afterMessageId,
      });
      rows = store.listMessages(sessionRef.channelId, limit);
    }

    return rows.map((r) => {
      const u = store.getUserName(r.author_id);
      return {
        ref: asDiscordMsgRef(r.channel_id, r.message_id),
        session: sessionRef,
        userId: r.author_id,
        userName: u?.display_name ?? u?.global_name ?? u?.username ?? undefined,
        text: r.content,
        ts: r.ts,
        editedTs: r.edited_ts ?? undefined,
        deleted: r.deleted_ts != null,
        raw: r.raw_json ? JSON.parse(r.raw_json) : undefined,
      };
    });
  }

  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<void> {
    const client = this.mustClient();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const channel = await client.channels
      .fetch(msgRef.channelId)
      .catch(() => null);
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

    const channel = await client.channels
      .fetch(msgRef.channelId)
      .catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      throw new Error(`Discord channel not found: ${msgRef.channelId}`);
    }

    const msg = await channel.messages.fetch(msgRef.messageId);
    await msg.delete();
  }

  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceMessage[]> {
    const store = this.mustStore();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const base = store.getMessage(msgRef.channelId, msgRef.messageId);
    if (!base) return [];

    const limit = opts?.limit ?? 20;
    const rows = store.listMessagesAround(msgRef.channelId, base.ts, limit);

    const sess = store.getSession(msgRef.channelId);
    const sessionRef = asDiscordSessionRef({
      channelId: msgRef.channelId,
      guildId: sess?.guild_id,
      parentChannelId: sess?.parent_channel_id,
    });

    return rows.map((r) => {
      const u = store.getUserName(r.author_id);
      return {
        ref: asDiscordMsgRef(r.channel_id, r.message_id),
        session: sessionRef,
        userId: r.author_id,
        userName: u?.display_name ?? u?.global_name ?? u?.username ?? undefined,
        text: r.content,
        ts: r.ts,
        editedTs: r.edited_ts ?? undefined,
        deleted: r.deleted_ts != null,
        raw: r.raw_json ? JSON.parse(r.raw_json) : undefined,
      };
    });
  }

  async addReaction(msgRef: MsgRef, reaction: string): Promise<void> {
    const client = this.mustClient();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const channel = await client.channels
      .fetch(msgRef.channelId)
      .catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      throw new Error(`Discord channel not found: ${msgRef.channelId}`);
    }
    const msg = await channel.messages.fetch(msgRef.messageId);
    await msg.react(reaction);
  }

  async removeReaction(msgRef: MsgRef, reaction: string): Promise<void> {
    const client = this.mustClient();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const channel = await client.channels
      .fetch(msgRef.channelId)
      .catch(() => null);
    if (!channel || !("messages" in channel) || !channel.messages?.fetch) {
      throw new Error(`Discord channel not found: ${msgRef.channelId}`);
    }
    const msg = await channel.messages.fetch(msgRef.messageId);
    const r = msg.reactions.resolve(reaction);
    await r?.remove();
  }

  async listReactions(msgRef: MsgRef): Promise<string[]> {
    const store = this.mustStore();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

    const rows = store.listMessageReactions({
      channelId: msgRef.channelId,
      messageId: msgRef.messageId,
    });

    return [...new Set(rows.map((r) => r.emoji))];
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
    if (sessionRef.platform !== "discord")
      throw new Error("Unsupported platform");

    const rows = store.listUnread(sessionRef.channelId);

    return rows.map((r) => {
      const u = store.getUserName(r.author_id);
      return {
        ref: asDiscordMsgRef(r.channel_id, r.message_id),
        session: sessionRef,
        userId: r.author_id,
        userName: u?.display_name ?? u?.global_name ?? u?.username ?? undefined,
        text: r.content,
        ts: r.ts,
        editedTs: r.edited_ts ?? undefined,
        deleted: r.deleted_ts != null,
        raw: r.raw_json ? JSON.parse(r.raw_json) : undefined,
      };
    });
  }

  async markRead(sessionRef: SessionRef, upToMsgRef?: MsgRef): Promise<void> {
    const store = this.mustStore();
    if (sessionRef.platform !== "discord")
      throw new Error("Unsupported platform");

    if (upToMsgRef) {
      if (upToMsgRef.platform !== "discord")
        throw new Error("Unsupported platform");
      const msg = store.getMessage(upToMsgRef.channelId, upToMsgRef.messageId);
      if (!msg) return;
      store.setReadState({
        channelId: sessionRef.channelId,
        lastReadTs: msg.ts,
        lastReadMessageId: msg.message_id,
      });
      return;
    }

    const latest = store.getLatestMessage(sessionRef.channelId);
    if (!latest) return;
    store.setReadState({
      channelId: sessionRef.channelId,
      lastReadTs: latest.ts,
      lastReadMessageId: latest.message_id,
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
      try {
        h(evt);
      } catch {
        // ignore
      }
    }
  }

  private async fetchAndCacheDiscordMessages(input: {
    channelId: string;
    limit: number;
    beforeMessageId?: string;
    afterMessageId?: string;
  }): Promise<void> {
    const cfg = this.cfg;
    const store = this.store;
    const client = this.client;
    if (!cfg || !store || !client) return;

    const ch = await client.channels.fetch(input.channelId).catch(() => null);
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return;

    // Best-effort: discord.js supports fetch with { limit, before, after }.
    // Use `any` to avoid overload ambiguity (messageId vs options object).
    const res = await ch.messages
      .fetch({
        limit: Math.min(100, Math.max(1, input.limit)),
        before: input.beforeMessageId,
        after: input.afterMessageId,
      })
      .catch(() => null);

    if (!res) return;

    for (const msg of res.values()) {
      await this.fetchAndCacheDiscordMessage({
        channelId: input.channelId,
        messageId: msg.id,
      });
    }
  }

  private async fetchAndCacheDiscordMessage(input: {
    channelId: string;
    messageId: string;
  }): Promise<SurfaceMessage | null> {
    const cfg = this.cfg;
    const store = this.store;
    const client = this.client;
    if (!cfg || !store || !client) return null;

    const ch = await client.channels.fetch(input.channelId).catch(() => null);
    if (!ch || !("messages" in ch) || !ch.messages?.fetch) return null;

    const msg = await ch.messages.fetch(input.messageId).catch(() => null);
    if (!msg) return null;

    const guildId = msg.guildId;
    if (!shouldAllowMessage({ cfg, channelId: input.channelId, guildId })) {
      return null;
    }

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread()
        ? msg.channel.parentId
        : null;

    const sessionKind: "channel" | "thread" | "dm" =
      "isDMBased" in msg.channel &&
      typeof msg.channel.isDMBased === "function" &&
      msg.channel.isDMBased()
        ? "dm"
        : parentChannelId
          ? "thread"
          : "channel";

    store.upsertSession({
      channelId: input.channelId,
      guildId: guildId ?? undefined,
      parentChannelId: parentChannelId ?? undefined,
      name: channelName,
      type: sessionKind,
      updatedTs: Date.now(),
      raw: {
        channel: {
          id: input.channelId,
          name: channelName,
          guildId,
          parentChannelId,
        },
      },
    });

    if (channelName) {
      store.upsertChannelName({
        channelId: input.channelId,
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
    const normalizedContent =
      this.entityMapper?.normalizeIncomingText(displayText) ?? displayText;

    store.upsertMessage({
      channelId: input.channelId,
      messageId: msg.id,
      authorId: msg.author.id,
      content: normalizedContent,
      ts,
      editedTs,
      raw: {
        id: msg.id,
        channelId: input.channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        embeds: getEmbedDescriptions(msg),
        reference: msg.reference ?? undefined,
        editedTs,
        attachments,
      },
    });

    const sessionRef = asDiscordSessionRef({
      channelId: input.channelId,
      guildId,
      parentChannelId,
    });

    return {
      ref: asDiscordMsgRef(input.channelId, msg.id),
      session: sessionRef,
      userId: msg.author.id,
      userName: authorName,
      text: normalizedContent,
      ts,
      editedTs,
      raw: {
        discord: {
          id: msg.id,
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

    // Avoid infinite loops: never emit adapter events for bot-authored messages.
    // But we DO want to cache them for context.
    const shouldEmitAdapterEvent = !msg.author.bot;

    const guildId = msg.guildId;
    const channelId = msg.channelId;

    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    const channelName = getChannelName(msg.channel);

    const parentChannelId =
      "isThread" in msg.channel && msg.channel.isThread()
        ? msg.channel.parentId
        : null;

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
    const normalizedContent =
      this.entityMapper?.normalizeIncomingText(displayText) ?? displayText;

    store.upsertMessage({
      channelId,
      messageId: msg.id,
      authorId: msg.author.id,
      content: normalizedContent,
      ts,
      editedTs,
      raw: {
        id: msg.id,
        channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        embeds: getEmbedDescriptions(msg),
        editedTs,
        attachments,
      },
    });

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

    const rawDiscord = surfaceMsg.raw as
      | { discord?: Record<string, unknown> }
      | undefined;
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

  private async isReplyToBot(
    msg: Message,
    botUserId: string,
  ): Promise<boolean> {
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

    const ts = getMessageTs(msg);
    const editedTs = getMessageEditedTs(msg);

    const attachments = [...msg.attachments.values()].map((a) => ({
      url: a.url,
      filename: a.name ?? undefined,
      mimeType: a.contentType ?? undefined,
      size: typeof a.size === "number" ? a.size : undefined,
    }));

    const displayText = getDisplayTextFromDiscordMessage(msg);
    const normalizedContent =
      this.entityMapper?.normalizeIncomingText(displayText) ?? displayText;

    store.upsertMessage({
      channelId,
      messageId: msg.id,
      authorId: msg.author.id,
      content: normalizedContent,
      ts,
      editedTs,
      raw: {
        id: msg.id,
        channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        embeds: getEmbedDescriptions(msg),
        editedTs,
        attachments,
      },
    });

    const channelName = getChannelName(msg.channel);
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
          // Best-effort: Discord update event may not expose channel type reliably.
          isDMBased: store.getSession(channelId)?.type === "dm",
          mentionsBot: false,
          replyToBot: false,
          replyToMessageId: msg.reference?.messageId ?? undefined,
          guildId: guildId ?? undefined,
          parentChannelId: sess?.parent_channel_id ?? undefined,
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

  private async onMessageDelete(
    msg: Message | null,
    messageId: string,
    channelId: string,
  ) {
    const cfg = this.cfg;
    const store = this.store;
    if (!cfg || !store) return;

    // If msg is null, we still cache deletion for known messages, but allowlist must be checked.
    const guildId = msg?.guildId ?? null;
    if (!shouldAllowMessage({ cfg, channelId, guildId })) return;

    store.markMessageDeleted({
      channelId,
      messageId,
      deletedTs: Date.now(),
      raw: msg
        ? {
            id: msg.id,
            channelId,
            guildId,
            authorId: msg.author?.id,
          }
        : { id: messageId, channelId },
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

    if (userId) {
      store.addMessageReaction({
        channelId,
        messageId: msg.id,
        emoji: reaction,
        userId,
        ts: Date.now(),
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

    if (userId) {
      store.removeMessageReaction({
        channelId,
        messageId: msg.id,
        emoji: reaction,
        userId,
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
