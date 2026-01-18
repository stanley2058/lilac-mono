import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type PartialMessage,
} from "discord.js";

import type { ModelMessage } from "ai";

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

import { DiscordSurfaceStore, type DbDiscordMessage } from "../store/discord-surface-store";
import { DISCORD_MERGE_WINDOW_MS } from "./merge-window";
import {
  replaceChannelMentions,
  replaceRoleMentions,
  replaceUserMentions,
  sanitizeUserToken,
  stripLeadingBotMention,
} from "./discord-text";
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

type DiscordReplyChainMessage = {
  messageId: string;
  authorId: string;
  authorName: string;
  ts: number;
  content: string;
  reference?: {
    messageId?: string;
    channelId?: string;
  };
};

type MergedChainChunk = {
  messageIds: string[];
  authorId: string;
  authorName: string;
  tsStart: number;
  tsEnd: number;
  content: string;
};

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getReferenceFromRaw(raw: unknown): { messageId?: string; channelId?: string } {
  if (!raw || typeof raw !== "object") return {};
  if (!("reference" in raw)) return {};
  const ref = (raw as { reference?: unknown }).reference;
  if (!ref || typeof ref !== "object") return {};

  const messageId =
    "messageId" in ref && typeof (ref as { messageId?: unknown }).messageId === "string"
      ? ((ref as { messageId: string }).messageId as string)
      : undefined;

  const channelId =
    "channelId" in ref && typeof (ref as { channelId?: unknown }).channelId === "string"
      ? ((ref as { channelId: string }).channelId as string)
      : undefined;

  return { messageId, channelId };
}

function mergeReplyChainByWindow(messagesOldestFirst: readonly DiscordReplyChainMessage[]): MergedChainChunk[] {
  if (messagesOldestFirst.length === 0) return [];

  const out: MergedChainChunk[] = [];
  let cur: MergedChainChunk = {
    messageIds: [messagesOldestFirst[0]!.messageId],
    authorId: messagesOldestFirst[0]!.authorId,
    authorName: messagesOldestFirst[0]!.authorName,
    tsStart: messagesOldestFirst[0]!.ts,
    tsEnd: messagesOldestFirst[0]!.ts,
    content: messagesOldestFirst[0]!.content,
  };

  for (let i = 1; i < messagesOldestFirst.length; i++) {
    const next = messagesOldestFirst[i]!;
    const gap = next.ts - cur.tsEnd;

    const shouldMerge = next.authorId === cur.authorId && gap <= DISCORD_MERGE_WINDOW_MS;
    if (!shouldMerge) {
      out.push(cur);
      cur = {
        messageIds: [next.messageId],
        authorId: next.authorId,
        authorName: next.authorName,
        tsStart: next.ts,
        tsEnd: next.ts,
        content: next.content,
      };
      continue;
    }

    cur.messageIds.push(next.messageId);
    cur.tsEnd = next.ts;
    cur.content = `${cur.content}\n\n${next.content}`;
  }

  out.push(cur);
  return out;
}

function normalizeDiscordText(params: {
  text: string;
  store: DiscordSurfaceStore;
  guildId?: string | null;
  botUserId: string;
  botName: string;
}): string {
  const { store, guildId, botUserId, botName } = params;

  let normalizedText = replaceUserMentions({
    text: params.text,
    lookupUserName: (uid) => {
      const row = store.getUserName(uid);
      return row?.display_name ?? row?.global_name ?? row?.username ?? null;
    },
    botUserId,
    botName,
  });

  if (guildId) {
    normalizedText = replaceRoleMentions({
      text: normalizedText,
      guildId,
      lookupRoleName: (gid, rid) => {
        const row = store.getRoleName(gid, rid);
        return row?.name ?? null;
      },
    });
  }

  normalizedText = replaceChannelMentions({
    text: normalizedText,
    lookupChannelName: (cid) => {
      const row = store.getChannelName(cid);
      return row?.name ?? null;
    },
  });

  return normalizedText;
}

function formatDiscordAttributionHeader(params: {
  authorId: string;
  authorName: string;
  messageId: string;
}): string {
  const userName = sanitizeUserToken(params.authorName || `user_${params.authorId}`);
  return `[discord user_id=${params.authorId} user_name=${userName} message_id=${params.messageId}]`;
}

async function fetchDiscordMessageById(params: {
  channel: Message["channel"];
  messageId: string;
}): Promise<Message | null> {
  const { channel, messageId } = params;
  if (!channel || !("messages" in channel) || !channel.messages?.fetch) return null;
  return await channel.messages.fetch(messageId).catch(() => null);
}

function toReplyChainMessageFromRow(params: {
  row: DbDiscordMessage;
  store: DiscordSurfaceStore;
  botUserId: string;
  botName: string;
}): DiscordReplyChainMessage {
  const { row, store, botUserId, botName } = params;

  const raw = safeJsonParse(row.raw_json);
  const ref = getReferenceFromRaw(raw);

  const authorName =
    row.author_id === botUserId
      ? botName
      : (() => {
          const u = store.getUserName(row.author_id);
          return u?.display_name ?? u?.global_name ?? u?.username ?? `user_${row.author_id}`;
        })();

  return {
    messageId: row.message_id,
    authorId: row.author_id,
    authorName,
    ts: row.ts,
    content: row.content,
    reference: ref,
  };
}

function toReplyChainMessageFromDiscordMessage(params: {
  msg: Message;
  botUserId: string;
  botName: string;
}): DiscordReplyChainMessage {
  const { msg, botUserId, botName } = params;

  const authorId = msg.author.id;
  const authorName = authorId === botUserId ? botName : getDisplayName(msg);

  return {
    messageId: msg.id,
    authorId,
    authorName,
    ts: getMessageTs(msg),
    content: msg.content ?? "",
    reference: {
      messageId: msg.reference?.messageId ?? undefined,
      channelId: msg.reference?.channelId ?? undefined,
    },
  };
}

async function buildDiscordRequestMessages(params: {
  store: DiscordSurfaceStore;
  triggerMsg: Message;
  triggerType: "mention" | "reply";
  botUserId: string;
  botName: string;
  maxDepth?: number;
}): Promise<{
  messages: ModelMessage[];
  chainMessageIds: string[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
}> {
  const { store, triggerMsg, triggerType, botUserId, botName } = params;

  const maxDepth = params.maxDepth ?? 20;
  const chainNewestToOldest: DiscordReplyChainMessage[] = [];

  let cur: DiscordReplyChainMessage | null = toReplyChainMessageFromDiscordMessage({
    msg: triggerMsg,
    botUserId,
    botName,
  });

  for (let depth = 0; depth < maxDepth && cur; depth++) {
    chainNewestToOldest.push(cur);

    const refChannelId = cur.reference?.channelId;
    if (refChannelId && refChannelId !== triggerMsg.channelId) break;

    const refId = cur.reference?.messageId;
    if (!refId) break;

    const row = store.getMessage(triggerMsg.channelId, refId);
    if (row) {
      cur = toReplyChainMessageFromRow({ row, store, botUserId, botName });
      continue;
    }

    const fetched = await fetchDiscordMessageById({ channel: triggerMsg.channel, messageId: refId });
    if (!fetched) break;

    // Best-effort cache for future chain resolution.
    store.upsertUserName({
      userId: fetched.author.id,
      username: fetched.author.username,
      globalName: fetched.author.globalName ?? undefined,
      displayName: fetched.author.id === botUserId ? botName : getDisplayName(fetched),
      updatedTs: Date.now(),
    });

    store.upsertMessage({
      channelId: fetched.channelId,
      messageId: fetched.id,
      authorId: fetched.author.id,
      content: fetched.content ?? "",
      ts: getMessageTs(fetched),
      editedTs: getMessageEditedTs(fetched),
      raw: {
        id: fetched.id,
        channelId: fetched.channelId,
        guildId: fetched.guildId,
        authorId: fetched.author.id,
        content: fetched.content,
        reference: fetched.reference ?? undefined,
      },
    });

    cur = toReplyChainMessageFromDiscordMessage({ msg: fetched, botUserId, botName });
  }

  const chainOldestToNewest = chainNewestToOldest.slice().reverse();
  const merged = mergeReplyChainByWindow(chainOldestToNewest);

  const modelMessages: ModelMessage[] = [];

  for (const chunk of merged) {
    const isBot = chunk.authorId === botUserId;

    const messageId = chunk.messageIds[chunk.messageIds.length - 1]!;

    let text = chunk.content;
    if (triggerType === "mention" && chunk.messageIds.includes(triggerMsg.id)) {
      // Strip only on the triggering message content; keep other messages intact.
      // This is a best-effort approximation when merge windows combine multiple messages.
      const parts = chunk.content.split("\n\n");
      const idx = parts.length - 1;
      parts[idx] = stripLeadingBotMention({ text: parts[idx] ?? "", botUserId });
      text = parts.join("\n\n");
    }

    const normalizedText = normalizeDiscordText({
      text,
      store,
      guildId: triggerMsg.guildId,
      botUserId,
      botName,
    });

    const header = formatDiscordAttributionHeader({
      authorId: chunk.authorId,
      authorName: chunk.authorName,
      messageId,
    });

    modelMessages.push({
      role: isBot ? "assistant" : "user",
      content: `${header}\n${normalizedText}`.trimEnd(),
    });
  }

  return {
    messages: modelMessages,
    chainMessageIds: chainOldestToNewest.map((m) => m.messageId),
    mergedGroups: merged.map((m) => ({ authorId: m.authorId, messageIds: m.messageIds })),
  };
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

    client.on("ready", async () => {
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
        this.presenceTimer = setInterval(() => {
          applyPresence();
        }, 30 * 60 * 1000);
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
    });
  }

  async readMsg(msgRef: MsgRef): Promise<SurfaceMessage | null> {
    const store = this.mustStore();
    if (msgRef.platform !== "discord") throw new Error("Unsupported platform");

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
    const rows = store.listMessages(sessionRef.channelId, limit);

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
    await msg.edit({ content: content.text ?? "" });
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

    // Avoid infinite loops: ignore all bot-authored messages (including ourselves).
    if (msg.author.bot) return;

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

    store.upsertMessage({
      channelId,
      messageId: msg.id,
      authorId: msg.author.id,
      content: msg.content ?? "",
      ts,
      editedTs,
      raw: {
        id: msg.id,
        channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        reference: msg.reference ?? undefined,
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
      text: msg.content ?? "",
      ts,
      editedTs,
      raw: { discord: { id: msg.id } },
    };

    // Emit adapter event
    this.emit({
      type: "adapter.message.created",
      platform: "discord",
      ts: Date.now(),
      message: surfaceMsg,
      channelName,
    });

    // Request trigger detection
    const botId = client.user?.id;
    if (!botId) return;

    const isMention = msg.mentions.users.has(botId);
    const isReplyToBot = await this.isReplyToBot(msg, botId);
    const triggerType = isReplyToBot ? "reply" : isMention ? "mention" : null;

    if (!triggerType) return;

    const requestId = `discord:${channelId}:${msg.id}`;

    const composed = await buildDiscordRequestMessages({
      store,
      triggerMsg: msg,
      triggerType,
      botUserId: botId,
      botName: cfg.surface.discord.botName,
    });

    this.emit({
      type: "adapter.request",
      platform: "discord",
      ts: Date.now(),
      requestId,
      channelId,
      channelName,
      messages: composed.messages,
      raw: {
        triggerType,
        chainMessageIds: composed.chainMessageIds,
        mergedGroups: composed.mergedGroups,
        session: {
          channelId,
          guildId,
          parentChannelId,
          channelName,
        },
        replyTo: msg.reference?.messageId ?? undefined,
      },
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
    const editedTs = getMessageEditedTs(msg) ?? Date.now();

    store.upsertMessage({
      channelId,
      messageId: msg.id,
      authorId: msg.author.id,
      content: msg.content ?? "",
      ts,
      editedTs,
      raw: {
        id: msg.id,
        channelId,
        guildId,
        authorId: msg.author.id,
        content: msg.content,
        editedTs,
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
      text: msg.content ?? "",
      ts,
      editedTs,
      raw: { discord: { id: msg.id } },
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
