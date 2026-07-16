import {
  lilacEventTypes,
  type LilacBus,
  type LilacMessageForTopic,
} from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { z } from "zod";

import { parseRequestId } from "../surface/bridge/request-ids";
import type { MsgRef } from "../surface/types";

export type AuthenticatedRequestOrigin = {
  requestId: string;
  sessionId: string;
  platform: "discord" | "github";
  messageRef: MsgRef | null;
  actorUserId: string | null;
};

type CacheEntry = {
  messages: readonly unknown[];
  origin?: AuthenticatedRequestOrigin;
  expiresAt: number;
  updatedAt: number;
};

export type RequestMessageCacheOptions = {
  bus: LilacBus;
  /** Consumer group id for the subscription. */
  subscriptionId?: string;
  /** TTL for cached request messages. Default: 30 minutes. */
  ttlMs?: number;
  /** Max cached requests. Default: 256. */
  maxEntries?: number;
};

export type RequestMessageCache = {
  get(requestId: string): readonly unknown[] | undefined;
  getOrigin(requestId: string): AuthenticatedRequestOrigin | undefined;
  stop(): Promise<void>;
};

const requestRawSchema = z
  .object({
    authenticatedActor: z
      .object({ platform: z.enum(["discord", "github"]), userId: z.string().min(1).optional() })
      .optional(),
    authenticatedOrigin: z
      .object({
        platform: z.enum(["discord", "github"]),
        userId: z.string().min(1),
        messageRef: z.object({
          platform: z.enum(["discord", "github"]),
          channelId: z.string().min(1),
          messageId: z.string().min(1),
        }),
      })
      .optional(),
    github: z
      .object({
        trigger: z.union([
          z.object({ kind: z.literal("comment"), commentId: z.number().int().positive() }),
          z.object({ kind: z.literal("issue"), issueNumber: z.number().int().positive() }),
        ]),
      })
      .optional(),
  })
  .passthrough();

function resolveAuthenticatedOrigin(
  msg: Extract<LilacMessageForTopic<"cmd.request">, { type: "cmd.request.message" }>,
): AuthenticatedRequestOrigin | undefined {
  const requestId = msg.headers?.request_id;
  const sessionId = msg.headers?.session_id;
  const platform = msg.headers?.request_client;
  if (!requestId || !sessionId || (platform !== "discord" && platform !== "github")) {
    return undefined;
  }

  const raw = requestRawSchema.safeParse(msg.data.raw);
  const actor = raw.success ? raw.data.authenticatedActor : undefined;
  const authenticatedOrigin = raw.success ? raw.data.authenticatedOrigin : undefined;
  if (actor && actor.platform !== platform) return undefined;
  if (
    authenticatedOrigin &&
    (authenticatedOrigin.platform !== platform ||
      authenticatedOrigin.messageRef.platform !== platform ||
      authenticatedOrigin.messageRef.channelId !== sessionId)
  ) {
    return undefined;
  }

  if (authenticatedOrigin) {
    const messageRef: MsgRef =
      platform === "discord"
        ? {
            platform,
            channelId: authenticatedOrigin.messageRef.channelId,
            messageId: authenticatedOrigin.messageRef.messageId,
          }
        : {
            platform,
            channelId: authenticatedOrigin.messageRef.channelId,
            messageId: authenticatedOrigin.messageRef.messageId,
          };
    return {
      requestId,
      sessionId,
      platform,
      messageRef,
      actorUserId: authenticatedOrigin.userId,
    };
  }

  if (platform === "discord") {
    const parsed = parseRequestId(requestId);
    const messageRef =
      parsed?.kind === "discord_message" && parsed.channelId === sessionId
        ? ({ platform, channelId: sessionId, messageId: parsed.messageId } satisfies MsgRef)
        : null;
    const actorUserId = actor?.userId ?? null;
    if (!messageRef && !actorUserId) return undefined;
    return { requestId, sessionId, platform, messageRef, actorUserId };
  }

  const trigger = raw.success ? raw.data.github?.trigger : undefined;
  if (!trigger) return undefined;
  const messageId =
    trigger.kind === "comment" ? String(trigger.commentId) : String(trigger.issueNumber);
  return {
    requestId,
    sessionId,
    platform,
    messageRef: { platform, channelId: sessionId, messageId },
    actorUserId: actor?.userId ?? null,
  };
}

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

export async function createRequestMessageCache(
  options: RequestMessageCacheOptions,
): Promise<RequestMessageCache> {
  const {
    bus,
    subscriptionId = "tool-server:request-cache",
    ttlMs = 30 * 60 * 1000,
    maxEntries = 256,
  } = options;

  // Prevent unbounded growth for a single requestId when follow-ups/steers
  // arrive as incremental message batches.
  const maxMessagesPerRequest = 512;
  const logger = createLogger({
    module: "tool-server:request-message-cache",
  });

  const map = new Map<string, CacheEntry>();

  function pruneExpired(now = Date.now()) {
    for (const [k, v] of map) {
      if (v.expiresAt <= now) {
        map.delete(k);
        logger.debug("request_message_cache.expired", {
          requestId: k,
          expiresAt: v.expiresAt,
        });
      }
    }
  }

  function pruneMax() {
    while (map.size > maxEntries) {
      let oldestKey: string | null = null;
      let oldestUpdatedAt = Infinity;

      for (const [k, v] of map) {
        if (v.updatedAt < oldestUpdatedAt) {
          oldestUpdatedAt = v.updatedAt;
          oldestKey = k;
        }
      }

      if (!oldestKey) break;
      map.delete(oldestKey);
      logger.info("request_message_cache.evicted", {
        requestId: oldestKey,
        reason: "max_entries",
        maxEntries,
        sizeAfter: map.size,
      });
    }
  }

  function set(
    requestId: string,
    messages: readonly unknown[],
    origin?: AuthenticatedRequestOrigin,
  ) {
    const now = Date.now();
    pruneExpired(now);

    const prev = map.get(requestId);
    const merged = prev ? [...prev.messages, ...messages] : [...messages];

    const clamped =
      merged.length > maxMessagesPerRequest
        ? merged.slice(merged.length - maxMessagesPerRequest)
        : merged;

    if (clamped.length < merged.length) {
      logger.info("request_message_cache.clamped", {
        requestId,
        beforeCount: merged.length,
        afterCount: clamped.length,
        maxMessagesPerRequest,
      });
    }

    map.set(requestId, {
      messages: clamped,
      origin: prev?.origin ?? origin,
      expiresAt: now + ttlMs,
      updatedAt: now,
    });

    pruneMax();
  }

  const sub = await bus.subscribeTopic(
    "cmd.request",
    {
      mode: "fanout",
      subscriptionId,
      consumerId: consumerId(subscriptionId),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg: LilacMessageForTopic<"cmd.request">, ctx) => {
      if (msg.type !== lilacEventTypes.CmdRequestMessage) {
        await ctx.commit();
        return;
      }

      const requestId = msg.headers?.request_id;
      if (!requestId) {
        // keep unacked to surface the bug
        logger.error("request_message_cache.missing_request_id", {
          messageType: msg.type,
        });
        throw new Error("cmd.request.message missing headers.request_id");
      }

      // Append new message batches for this request.
      // cmd.request messages are often incremental (e.g. follow-ups), so overwrite semantics
      // can hide earlier user attachments.
      set(requestId, msg.data.messages, resolveAuthenticatedOrigin(msg));

      await ctx.commit();
    },
  );

  return {
    get: (requestId: string) => {
      const now = Date.now();
      const entry = map.get(requestId);
      if (!entry) {
        logger.debug("request_message_cache.get", {
          requestId,
          hit: false,
          reason: "missing",
        });
        return undefined;
      }
      if (entry.expiresAt <= now) {
        map.delete(requestId);
        logger.debug("request_message_cache.get", {
          requestId,
          hit: false,
          reason: "expired",
        });
        return undefined;
      }
      logger.debug("request_message_cache.get", {
        requestId,
        hit: true,
        messageCount: entry.messages.length,
      });
      return entry.messages;
    },
    getOrigin: (requestId: string) => {
      const entry = map.get(requestId);
      if (!entry || entry.expiresAt <= Date.now()) return undefined;
      return entry.origin;
    },
    stop: async () => {
      await sub.stop();
      map.clear();
    },
  };
}
