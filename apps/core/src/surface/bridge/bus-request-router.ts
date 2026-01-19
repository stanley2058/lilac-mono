import { getCoreConfig, type CoreConfig } from "@stanley2058/lilac-utils";
import {
  lilacEventTypes,
  type LilacBus,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";

import type { SurfaceAdapter } from "../adapter";
import type { MsgRef } from "../types";
import { composeRequestMessages } from "./request-composition";

type SessionMode = "mention" | "active";

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function randomRequestId(): string {
  // Use a stable prefix to make it easy to spot in logs.
  return `req:${crypto.randomUUID()}`;
}

function parseDiscordMsgRefFromAdapterEvent(data: {
  platform: string;
  channelId: string;
  messageId: string;
}): MsgRef {
  if (data.platform !== "discord") {
    throw new Error(`Unsupported platform '${data.platform}'`);
  }
  return {
    platform: "discord",
    channelId: data.channelId,
    messageId: data.messageId,
  };
}

function getSessionMode(cfg: CoreConfig, sessionId: string): SessionMode {
  const entry = cfg.surface.discord.router.sessionModes[sessionId];
  return entry?.mode ?? cfg.surface.discord.router.defaultMode;
}

function getDiscordFlags(raw: unknown): {
  isDMBased?: boolean;
  mentionsBot?: boolean;
  replyToBot?: boolean;
} {
  if (!raw || typeof raw !== "object") return {};
  const discord = (raw as { discord?: unknown }).discord;
  if (!discord || typeof discord !== "object") return {};

  const o = discord as Record<string, unknown>;

  return {
    isDMBased: typeof o.isDMBased === "boolean" ? o.isDMBased : undefined,
    mentionsBot: typeof o.mentionsBot === "boolean" ? o.mentionsBot : undefined,
    replyToBot: typeof o.replyToBot === "boolean" ? o.replyToBot : undefined,
  };
}

type ActiveSessionState = {
  requestId: string;
  activeUserId?: string;
};

type DebounceBuffer = {
  sessionId: string;
  firstMessageId: string;
  firstMsgRef: MsgRef;
  botUserId?: string;
  botName?: string;
  triggerType: "mention" | "reply" | "active";
  userId: string;
  msgRefs: MsgRef[];
  timer: ReturnType<typeof setTimeout> | null;
};

export async function startBusRequestRouter(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  subscriptionId: string;
  /** Optionally inject config; defaults to getCoreConfig(). */
  config?: CoreConfig;
}) {
  const { adapter, bus, subscriptionId } = params;

  let cfg = params.config ?? (await getCoreConfig());

  const activeBySession = new Map<string, ActiveSessionState>();
  const buffers = new Map<string, DebounceBuffer>();

  const lifecycleSub = await bus.subscribeTopic(
    "evt.request",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:lifecycle`,
      consumerId: consumerId(`${subscriptionId}:lifecycle`),
      offset: { type: "now" },
      batch: { maxWaitMs: 250 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtRequestLifecycleChanged) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      if (!requestId || !sessionId) {
        // Don't ack: malformed.
        throw new Error(
          "evt.request.lifecycle.changed missing required headers.request_id/session_id",
        );
      }

      if (msg.data.state === "running") {
        const prev = activeBySession.get(sessionId);
        activeBySession.set(sessionId, {
          requestId,
          activeUserId: prev?.activeUserId,
        });
      }

      if (
        msg.data.state === "resolved" ||
        msg.data.state === "failed" ||
        msg.data.state === "cancelled"
      ) {
        const cur = activeBySession.get(sessionId);
        if (cur?.requestId === requestId) {
          activeBySession.delete(sessionId);
        }
      }

      await ctx.commit();
    },
  );

  const adapterSub = await bus.subscribeTopic(
    "evt.adapter",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:adapter`,
      consumerId: consumerId(`${subscriptionId}:adapter`),
      offset: { type: "now" },
      batch: { maxWaitMs: 250 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtAdapterMessageCreated) return;
      if (msg.data.platform !== "discord") return;

      // reload config opportunistically (mtime cached in getCoreConfig).
      cfg = params.config ?? (await getCoreConfig());

      const sessionId = msg.data.channelId;
      const msgRef = parseDiscordMsgRefFromAdapterEvent(msg.data);

      const flags = getDiscordFlags(msg.data.raw);
      const isDm = flags.isDMBased;

      const mode: SessionMode = isDm
        ? "active"
        : getSessionMode(cfg, sessionId);

      const active = activeBySession.get(sessionId);

      if (mode === "active") {
        await handleActiveMode({
          adapter,
          bus,
          cfg,
          buffers,
          sessionId,
          msgRef,
          userId: msg.data.userId,
          active,
        });
        await ctx.commit();
        return;
      }

      await handleMentionMode({
        adapter,
        bus,
        cfg,
        activeBySession,
        sessionId,
        msgRef,
        userId: msg.data.userId,
        mentionsBot: flags.mentionsBot,
        replyToBot: flags.replyToBot,
        active,
      });

      await ctx.commit();
    },
  );

  async function handleActiveMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    buffers: Map<string, DebounceBuffer>;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    active: ActiveSessionState | undefined;
  }) {
    const { adapter, bus, cfg, buffers, sessionId, msgRef, userId, active } =
      input;

    if (active) {
      // While active: always steer.
      await publishRequest({
        adapter,
        bus,
        cfg,
        requestId: active.requestId,
        sessionId,
        queue: "steer",
        triggerType: "active",
        msgRef,
        userId,
      });
      return;
    }

    const existing = buffers.get(sessionId);
    if (!existing) {
      const buffer: DebounceBuffer = {
        sessionId,
        firstMessageId: msgRef.messageId,
        firstMsgRef: msgRef,
        triggerType: "active",
        userId,
        msgRefs: [msgRef],
        timer: null,
      };

      buffer.timer = setTimeout(() => {
        flushDebounce(sessionId).catch(console.error);
      }, cfg.surface.discord.router.activeDebounceMs);

      buffers.set(sessionId, buffer);
      return;
    }

    existing.msgRefs.push(msgRef);
  }

  async function flushDebounce(sessionId: string) {
    const b = buffers.get(sessionId);
    if (!b) return;
    buffers.delete(sessionId);
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }

    // Start a new request anchored to the first message id.
    const requestId = `discord:${sessionId}:${b.firstMessageId}`;

    await publishRequest({
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      queue: "prompt",
      triggerType: b.triggerType,
      msgRef: b.firstMsgRef,
      userId: b.userId,
    });

    // Any additional buffered messages should be steered into the same request.
    for (const extra of b.msgRefs.slice(1)) {
      await publishRequest({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        queue: "steer",
        triggerType: "active",
        msgRef: extra,
        userId: b.userId,
      });
    }
  }

  async function handleMentionMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    activeBySession: Map<string, ActiveSessionState>;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    mentionsBot?: boolean;
    replyToBot?: boolean;
    active: ActiveSessionState | undefined;
  }) {
    const {
      adapter,
      bus,
      cfg,
      activeBySession,
      sessionId,
      msgRef,
      userId,
      mentionsBot,
      replyToBot,
      active,
    } = input;

    const triggerType = replyToBot ? "reply" : mentionsBot ? "mention" : null;

    if (!triggerType) {
      // In mention-only mode, ignore non-triggers if no active request.
      if (!active) return;

      // Non-trigger messages from the active user become steer.
      if (active.activeUserId && active.activeUserId === userId) {
        await publishRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: "steer",
          triggerType: "active",
          msgRef,
          userId,
        });
      }
      return;
    }

    if (!active) {
      const requestId = `discord:${sessionId}:${msgRef.messageId}`;
      activeBySession.set(sessionId, { requestId, activeUserId: userId });

      await publishRequest({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        queue: "prompt",
        triggerType,
        msgRef,
        userId,
      });
      return;
    }

    // Active request exists.
    if (
      triggerType === "mention" &&
      active.activeUserId &&
      userId !== active.activeUserId
    ) {
      // Other user mention starts a new request, which will be queued by the runner.
      const requestId = `discord:${sessionId}:${msgRef.messageId}`;
      activeBySession.set(sessionId, { requestId, activeUserId: userId });

      await publishRequest({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        queue: "prompt",
        triggerType,
        msgRef,
        userId,
      });
      return;
    }

    if (
      triggerType === "mention" &&
      active.activeUserId &&
      userId === active.activeUserId
    ) {
      await publishRequest({
        adapter,
        bus,
        cfg,
        requestId: active.requestId,
        sessionId,
        queue: "followUp",
        triggerType,
        msgRef,
        userId,
      });
      return;
    }

    // Replies to bot always steer into the active request.
    await publishRequest({
      adapter,
      bus,
      cfg,
      requestId: active.requestId,
      sessionId,
      queue: "steer",
      triggerType,
      msgRef,
      userId,
    });
  }

  async function publishRequest(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    requestId: string;
    sessionId: string;
    queue: RequestQueueMode;
    triggerType: "mention" | "reply" | "active";
    msgRef: MsgRef;
    userId: string;
  }) {
    const {
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      queue,
      triggerType,
      msgRef,
    } = input;

    const self = await adapter.getSelf();

    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      trigger: {
        type: triggerType === "mention" ? "mention" : "reply",
        msgRef,
      },
    });

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue,
        messages: composed.messages,
        raw: {
          triggerType,
          chainMessageIds: composed.chainMessageIds,
          mergedGroups: composed.mergedGroups,
        },
      },
      {
        headers: {
          request_id: requestId || randomRequestId(),
          session_id: sessionId,
          request_client: "discord",
        },
      },
    );
  }

  return {
    stop: async () => {
      await adapterSub.stop();
      await lifecycleSub.stop();
      for (const b of buffers.values()) {
        if (b.timer) clearTimeout(b.timer);
      }
      buffers.clear();
    },
  };
}
