import { generateText, Output, type ModelMessage } from "ai";
import { z } from "zod";

import {
  getCoreConfig,
  env,
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
import type { TranscriptStore } from "../../transcript/transcript-store";
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
  replyToMessageId?: string;
} {
  if (!raw || typeof raw !== "object") return {};
  const discord = (raw as { discord?: unknown }).discord;
  if (!discord || typeof discord !== "object") return {};

  const o = discord as Record<string, unknown>;

  return {
    isDMBased: typeof o.isDMBased === "boolean" ? o.isDMBased : undefined,
    mentionsBot: typeof o.mentionsBot === "boolean" ? o.mentionsBot : undefined,
    replyToBot: typeof o.replyToBot === "boolean" ? o.replyToBot : undefined,
    replyToMessageId:
      typeof o.replyToMessageId === "string" ? o.replyToMessageId : undefined,
  };
}

type ActiveSessionState = {
  requestId: string;
  /** IDs of bot output messages in the current active output chain. */
  activeOutputMessageIds: Set<string>;
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
  transcriptStore?: TranscriptStore;
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
      batch: { maxWaitMs: 1000 },
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
        activeBySession.set(sessionId, {
          requestId,
          activeOutputMessageIds: new Set(),
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

  const surfaceSub = await bus.subscribeTopic(
    "evt.surface",
    {
      mode: "fanout",
      subscriptionId: `${subscriptionId}:surface`,
      consumerId: consumerId(`${subscriptionId}:surface`),
      offset: { type: "now" },
      batch: { maxWaitMs: 1000 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtSurfaceOutputMessageCreated) return;

      const requestId = msg.headers?.request_id;
      const sessionId = msg.headers?.session_id;
      if (!requestId || !sessionId) {
        throw new Error(
          "evt.surface.output.message.created missing required headers.request_id/session_id",
        );
      }

      const cur = activeBySession.get(sessionId);
      if (!cur || cur.requestId !== requestId) {
        await ctx.commit();
        return;
      }

      const msgRef = msg.data.msgRef;
      if (
        msgRef?.platform === "discord" &&
        typeof msgRef.messageId === "string" &&
        msgRef.messageId
      ) {
        cur.activeOutputMessageIds.add(msgRef.messageId);
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
      batch: { maxWaitMs: 1000 },
    },
    async (msg, ctx) => {
      if (msg.type !== lilacEventTypes.EvtAdapterMessageCreated) return;
      if (msg.data.platform !== "discord") return;

      if (env.perf.log) {
        const lagMs = Date.now() - msg.ts;
        const shouldWarn = lagMs >= env.perf.lagWarnMs;
        const shouldSample =
          env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
        if (shouldWarn || shouldSample) {
          (shouldWarn ? logger.warn : logger.info)("perf.bus_lag", {
            stage: "evt.adapter->router",
            lagMs,
            sessionId: msg.data.channelId,
            messageId: msg.data.messageId,
            userId: msg.data.userId,
          });
        }
      }

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
            mentionsBot: flags.mentionsBot === true,
            replyToBot: flags.replyToBot === true,
            replyToMessageId: flags.replyToMessageId,
            active,
            sessionMode: mode,
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
            replyToMessageId: flags.replyToMessageId,
            active,
            sessionMode: mode,
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
        replyToMessageId: flags.replyToMessageId,
        active,
        sessionMode: mode,
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
    mentionsBot: boolean;
    replyToBot: boolean;
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
  }) {
    const {
      adapter,
      bus,
      cfg,
      sessionId,
      msgRef,
      userId,
      mentionsBot,
      replyToBot,
      active,
      sessionMode,
    } = input;

    if (active) {
      // Phase 1: DMs behave like active channels.
      // - Replies to bot fork into a new request queued behind.
      // - Everything else becomes a follow-up into the running request.
      const isReplyToActiveOutput =
        replyToBot &&
        typeof input.replyToMessageId === "string" &&
        active.activeOutputMessageIds.has(input.replyToMessageId);

      if (isReplyToActiveOutput) {
        if (mentionsBot) {
          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: false,
            replyTo: msgRef,
          });
          active.activeOutputMessageIds.clear();

          await publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: "steer",
            msgRef,
            sessionMode,
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
          sessionMode,
        });
        return;
      }

      if (replyToBot) {
        const requestId = `discord:${sessionId}:${msgRef.messageId}`;

        await publishActiveChannelPrompt({
          adapter,
          bus,
          cfg,
          requestId,
          sessionId,
          triggerMsgRef: msgRef,
          triggerType: "reply",
          sessionMode,
          markActive: false,
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
        sessionMode,
      });
      return;
    }

    const requestId = `discord:${sessionId}:${msgRef.messageId}`;

    const triggerType: "mention" | "reply" | undefined = replyToBot
      ? "reply"
      : mentionsBot
        ? "mention"
        : undefined;

    // DMs are ungated: start a new request immediately.
    await publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId,
      sessionId,
      triggerMsgRef: msgRef,
      triggerType,
      sessionMode,
      markActive: true,
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
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
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
      sessionMode,
    } = input;

    if (active) {
      // Phase 1: active channels behave like group chats.
      // - Replies to bot fork into a new request queued behind.
      // - Everything else becomes a follow-up into the running request.
      const isReplyToActiveOutput =
        replyToBot &&
        typeof input.replyToMessageId === "string" &&
        active.activeOutputMessageIds.has(input.replyToMessageId);

      if (isReplyToActiveOutput) {
        if (mentionsBot) {
          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: false,
            replyTo: msgRef,
          });
          active.activeOutputMessageIds.clear();

          await publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: "steer",
            msgRef,
            sessionMode,
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
          sessionMode,
        });
        return;
      }

      // Phase 2: active channel @mention can steer the running request.
      // IMPORTANT: replies to non-active bot messages must still fork into a queued prompt.
      if (!replyToBot && mentionsBot) {
        await publishSurfaceOutputReanchor({
          bus,
          requestId: active.requestId,
          sessionId,
          inheritReplyTo: true,
        });
        active.activeOutputMessageIds.clear();

        await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: "steer",
          msgRef,
          sessionMode,
        });
        return;
      }

      if (replyToBot) {
        const requestId = `discord:${sessionId}:${msgRef.messageId}`;

        await publishActiveChannelPrompt({
          adapter,
          bus,
          cfg,
          requestId,
          sessionId,
          triggerMsgRef: msgRef,
          triggerType: "reply",
          sessionMode,
          markActive: false,
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
        sessionMode,
      });
      return;
    }

    // No active request.
    if (mentionsBot || replyToBot) {
      // Mention/reply is a bypass trigger.
      // Discard any pending buffer to avoid a second gated request for the same context.
      clearDebounceBuffer(sessionId);

      const requestId = `discord:${sessionId}:${msgRef.messageId}`;

      const triggerType: "mention" | "reply" = replyToBot ? "reply" : "mention";

      await publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        triggerMsgRef: msgRef,
        triggerType,
        sessionMode,
        markActive: true,
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
    const sessionGateOverride =
      cfg.surface.router.sessionModes[sessionId]?.gate ?? null;
    const gateEnabled = sessionGateOverride ?? gateCfg.enabled;
    const gate = params.routerGate ?? shouldForwardActiveBatch;

    const decision = gateEnabled
      ? await gate({
          sessionId,
          botName: cfg.surface.discord.botName,
          messages: b.messages,
        }).catch((e: unknown) => {
          logger.error("router gate failed; skipping", { sessionId }, e);
          return { forward: false, reason: "error" };
        })
      : ({ forward: true as const, reason: "disabled" } satisfies {
          forward: boolean;
          reason?: string;
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
        gated: gateEnabled,
      },
      "router gate forwarded batch",
    );

    // Gate-forwarded prompt: do NOT reply-to a message.
    // Use newest message as the context anchor.
    await publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId: randomRequestId(),
      sessionId,
      // Use newest message as the context anchor (not a reply trigger).
      triggerMsgRef: b.messages[b.messages.length - 1]?.msgRef,
      triggerType: undefined,
      sessionMode: "active",
      markActive: true,
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
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
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
      // Mention-only channels: ignore non-triggers (even if a request is active).
      return;
    }

    const requestId = `discord:${sessionId}:${msgRef.messageId}`;

    // Special case (Phase 2): if the user is replying to the currently active output message,
    // treat it as a follow-up or steer into the running request (instead of forking).
    if (
      active &&
      replyToBot &&
      typeof input.replyToMessageId === "string" &&
      active.activeOutputMessageIds.has(input.replyToMessageId)
    ) {
      if (mentionsBot) {
        await publishSurfaceOutputReanchor({
          bus,
          requestId: active.requestId,
          sessionId,
          inheritReplyTo: false,
          replyTo: msgRef,
        });
        active.activeOutputMessageIds.clear();

        await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: "steer",
          msgRef,
          sessionMode: input.sessionMode,
        });
      } else {
        await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: "followUp",
          msgRef,
          sessionMode: input.sessionMode,
        });
      }
      return;
    }

    if (!active) {
      // Optimistically mark active to avoid a brief window before lifecycle updates.
      activeBySession.set(sessionId, {
        requestId,
        activeOutputMessageIds: new Set(),
      });
    }

    // Triggers always start a new request. If a request is running, the runner will queue it.
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
      sessionMode: input.sessionMode,
    });
  }

  async function publishBusRequest(input: {
    requestId: string;
    sessionId: string;
    queue: RequestQueueMode;
    triggerType: "mention" | "reply" | "active";
    sessionMode: SessionMode;
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
        raw: {
          ...(input.raw && typeof input.raw === "object"
            ? (input.raw as Record<string, unknown>)
            : {}),
          sessionMode: input.sessionMode,
        },
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
    sessionMode: SessionMode;
  }) {
    const { adapter, cfg, requestId, sessionId, queue, triggerType, msgRef } =
      input;

    const self = await adapter.getSelf();

    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      transcriptStore: params.transcriptStore,
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
      sessionMode: input.sessionMode,
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
    sessionMode: SessionMode;
    /** When true, update router's active session state immediately. */
    markActive: boolean;
  }) {
    const { adapter, cfg, requestId, sessionId, triggerMsgRef, triggerType } =
      input;

    const self = await adapter.getSelf();

    const composed = triggerMsgRef && triggerType === "reply"
      ? await composeRequestMessages(adapter, {
          platform: "discord",
          botUserId: self.userId,
          botName: cfg.surface.discord.botName,
          transcriptStore: params.transcriptStore,
          trigger: {
            type: "reply",
            msgRef: triggerMsgRef,
          },
        })
      : await composeRecentChannelMessages(adapter, {
          platform: "discord",
          sessionId,
          botUserId: self.userId,
          botName: cfg.surface.discord.botName,
          limit: 8,
          transcriptStore: params.transcriptStore,
          triggerMsgRef,
          triggerType,
        });

    await publishBusRequest({
      requestId,
      sessionId,
      queue: "prompt",
      triggerType: triggerType ?? "active",
      sessionMode: input.sessionMode,
      messages: composed.messages,
      raw: {
        triggerType: triggerType ?? "active",
        chainMessageIds: composed.chainMessageIds,
        mergedGroups: composed.mergedGroups,
      },
    });

    // Only mark active when this request is expected to start immediately.
    // For queued-behind requests we must not clobber the running request id.
    if (input.markActive) {
      activeBySession.set(sessionId, {
        requestId,
        activeOutputMessageIds: new Set(),
      });
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
    sessionMode: SessionMode;
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
      sessionMode: input.sessionMode,
      messages: [msg],
      raw: {
        triggerType: "active",
      },
    });
  }

  async function publishSurfaceOutputReanchor(input: {
    bus: LilacBus;
    requestId: string;
    sessionId: string;
    inheritReplyTo: boolean;
    replyTo?: MsgRef;
  }) {
    const { bus, requestId, sessionId, inheritReplyTo, replyTo } = input;

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      {
        inheritReplyTo,
        replyTo: replyTo
          ? {
              platform: replyTo.platform,
              channelId: replyTo.channelId,
              messageId: replyTo.messageId,
            }
          : undefined,
      },
      {
        headers: {
          request_id: requestId,
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
      await surfaceSub.stop();
      for (const b of buffers.values()) {
        if (b.timer) clearTimeout(b.timer);
      }
      buffers.clear();
    },
  };
}
