import type { ServerWebSocket } from "bun";
import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayOpcodes,
  MessageType,
  SnowflakeUtil,
  type APIChannel,
  type APIEmbed,
  type APIGuildMember,
  type APIMessage,
  type APIRole,
  type APITextChannel,
  type APIUser,
  type ApplicationFlags,
  type GuildMemberFlags,
  type GuildSystemChannelFlags,
  type RoleFlags,
  type GatewayGuildCreateDispatchData,
  type GatewayMessageCreateDispatchData,
  type GatewayMessageDeleteDispatchData,
  type GatewayMessageUpdateDispatchData,
  type GatewayReadyDispatchData,
  type RESTGetAPIGatewayBotResult,
  type RESTPostAPIChannelMessageJSONBody,
} from "discord.js";
import { withinRedisDeadline } from "../../../../../packages/event-bus/tests/helpers/isolated-redis";

/**
 * A fake Discord API (REST v10 + gateway v10) for the real discord.js client inside Core.
 * It keeps a small message store, echoes the bot's own writes back over the gateway like Discord
 * does, and records every REST call and gateway frame so scenarios can assert request shapes.
 */

export const DISCORD_TOKEN = "e2e.discord.bot-token";

/** Discord's documented message limits that the fake enforces with a 400 like the real API. */
export const DISCORD_LIMITS = {
  content: 2000,
  embeds: 10,
  embedTitle: 256,
  embedDescription: 4096,
  embedFields: 25,
  embedFieldName: 256,
  embedFieldValue: 1024,
  embedFooter: 2048,
  embedAuthor: 256,
  embedTotal: 6000,
} as const;

export type DiscordCall = {
  method: string;
  /** Path below `/api/v10`, such as `/channels/1/messages`. */
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** Names of uploaded files, for multipart requests. */
  files: string[];
  authorization: string | null;
  status: number;
  /** Set when the request violated a documented Discord limit. */
  violation?: string;
};

type Socket = ServerWebSocket<{ id: number }>;

const snowflake = () => SnowflakeUtil.generate().toString();

function user(id: string, username: string, bot = false): APIUser {
  return {
    id,
    username,
    discriminator: "0",
    global_name: username,
    avatar: null,
    ...(bot ? { bot: true } : {}),
  };
}

function textChannel(id: string, guildId: string, name: string): APITextChannel {
  return {
    id,
    type: ChannelType.GuildText,
    guild_id: guildId,
    name,
    position: 0,
    permission_overwrites: [],
    parent_id: null,
    nsfw: false,
    topic: null,
    last_message_id: null,
    rate_limit_per_user: 0,
  };
}

function member(account: APIUser): APIGuildMember {
  return {
    user: account,
    roles: [],
    joined_at: new Date(0).toISOString(),
    deaf: false,
    mute: false,
    flags: 0 as GuildMemberFlags,
    nick: null,
    avatar: null,
    banner: null,
    premium_since: null,
    pending: false,
    communication_disabled_until: null,
  };
}

/** Returns the first documented limit the message body breaks, if any. */
export function messageLimitViolation(body: Partial<RESTPostAPIChannelMessageJSONBody>) {
  if (typeof body.content === "string" && body.content.length > DISCORD_LIMITS.content)
    return `content length ${body.content.length} > ${DISCORD_LIMITS.content}`;
  const embeds = (body.embeds ?? []) as APIEmbed[];
  if (embeds.length > DISCORD_LIMITS.embeds) return `${embeds.length} embeds`;
  let total = 0;
  for (const embed of embeds) {
    const checks: [string, string | undefined, number][] = [
      ["title", embed.title, DISCORD_LIMITS.embedTitle],
      ["description", embed.description, DISCORD_LIMITS.embedDescription],
      ["footer", embed.footer?.text, DISCORD_LIMITS.embedFooter],
      ["author", embed.author?.name, DISCORD_LIMITS.embedAuthor],
    ];
    for (const field of embed.fields ?? []) {
      checks.push(["field name", field.name, DISCORD_LIMITS.embedFieldName]);
      checks.push(["field value", field.value, DISCORD_LIMITS.embedFieldValue]);
    }
    if ((embed.fields?.length ?? 0) > DISCORD_LIMITS.embedFields)
      return `${embed.fields!.length} embed fields`;
    for (const [name, value, limit] of checks) {
      const length = value?.length ?? 0;
      if (length > limit) return `embed ${name} length ${length} > ${limit}`;
      total += length;
    }
  }
  if (total > DISCORD_LIMITS.embedTotal)
    return `embed total length ${total} > ${DISCORD_LIMITS.embedTotal}`;
  return undefined;
}

function discordError(status: number, code: number, message: string): Response {
  return Response.json({ message, code }, { status });
}

export class FakeDiscord {
  readonly guildId = snowflake();
  readonly applicationId = snowflake();
  readonly bot = user(snowflake(), "lilac", true);
  readonly human = user(snowflake(), "alice");
  /** Allowlisted in Core's config, keyed by name, so each scenario can use its own session. */
  readonly channels: Record<string, APITextChannel>;
  /** Same guild, not allowlisted. */
  readonly blockedChannel = textChannel(snowflake(), this.guildId, "blocked");

  readonly calls: DiscordCall[] = [];
  /** Gateway frames received from the client (identify, heartbeats, presence updates). */
  readonly gatewayFrames: { op: number; d: unknown }[] = [];
  /** Routes the fake does not implement; a scenario should end with this empty. */
  readonly unhandled: string[] = [];
  /** Current state of every message, keyed by id. Deleted messages are removed. */
  readonly messages = new Map<string, APIMessage>();
  readonly deleted = new Set<string>();

  private server: ReturnType<typeof Bun.serve<{ id: number }>> | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private identified = Promise.withResolvers<void>();
  private nextSocketId = 0;

  constructor(allowedChannelNames: readonly string[]) {
    this.channels = Object.fromEntries(
      allowedChannelNames.map((name) => [name, textChannel(snowflake(), this.guildId, name)]),
    );
  }

  /** The id of an allowlisted channel. */
  channel(name: string): string {
    const found = this.channels[name];
    if (!found) throw new Error(`No allowlisted channel ${name}`);
    return found.id;
  }

  private get allChannels(): APITextChannel[] {
    return [...Object.values(this.channels), this.blockedChannel];
  }

  get url(): string {
    if (!this.server) throw new Error("Fake Discord is not started");
    return this.server.url.href.replace(/\/$/u, "");
  }

  /** Value for DISCORD_API_BASE_URL; discord.js appends `/v10`. */
  get apiBase(): string {
    return `${this.url}/api`;
  }

  /** Core config enabling the Discord surface for the allowlisted channel. */
  coreConfig(discord: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tokenEnv: "DISCORD_TOKEN",
      allowedChannelIds: Object.values(this.channels).map((channel) => channel.id),
      allowedGuildIds: [],
      botName: "lilac",
      ...discord,
    };
  }

  coreEnv(): Record<string, string> {
    return { DISCORD_TOKEN, DISCORD_API_BASE_URL: this.apiBase };
  }

  start(): this {
    this.server = Bun.serve<{ id: number }>({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === "/gateway") {
          if (server.upgrade(request, { data: { id: ++this.nextSocketId } })) return undefined;
          return new Response("Upgrade failed", { status: 400 });
        }
        return this.handleRest(request, url);
      },
      websocket: {
        open: (socket) => {
          this.sockets.add(socket);
          this.send(socket, { op: GatewayOpcodes.Hello, d: { heartbeat_interval: 41_250 } });
        },
        message: (socket, message) => this.handleGateway(socket, String(message)),
        close: (socket) => void this.sockets.delete(socket),
      },
    });
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.close(1000);
    await this.server?.stop(true);
  }

  /** Resolves after the client identified with the bot token. */
  async identifiedClient(timeoutMs = 30_000): Promise<void> {
    await withinRedisDeadline(this.identified.promise, "Discord IDENTIFY", timeoutMs);
  }

  // ---- Test controls ------------------------------------------------------------------------

  /** Posts a message as the human user and dispatches MESSAGE_CREATE. */
  userMessage(input: {
    channelId: string;
    content: string;
    mentionBot?: boolean;
    replyTo?: string;
  }): APIMessage {
    const channelId = input.channelId;
    const referenced = input.replyTo ? this.messages.get(input.replyTo) : undefined;
    const mentions = [
      ...(input.mentionBot ? [this.bot] : []),
      ...(referenced && referenced.author.id !== this.human.id ? [referenced.author] : []),
    ];
    const content = input.mentionBot ? `<@${this.bot.id}> ${input.content}` : input.content;
    const message = this.storeMessage({
      channelId,
      author: this.human,
      content,
      mentions,
      ...(referenced
        ? {
            message_reference: {
              type: 0,
              message_id: referenced.id,
              channel_id: channelId,
              guild_id: this.guildId,
            },
            referenced_message: referenced,
            type: MessageType.Reply,
          }
        : {}),
    });
    this.dispatch(GatewayDispatchEvents.MessageCreate, this.gatewayMessage(message));
    return message;
  }

  /** Deletes any message as a moderator would and dispatches MESSAGE_DELETE. */
  deleteMessage(id: string): void {
    const message = this.messages.get(id);
    if (!message) throw new Error(`No message ${id} to delete`);
    this.removeMessage(message);
  }

  /** Messages the bot has posted to a channel that still exist, oldest first. */
  botMessages(channelId: string): APIMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.channel_id === channelId && message.author.id === this.bot.id)
      .toSorted((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  /** Every REST call to a path matching the pattern. */
  callsTo(method: string, pattern: RegExp): DiscordCall[] {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path));
  }

  /** Resolves once the predicate holds for the recorded state, or fails with the call log. */
  async waitFor<T>(
    check: () => T | undefined | false,
    label: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    const found = new Promise<T>((resolve) => {
      const listener = () => {
        const value = check();
        if (value === undefined || value === false) return;
        this.listeners.delete(listener);
        resolve(value);
      };
      this.listeners.add(listener);
      listener();
    });
    return withinRedisDeadline(found, label, timeoutMs).catch((error: Error) => {
      throw new Error(`${error.message}\nDiscord saw:\n${this.describe()}`);
    });
  }

  describe(): string {
    return this.calls
      .map((call) => {
        const body = call.body === undefined ? "" : ` ${JSON.stringify(call.body).slice(0, 240)}`;
        return `${call.status} ${call.method} ${call.path}${body}`;
      })
      .join("\n");
  }

  // ---- Gateway ------------------------------------------------------------------------------

  private send(socket: Socket, payload: { op: number; d: unknown; s?: number; t?: string }) {
    socket.send(JSON.stringify({ s: null, t: null, ...payload }));
  }

  private dispatch(event: GatewayDispatchEvents, data: unknown): void {
    for (const socket of this.sockets)
      this.send(socket, { op: GatewayOpcodes.Dispatch, t: event, s: ++this.sequence, d: data });
  }

  private handleGateway(socket: Socket, raw: string): void {
    const frame = JSON.parse(raw) as { op: number; d: unknown };
    this.gatewayFrames.push(frame);
    switch (frame.op) {
      case GatewayOpcodes.Heartbeat:
        this.send(socket, { op: GatewayOpcodes.HeartbeatAck, d: null });
        return;
      case GatewayOpcodes.Identify:
        this.identify(socket, frame.d as { token?: string });
        return;
      default:
        this.notify();
    }
  }

  private identify(socket: Socket, data: { token?: string }): void {
    if (data.token !== DISCORD_TOKEN) {
      socket.close(4004, "Authentication failed.");
      return;
    }
    const ready: GatewayReadyDispatchData = {
      v: 10,
      user: this.bot,
      guilds: [{ id: this.guildId, unavailable: true }],
      session_id: `session-${socket.data.id}`,
      resume_gateway_url: `${this.url.replace(/^http/u, "ws")}/gateway`,
      shard: [0, 1],
      application: { id: this.applicationId, flags: 0 as ApplicationFlags },
    };
    this.send(socket, {
      op: GatewayOpcodes.Dispatch,
      t: GatewayDispatchEvents.Ready,
      s: ++this.sequence,
      d: ready,
    });
    this.send(socket, {
      op: GatewayOpcodes.Dispatch,
      t: GatewayDispatchEvents.GuildCreate,
      s: ++this.sequence,
      d: this.guildCreate(),
    });
    this.identified.resolve();
    this.notify();
  }

  private everyoneRole(): APIRole {
    return {
      id: this.guildId,
      name: "@everyone",
      color: 0,
      colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
      hoist: false,
      icon: null,
      unicode_emoji: null,
      position: 0,
      // Administrator, so permission checks in discord.js never block the bot.
      permissions: "8",
      managed: false,
      mentionable: false,
      flags: 0 as RoleFlags,
    };
  }

  private guildCreate(): GatewayGuildCreateDispatchData {
    return {
      id: this.guildId,
      name: "E2E Guild",
      icon: null,
      splash: null,
      discovery_splash: null,
      banner: null,
      description: null,
      owner_id: this.human.id,
      afk_channel_id: null,
      afk_timeout: 60,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      roles: [this.everyoneRole()],
      emojis: [],
      stickers: [],
      features: [],
      mfa_level: 0,
      application_id: null,
      system_channel_id: null,
      system_channel_flags: 0 as GuildSystemChannelFlags,
      rules_channel_id: null,
      max_members: 100,
      vanity_url_code: null,
      premium_tier: 0,
      preferred_locale: "en-US" as GatewayGuildCreateDispatchData["preferred_locale"],
      public_updates_channel_id: null,
      nsfw_level: 0,
      premium_progress_bar_enabled: false,
      safety_alerts_channel_id: null,
      hub_type: null,
      incidents_data: null,
      joined_at: new Date(0).toISOString(),
      large: false,
      member_count: 2,
      members: [member(this.bot), member(this.human)],
      channels: this.allChannels,
      threads: [],
      presences: [],
      voice_states: [],
      stage_instances: [],
      guild_scheduled_events: [],
      soundboard_sounds: [],
    };
  }

  private gatewayMessage(message: APIMessage): GatewayMessageCreateDispatchData {
    const { user: _user, ...authorMember } = member(message.author);
    return { ...message, guild_id: this.guildId, member: authorMember };
  }

  // ---- Message store ------------------------------------------------------------------------

  private storeMessage(input: {
    channelId: string;
    author: APIUser;
    content: string;
    mentions?: APIUser[];
    embeds?: APIEmbed[];
    attachments?: string[];
    message_reference?: APIMessage["message_reference"];
    referenced_message?: APIMessage | null;
    type?: MessageType;
    flags?: number;
  }): APIMessage {
    const id = snowflake();
    const message: APIMessage = {
      id,
      channel_id: input.channelId,
      author: input.author,
      content: input.content,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: input.mentions ?? [],
      mention_roles: [],
      attachments: (input.attachments ?? []).map((filename, index) => ({
        id: `${id}${index}`,
        filename,
        size: 1,
        url: `${this.url}/attachments/${id}/${filename}`,
        proxy_url: `${this.url}/attachments/${id}/${filename}`,
      })),
      embeds: input.embeds ?? [],
      pinned: false,
      type: input.type ?? MessageType.Default,
      flags: input.flags ?? 0,
      ...(input.message_reference ? { message_reference: input.message_reference } : {}),
      ...(input.referenced_message !== undefined
        ? { referenced_message: input.referenced_message }
        : {}),
    };
    this.messages.set(id, message);
    return message;
  }

  private removeMessage(message: APIMessage): void {
    this.messages.delete(message.id);
    this.deleted.add(message.id);
    const data: GatewayMessageDeleteDispatchData = {
      id: message.id,
      channel_id: message.channel_id,
      guild_id: this.guildId,
    };
    this.dispatch(GatewayDispatchEvents.MessageDelete, data);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- REST ---------------------------------------------------------------------------------

  private async readBody(request: Request): Promise<{ body: unknown; files: string[] }> {
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const files: string[] = [];
      let body: unknown;
      for (const [key, value] of form.entries()) {
        if (key === "payload_json") body = JSON.parse(String(value));
        else if (typeof value !== "string") files.push((value as File).name);
      }
      return { body, files };
    }
    const text = await request.text();
    return { body: text ? JSON.parse(text) : undefined, files: [] };
  }

  private async handleRest(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/api\/v10/u, "");
    const { body, files } = await this.readBody(request);
    const call: DiscordCall = {
      method: request.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      files,
      authorization: request.headers.get("authorization"),
      status: 0,
    };
    const response =
      call.authorization === `Bot ${DISCORD_TOKEN}`
        ? this.route(call)
        : discordError(401, 0, "401: Unauthorized");
    call.status = response.status;
    this.calls.push(call);
    this.notify();
    return response;
  }

  private route(call: DiscordCall): Response {
    const { method, path } = call;
    const parts = path.split("/").filter(Boolean);
    const key = `${method} /${parts.map((part) => (/^\d+$/u.test(part) ? ":id" : part)).join("/")}`;
    switch (key) {
      case "GET /gateway/bot":
        return Response.json({
          url: `${this.url.replace(/^http/u, "ws")}/gateway`,
          shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
        } satisfies RESTGetAPIGatewayBotResult);
      case "GET /users/@me":
        return Response.json(this.bot);
      case "GET /users/@me/guilds":
        return Response.json([
          {
            id: this.guildId,
            name: "E2E Guild",
            icon: null,
            banner: null,
            owner: false,
            permissions: "8",
            features: [],
          },
        ]);
      case "GET /oauth2/applications/@me":
      case "GET /applications/@me":
        return Response.json({
          id: this.applicationId,
          name: "lilac",
          icon: null,
          description: "",
          bot_public: true,
          bot_require_code_grant: false,
          verify_key: "e2e",
          flags: 0,
          team: null,
          owner: this.human,
          summary: "",
        });
      case "GET /applications/:id/commands":
      case "GET /applications/:id/guilds/:id/commands":
        return Response.json([]);
      case "PUT /applications/:id/guilds/:id/commands":
      case "PUT /applications/:id/commands":
        return Response.json(call.body ?? []);
      case "POST /applications/:id/commands":
        return Response.json({
          id: snowflake(),
          application_id: this.applicationId,
          version: snowflake(),
          ...(call.body as object),
        });
      case "GET /channels/:id":
        return this.getChannel(parts[1]!);
      case "GET /guilds/:id":
        return Response.json(this.guildCreate());
      case "GET /guilds/:id/channels":
        return Response.json(this.allChannels);
      case "GET /guilds/:id/members/:id": {
        const found = [this.bot, this.human].find((account) => account.id === parts[3]);
        return found ? Response.json(member(found)) : discordError(404, 10007, "Unknown Member");
      }
      case "POST /channels/:id/typing":
        return new Response(null, { status: 204 });
      case "GET /channels/:id/messages":
        return this.listMessages(parts[1]!, call.query);
      case "POST /channels/:id/messages":
        return this.createMessage(parts[1]!, call);
      case "GET /channels/:id/messages/:id":
        return this.getMessage(parts[3]!);
      case "PATCH /channels/:id/messages/:id":
        return this.editMessage(parts[3]!, call);
      case "DELETE /channels/:id/messages/:id": {
        const message = this.messages.get(parts[3]!);
        if (!message) return discordError(404, 10008, "Unknown Message");
        this.removeMessage(message);
        return new Response(null, { status: 204 });
      }
    }
    if (/^(PUT|DELETE) \/channels\/:id\/messages\/:id\/reactions\/[^/]+\/@me$/u.test(key))
      return this.messages.has(parts[3]!)
        ? new Response(null, { status: 204 })
        : discordError(404, 10008, "Unknown Message");
    this.unhandled.push(`${method} ${path}`);
    return discordError(404, 0, "404: Not Found");
  }

  private getChannel(id: string): Response {
    const channel = this.allChannels.find((entry) => entry.id === id);
    return channel
      ? Response.json(channel satisfies APIChannel)
      : discordError(404, 10003, "Unknown Channel");
  }

  private getMessage(id: string): Response {
    const message = this.messages.get(id);
    return message ? Response.json(message) : discordError(404, 10008, "Unknown Message");
  }

  private listMessages(channelId: string, query: Record<string, string>): Response {
    const limit = Number(query.limit ?? 50);
    let list = [...this.messages.values()]
      .filter((message) => message.channel_id === channelId)
      .toSorted((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
    if (query.before) list = list.filter((message) => BigInt(message.id) < BigInt(query.before!));
    if (query.after) list = list.filter((message) => BigInt(message.id) > BigInt(query.after!));
    if (query.around) list = list.filter((message) => message.id === query.around);
    return Response.json(list.slice(0, limit));
  }

  private createMessage(channelId: string, call: DiscordCall): Response {
    const body = (call.body ?? {}) as RESTPostAPIChannelMessageJSONBody;
    call.violation = messageLimitViolation(body);
    if (call.violation)
      return Response.json(
        { message: "Invalid Form Body", code: 50035, errors: { violation: call.violation } },
        { status: 400 },
      );
    const referencedId = body.message_reference?.message_id;
    const referenced = referencedId ? this.messages.get(referencedId) : undefined;
    if (referencedId && !referenced && body.message_reference?.fail_if_not_exists !== false)
      return Response.json(
        {
          message: "Invalid Form Body",
          code: 50035,
          errors: {
            message_reference: {
              _errors: [{ code: "REPLIES_UNKNOWN_MESSAGE", message: "Unknown message" }],
            },
          },
        },
        { status: 400 },
      );
    const message = this.storeMessage({
      channelId,
      author: this.bot,
      content: body.content ?? "",
      embeds: (body.embeds ?? []) as APIEmbed[],
      attachments: call.files,
      flags: body.flags ?? 0,
      ...(referenced
        ? {
            message_reference: {
              type: 0,
              message_id: referenced.id,
              channel_id: channelId,
              guild_id: this.guildId,
            },
            referenced_message: referenced,
            type: MessageType.Reply,
          }
        : {}),
    });
    this.dispatch(GatewayDispatchEvents.MessageCreate, this.gatewayMessage(message));
    return Response.json(message);
  }

  private editMessage(id: string, call: DiscordCall): Response {
    const existing = this.messages.get(id);
    if (!existing) return discordError(404, 10008, "Unknown Message");
    const body = (call.body ?? {}) as Partial<RESTPostAPIChannelMessageJSONBody>;
    call.violation = messageLimitViolation(body);
    if (call.violation)
      return Response.json(
        { message: "Invalid Form Body", code: 50035, errors: { violation: call.violation } },
        { status: 400 },
      );
    const next: APIMessage = {
      ...existing,
      ...(body.content !== undefined ? { content: body.content ?? "" } : {}),
      ...(body.embeds !== undefined ? { embeds: (body.embeds ?? []) as APIEmbed[] } : {}),
      edited_timestamp: new Date().toISOString(),
    };
    this.messages.set(id, next);
    const update: GatewayMessageUpdateDispatchData = this.gatewayMessage(next);
    this.dispatch(GatewayDispatchEvents.MessageUpdate, update);
    return Response.json(next);
  }
}
