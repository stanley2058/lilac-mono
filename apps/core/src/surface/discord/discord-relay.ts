import { createHash, randomUUID } from "node:crypto";

import type { SurfaceOperationResult } from "../adapter";
import type { DbDiscordRelayMessage } from "../store/discord-surface-store";
import type { ThreadSendResult } from "../thread-control";
import type { MsgRef } from "../types";

/**
 * A message Lilac posts into a Discord channel for an agent run on another surface. The bot is
 * its author, but Lilac admits it like a user message from the linked Discord account, so the
 * channel's agent is steered or started by it. Only rows Core wrote make a bot message a relay;
 * its visible text proves nothing.
 */
export type DiscordRelayMode = "steer" | "auto";

export type DiscordRelaySource = {
  readonly platform: "native";
  /** The native thread whose run sent the message. */
  readonly threadId: string;
  /** The native user that run acts for. */
  readonly userId: string;
};

export type DiscordRelayOrigin = DiscordRelaySource & {
  readonly nonce: string;
  /** The linked Discord account the message is admitted as. */
  readonly discordUserId: string;
  readonly mode: DiscordRelayMode;
};

export type DiscordRelayPort = {
  sendRelayMessage(input: {
    readonly channelId: string;
    readonly text: string;
    readonly origin: DiscordRelayOrigin;
    /** The bot output message the relay replies to. */
    readonly replyToMessageId?: string;
  }): Promise<SurfaceOperationResult<MsgRef>>;
  /** Native threads with a relay record in this Discord channel. */
  relaySourcesForChannel(channelId: string): readonly DiscordRelaySource[];
  /** What a keyed send first reported, if it already posted. */
  findRelayResult(nonce: string): ThreadSendResult | null;
  /** Keeps the first result for a nonce and returns it, so overlapping retries agree. */
  recordRelayResult(nonce: string, result: ThreadSendResult): ThreadSendResult;
  /** Stops a running request as the Cancel button does, for the linked Discord user. */
  cancelRequest(input: {
    readonly channelId: string;
    readonly requestId: string;
    readonly discordUserId: string;
  }): Promise<void>;
};

export type DiscordRelayOutputRecorder = {
  /** Links an output message to the relays its request consumed. */
  recordRelayOutput(input: {
    readonly channelId: string;
    readonly messageId: string;
    readonly nonces: readonly string[];
  }): void;
};

/** Discord limits a message to 2000 characters. */
export const DISCORD_RELAY_MAX_MESSAGE_CHARS = 2000;
/** Discord accepts nonces up to 25 characters. */
const DISCORD_NONCE_MAX_CHARS = 25;

/**
 * A retried send reuses its command's nonce, so Discord's `enforce_nonce` and the relay table
 * both treat it as the same message. The key is scoped to the sending user, thread, and channel,
 * so two runs that happen to pick the same commandId never share a relay.
 */
export function discordRelayNonce(
  commandId: string | undefined,
  scope: { readonly userId: string; readonly threadId: string; readonly channelId: string },
): string {
  const seed = commandId
    ? JSON.stringify([scope.userId, scope.threadId, scope.channelId, commandId])
    : randomUUID();
  return createHash("sha256")
    .update(`discord-relay:${seed}`)
    .digest("base64url")
    .slice(0, DISCORD_NONCE_MAX_CHARS);
}

const DISCORD_RELAY_SOURCE_LINE_PREFIX = "-# ↪ Sent from Lilac web for ";

/**
 * The visible message: a bot mention so the router admits it, a source line, then the text. The
 * sender mention renders the linked user's name; the send allows no mention but the bot's, so it
 * does not ping them.
 */
export function formatDiscordRelayText(input: {
  readonly botUserId: string;
  readonly senderMention: string;
  readonly text: string;
}): string {
  return `<@${input.botUserId}>\n${DISCORD_RELAY_SOURCE_LINE_PREFIX}${input.senderMention}\n${input.text}`;
}

/** A relay's text without the mention and source lines, which are for people only. */
export function discordRelayBody(text: string): string {
  const lines = text.split("\n");
  const sourceLine = lines.findIndex((line) => line.startsWith(DISCORD_RELAY_SOURCE_LINE_PREFIX));
  return sourceLine >= 0 && sourceLine <= 1 ? lines.slice(sourceLine + 1).join("\n") : text;
}

/** What a relay message carries on `SurfaceMessage.raw.discord.relay`. */
export type DiscordRelayRaw = DiscordRelayOrigin & {
  /** The bot account that actually posted the message. */
  readonly botUserId: string;
  readonly botName: string;
};

function isDiscordRelayMode(value: string): value is DiscordRelayMode {
  return value === "steer" || value === "auto";
}

/** A stored relay row as message metadata; a row this version cannot read is not a relay. */
export function discordRelayFromRow(
  row: DbDiscordRelayMessage,
  bot: { readonly userId: string; readonly name: string },
): DiscordRelayRaw | undefined {
  if (row.source_platform !== "native" || !isDiscordRelayMode(row.mode)) return undefined;
  return {
    nonce: row.nonce,
    platform: "native",
    threadId: row.source_thread_id,
    userId: row.source_user_id,
    discordUserId: row.discord_user_id,
    mode: row.mode,
    botUserId: bot.userId,
    botName: bot.name,
  };
}

/**
 * The `LILAC_META` fields for a relay message. The author is the agent itself; `relay` names the
 * trigger and the native thread the channel's agent may read with `orchestrate`.
 */
export function discordRelayMetadata(relay: DiscordRelayRaw) {
  return {
    user_id: relay.botUserId,
    user_name: relay.botName,
    author: "lilac",
    relay: {
      trigger: "orchestrate",
      mode: relay.mode,
      on_behalf_of_discord_user_id: relay.discordUserId,
      source: {
        client: relay.platform,
        thread_id: relay.threadId,
        user_id: relay.userId,
      },
    },
  };
}

/**
 * Whether a relay mention joins the running request instead of starting its own, by the rules
 * the Discord router applies to a person's mention. A reply to the running output steers in every
 * mode. In an active-mode session any other mention also joins, unless it replies to older bot
 * output, which starts a new request from that reply chain. In a mention-mode session it starts a
 * new request, which waits behind the running one.
 */
export function relayJoinsActiveRequest(input: {
  readonly mode: "mention" | "active";
  readonly activeOutputMessageIds: ReadonlySet<string>;
  readonly replyToMessageId: string | undefined;
  readonly replyToBot: boolean;
}): boolean {
  const repliesToActiveOutput =
    input.replyToMessageId !== undefined &&
    input.activeOutputMessageIds.has(input.replyToMessageId);
  if (repliesToActiveOutput) return true;
  return input.mode === "active" && !input.replyToBot;
}

/** How the Discord router will admit a relay, as it last saw the channel. */
export type DiscordRelayAdmission =
  | { readonly kind: "joins"; readonly requestId: string }
  | { readonly kind: "starts"; readonly queued: boolean };

/** A target message for a Discord send or read: `discord:<channelId>:<messageId>`. */
export function parseDiscordMessageTarget(
  id: string,
): { readonly channelId: string; readonly messageId: string } | null {
  const match = /^discord:(\d+):(\d+)$/u.exec(id.trim());
  return match ? { channelId: match[1]!, messageId: match[2]! } : null;
}

/** What Discord thread control needs from the running Discord router. */
export type DiscordRouterView = {
  activeRequest(
    sessionId: string,
  ): { readonly requestId: string; readonly outputMessageIds: readonly string[] } | undefined;
  relayAdmission(input: {
    readonly sessionId: string;
    readonly replyToMessageId?: string;
    readonly replyToBot: boolean;
    /** A relay sent with mode steer joins whatever request is running. */
    readonly steer?: boolean;
  }): DiscordRelayAdmission;
};
