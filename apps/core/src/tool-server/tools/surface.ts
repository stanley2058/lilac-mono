import { z } from "zod";
import { isAdapterPlatform } from "../../shared/is-adapter-platform";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../../surface/adapter";
import type { MsgRef, SessionRef, SurfaceSession } from "../../surface/types";
import type { RequestContext, ServerTool } from "../types";

import {
  bestEffortTokenForDiscordChannelId,
  resolveDiscordSessionId,
} from "./resolve-discord-session-id";
import { zodObjectToCliLines } from "./zod-cli";

const surfaceClientSchema = z
  .enum(["discord", "whatsapp", "slack", "telegram", "web"])
  .describe(
    "Surface client/platform (required if request client is unknown / not provided)",
  );

type SurfaceClient = z.infer<typeof surfaceClientSchema>;

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

type GuildIdResolver = {
  fetchGuildIdForChannel(channelId: string): Promise<string | null>;
};

function hasGuildIdResolver(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & GuildIdResolver {
  return (
    typeof (adapter as unknown as { fetchGuildIdForChannel?: unknown })
      .fetchGuildIdForChannel === "function"
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

const sessionsListInputSchema = baseInputSchema;

const messagesListInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max messages (default: 50)"),
});

const messagesReadInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  messageId: z.string().min(1),
});

const messagesSendInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  text: z.string().min(1),
  replyToMessageId: z.string().min(1).optional(),
});

const messagesEditInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  messageId: z.string().min(1),
  text: z.string().min(1),
});

const messagesDeleteInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  messageId: z.string().min(1),
});

const reactionsListInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  messageId: z.string().min(1),
});

const reactionsAddInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  messageId: z.string().min(1),
  reaction: z
    .string()
    .min(1)
    .describe("Reaction emoji (e.g. 👍, ✅, :custom_emoji:)"),
});

const reactionsRemoveInputSchema = baseInputSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Session id (platform-specific; can be a raw id, a mention like <#id>, or a configured token alias)",
    ),
  messageId: z.string().min(1),
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
      config: CoreConfig;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
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
        description: "List cached messages for a session (no history fetch).",
        shortInput: zodObjectToCliLines(messagesListInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(messagesListInputSchema),
      },
      {
        callableId: "surface.messages.read",
        name: "Surface Messages Read",
        description: "Read a cached message by id (no history fetch).",
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
        description: "List cached reactions for a message.",
        shortInput: zodObjectToCliLines(reactionsListInputSchema, {
          mode: "required",
        }),
        input: zodObjectToCliLines(reactionsListInputSchema),
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
    if (callableId === "surface.reactions.add") {
      return await this.callReactionsAdd(input, opts?.context);
    }
    if (callableId === "surface.reactions.remove") {
      return await this.callReactionsRemove(input, opts?.context);
    }

    throw new Error(`Invalid callable ID '${callableId}'`);
  }

  private async callSessionsList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = sessionsListInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

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
          cfg: this.params.config,
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
          cfg: this.params.config,
        }),
      });
    }

    return out;
  }

  private async callMessagesList(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesListInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    const sessionRef = asDiscordSessionRef(channelId, guildId ?? undefined);
    const limit = input.limit ?? 50;
    const messages = await this.params.adapter.listMsg(sessionRef, { limit });

    // Adapter store should only contain allowed messages, but keep tool-side filtering anyway.
    return messages.filter((m) =>
      shouldAllowDiscordChannel({
        cfg: this.params.config,
        channelId: m.session.channelId,
        guildId: m.session.guildId,
      }),
    );
  }

  private async callMessagesRead(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesReadInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    const msgRef = asDiscordMsgRef(channelId, input.messageId);
    const msg = await this.params.adapter.readMsg(msgRef);

    if (!msg) return null;

    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
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
    const input = messagesSendInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
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

    const ref = await this.params.adapter.sendMsg(
      sessionRef,
      { text: input.text },
      replyTo ? { replyTo } : undefined,
    );

    return { ok: true as const, ref };
  }

  private async callMessagesEdit(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = messagesEditInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
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
    const input = messagesDeleteInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
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
    const input = reactionsListInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    return await this.params.adapter.listReactions(
      asDiscordMsgRef(channelId, input.messageId),
    );
  }

  private async callReactionsAdd(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = reactionsAddInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.addReaction(
      asDiscordMsgRef(channelId, input.messageId),
      input.reaction,
    );

    return { ok: true as const };
  }

  private async callReactionsRemove(
    rawInput: Record<string, unknown>,
    ctx: RequestContext | undefined,
  ) {
    const input = reactionsRemoveInputSchema.parse(rawInput);
    const client = resolveClient({ inputClient: input.client, ctx });
    ensureDiscordClient(client);

    const channelId = resolveDiscordSessionId({
      sessionId: input.sessionId,
      cfg: this.params.config,
    });

    const guildId = await resolveGuildIdForChannel({
      adapter: this.params.adapter,
      channelId,
    });
    if (
      !shouldAllowDiscordChannel({
        cfg: this.params.config,
        channelId,
        guildId,
      })
    ) {
      throw new Error(`Not allowed: channelId '${channelId}'`);
    }

    await this.params.adapter.removeReaction(
      asDiscordMsgRef(channelId, input.messageId),
      input.reaction,
    );

    return { ok: true as const };
  }
}
