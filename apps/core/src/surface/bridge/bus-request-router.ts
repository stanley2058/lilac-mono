import { generateText, Output, type ModelMessage } from "ai";
import { z } from "zod";

import {
  getCoreConfig,
  resolveLogLevel,
  resolveModelSlot,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import {
  lilacEventTypes,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import { Logger } from "@stanley2058/simple-module-logger";

import type { SurfaceAdapter } from "../adapter";
import type { MsgRef } from "../types";
import {
  composeRecentChannelMessages,
  composeRequestMessages,
  composeSingleMessage,
} from "./request-composition";

type SessionMode = "mention" | "active";

function previewText(text: string, max = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

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
  const entry = cfg.surface.router.sessionModes[sessionId];
  return entry?.mode ?? cfg.surface.router.defaultMode;
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

type BufferedMessage = {
  msgRef: MsgRef;
  userId: string;
  text: string;
  mentionsBot: boolean;
  replyToBot: boolean;
};

type DebounceBuffer = {
  sessionId: string;
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
};

export async function startBusRequestRouter(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  subscriptionId: string;
  /** Optionally inject config; defaults to getCoreConfig(). */
  config?: CoreConfig;
  /**
   * Optionally suppress routing for specific adapter events.
   * Used to prevent workflow-resume replies from also being treated as normal prompts.
   */
  shouldSuppressAdapterEvent?: (input: {
    evt: EvtAdapterMessageCreatedData;
  }) => Promise<{ suppress: boolean; reason?: string }>;
  /** Optional injection for unit tests (bypasses real model call). */
  routerGate?: (input: {
    sessionId: string;
    botName: string;
    messages: BufferedMessage[];
  }) => Promise<{ forward: boolean; reason?: string }>;
}) {
  const { adapter, bus, subscriptionId } = params;

  const logger = new Logger({
    module: "bus-request-router",
    logLevel: resolveLogLevel(),
  });

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

      if (params.shouldSuppressAdapterEvent) {
        const decision = await params
          .shouldSuppressAdapterEvent({ evt: msg.data })
          .catch((e: unknown) => {
            logger.error("router suppression hook failed; proceeding", e);
            return { suppress: false as const };
          });

        if (decision.suppress) {
          logger.info("router suppressed adapter message", {
            sessionId: msg.data.channelId,
            messageId: msg.data.messageId,
            userId: msg.data.userId,
            reason: decision.reason,
          });
          await ctx.commit();
          return;
        }
      }

      // reload config opportunistically (mtime cached in getCoreConfig).
      cfg = params.config ?? (await getCoreConfig());

      const sessionId = msg.data.channelId;
      const msgRef = parseDiscordMsgRefFromAdapterEvent(msg.data);

      const flags = getDiscordFlags(msg.data.raw);
      const isDm = flags.isDMBased === true;

      const mode: SessionMode = isDm
        ? "active"
        : getSessionMode(cfg, sessionId);

      const active = activeBySession.get(sessionId);

      logger.debug("adapter.message.created", {
        sessionId,
        messageId: msgRef.messageId,
        userId: msg.data.userId,
        mode,
        isDm,
        mentionsBot: flags.mentionsBot === true,
        replyToBot: flags.replyToBot === true,
        activeRequestId: active?.requestId,
        textPreview:
          typeof msg.data.text === "string" && msg.data.text.trim().length > 0
            ? previewText(msg.data.text)
            : undefined,
      });

      if (mode === "active") {
        if (isDm) {
          await handleActiveDmMode({
            adapter,
            bus,
            cfg,
            sessionId,
            msgRef,
            userId: msg.data.userId,
            active,
          });
        } else {
          await handleActiveChannelMode({
            adapter,
            bus,
            cfg,
            buffers,
            sessionId,
            msgRef,
            userId: msg.data.userId,
            userText: msg.data.text,
            mentionsBot: flags.mentionsBot === true,
            replyToBot: flags.replyToBot === true,
            active,
          });
        }

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

  function clearDebounceBuffer(sessionId: string) {
    const b = buffers.get(sessionId);
    if (!b) return;
    buffers.delete(sessionId);
    if (b.timer) {
      clearTimeout(b.timer);
      b.timer = null;
    }
  }

  async function handleActiveDmMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    active: ActiveSessionState | undefined;
  }) {
    const { adapter, bus, cfg, sessionId, msgRef, userId, active } = input;

    if (active) {
      // DMs: while active, everything is a steer.
      await publishComposedRequest({
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

    // DMs: no gate; start a new request immediately.
    const requestId = `discord:${sessionId}:${msgRef.messageId}`;

    await publishComposedRequest({
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      queue: "prompt",
      triggerType: "active",
      msgRef,
      userId,
    });
  }

  async function handleActiveChannelMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    buffers: Map<string, DebounceBuffer>;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    userText: string;
    mentionsBot: boolean;
    replyToBot: boolean;
    active: ActiveSessionState | undefined;
  }) {
    const {
      adapter,
      bus,
      cfg,
      buffers,
      sessionId,
      msgRef,
      userId,
      userText,
      mentionsBot,
      replyToBot,
      active,
    } = input;

    if (active) {
      // Keep users separated: only the active user is allowed to inject follow-ups.
      if (active.activeUserId && active.activeUserId !== userId) {
        bufferActiveChannelMessage({
          buffers,
          cfg,
          sessionId,
          message: {
            msgRef,
            userId,
            text: userText,
            mentionsBot,
            replyToBot,
          },
        });
        return;
      }

      await publishSingleMessageToActiveRequest({
        adapter,
        bus,
        cfg,
        requestId: active.requestId,
        sessionId,
        queue: "followUp",
        msgRef,
      });
      return;
    }

    // No active request.
    if (mentionsBot || replyToBot) {
      // Mention/reply is a bypass trigger.
      // Discard any pending buffer to avoid a second gated request for the same context.
      clearDebounceBuffer(sessionId);

      const requestId = `discord:${sessionId}:${msgRef.messageId}`;

      await publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        triggerMsgRef: msgRef,
        triggerType: mentionsBot ? "mention" : "reply",
        activeUserId: userId,
      });
      return;
    }

    bufferActiveChannelMessage({
      buffers,
      cfg,
      sessionId,
      message: {
        msgRef,
        userId,
        text: userText,
        mentionsBot,
        replyToBot,
      },
    });
  }

  function bufferActiveChannelMessage(input: {
    buffers: Map<string, DebounceBuffer>;
    cfg: CoreConfig;
    sessionId: string;
    message: BufferedMessage;
  }) {
    const { buffers, cfg, sessionId, message } = input;

    const existing = buffers.get(sessionId);
    if (!existing) {
      logger.debug("router debounce start", {
        sessionId,
        debounceMs: cfg.surface.router.activeDebounceMs,
      });

      const buffer: DebounceBuffer = {
        sessionId,
        messages: [message],
        timer: null,
      };

      buffer.timer = setTimeout(() => {
        flushDebounce(sessionId).catch((e: unknown) => {
          logger.error("router flushDebounce failed", { sessionId }, e);
        });
      }, cfg.surface.router.activeDebounceMs);

      buffers.set(sessionId, buffer);
      return;
    }

    existing.messages.push(message);
  }

  async function flushDebounce(sessionId: string) {
    const b = buffers.get(sessionId);
    if (!b) return;
    clearDebounceBuffer(sessionId);

    // Gate is only for active channels with no running request.
    const gateCfg = cfg.surface.router.activeGate;
    if (!gateCfg.enabled) {
      return;
    }

    const gate = params.routerGate ?? shouldForwardActiveBatch;

    const decision = await gate({
      sessionId,
      botName: cfg.surface.discord.botName,
      messages: b.messages,
    }).catch((e: unknown) => {
      logger.error("router gate failed; skipping", { sessionId }, e);
      return { forward: false, reason: "error" };
    });

    if (!decision.forward) {
      logger.info(
        { sessionId, reason: decision.reason ?? "skip" },
        "router gate skipped batch",
      );
      return;
    }

    logger.info(
      {
        sessionId,
        reason: decision.reason ?? "forward",
        messageCount: b.messages.length,
      },
      "router gate forwarded batch",
    );

    // Gate-forwarded prompt: do NOT reply-to a message.
    // Anchor the "active user" as the newest message author in the batch.
    await publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId: randomRequestId(),
      sessionId,
      triggerMsgRef: undefined,
      triggerType: undefined,
      activeUserId: b.messages[b.messages.length - 1]?.userId,
    });
  }

  const gateSchema = z.object({
    forward: z.boolean(),
    reason: z.string().optional(),
  });

  async function shouldForwardActiveBatch(input: {
    sessionId: string;
    botName: string;
    messages: BufferedMessage[];
  }): Promise<{ forward: boolean; reason?: string }> {
    const gateCfg = cfg.surface.router.activeGate;

    const timeoutMs = gateCfg.timeoutMs;
    const abort = new AbortController();

    const timeout = setTimeout(() => abort.abort(), timeoutMs);

    try {
      const resolved = resolveModelSlot(cfg, "fast");

      const indirectMention = input.messages.some((m) =>
        m.text.toLowerCase().includes(input.botName.toLowerCase()),
      );

      const transcript = input.messages
        .map((m) => `[user_id=${m.userId}] ${m.text}`)
        .join("\n");

      const prompt = [
        {
          role: "system",
          content: [
            "You are a router gate for a chat bot.",
            "Decide whether the bot should start a new request and reply.",
            'Return strict JSON only: {"forward": true|false, "reason"?: string}',
            "If uncertain, return forward=false.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `sessionId=${input.sessionId}`,
            `botName=${input.botName}`,
            `indirectMention=${String(indirectMention)}`,
            "",
            "Batch:",
            transcript,
            "",
            "Special case: if this looks like a heartbeat poll that expects a reply (e.g. mentions HEARTBEAT.md/HEARTBEAT_OK), forward=true.",
          ].join("\n"),
        },
      ] as ModelMessage[];

      const res = await generateText({
        model: resolved.model,
        output: Output.object({ schema: gateSchema }),
        prompt,
        abortSignal: abort.signal,
        maxOutputTokens: 1024,
        providerOptions: resolved.providerOptions,
      });

      return res.output;
    } catch (e) {
      logger.error("router gate error", { sessionId: input.sessionId }, e);
      return { forward: false, reason: "error" };
    } finally {
      clearTimeout(timeout);
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
        await publishComposedRequest({
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

      await publishComposedRequest({
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

      await publishComposedRequest({
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
      await publishComposedRequest({
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
    await publishComposedRequest({
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

  async function publishBusRequest(input: {
    requestId: string;
    sessionId: string;
    queue: RequestQueueMode;
    triggerType: "mention" | "reply" | "active";
    messages: ModelMessage[];
    raw: unknown;
  }) {
    logger.info("cmd.request.message publish", {
      requestId: input.requestId,
      sessionId: input.sessionId,
      queue: input.queue,
      triggerType: input.triggerType,
      messageCount: input.messages.length,
      lastUserPreview: (() => {
        for (let i = input.messages.length - 1; i >= 0; i--) {
          const m = input.messages[i]!;
          if (m.role !== "user") continue;
          if (typeof m.content === "string") return previewText(m.content);
        }
        return undefined;
      })(),
    });

    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        queue: input.queue,
        messages: input.messages,
        raw: input.raw,
      },
      {
        headers: {
          request_id: input.requestId,
          session_id: input.sessionId,
          request_client: "discord",
        },
      },
    );
  }

  async function publishComposedRequest(input: {
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
    const { adapter, cfg, requestId, sessionId, queue, triggerType, msgRef } =
      input;

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

    await publishBusRequest({
      requestId,
      sessionId,
      queue,
      triggerType,
      messages: composed.messages,
      raw: {
        triggerType,
        chainMessageIds: composed.chainMessageIds,
        mergedGroups: composed.mergedGroups,
      },
    });
  }

  async function publishActiveChannelPrompt(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    requestId: string;
    sessionId: string;
    triggerMsgRef: MsgRef | undefined;
    triggerType: "mention" | "reply" | undefined;
    activeUserId: string | undefined;
  }) {
    const { adapter, cfg, requestId, sessionId, triggerMsgRef, triggerType } =
      input;

    const self = await adapter.getSelf();

    const composed = await composeRecentChannelMessages(adapter, {
      platform: "discord",
      sessionId,
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      limit: 8,
      triggerMsgRef,
      triggerType,
    });

    await publishBusRequest({
      requestId,
      sessionId,
      queue: "prompt",
      triggerType: triggerType ?? "active",
      messages: composed.messages,
      raw: {
        triggerType: triggerType ?? "active",
        chainMessageIds: composed.chainMessageIds,
        mergedGroups: composed.mergedGroups,
      },
    });

    // Ensure the router knows who is allowed to follow up while this request is active.
    if (input.activeUserId) {
      activeBySession.set(sessionId, {
        requestId,
        activeUserId: input.activeUserId,
      });
    } else {
      activeBySession.set(sessionId, { requestId });
    }
  }

  async function publishSingleMessageToActiveRequest(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    requestId: string;
    sessionId: string;
    queue: "followUp" | "steer";
    msgRef: MsgRef;
  }) {
    const { adapter, cfg, requestId, sessionId, queue, msgRef } = input;

    const self = await adapter.getSelf();

    const msg = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      msgRef,
    });

    if (!msg) return;

    await publishBusRequest({
      requestId,
      sessionId,
      queue,
      triggerType: "active",
      messages: [msg],
      raw: {
        triggerType: "active",
      },
    });
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
