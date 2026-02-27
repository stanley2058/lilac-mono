import { type ModelMessage } from "ai";

import { createLogger, getCoreConfig, env, type CoreConfig } from "@stanley2058/lilac-utils";
import {
  lilacEventTypes,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import type { SurfaceAdapter } from "../adapter";
import type { MsgRef } from "../types";
import type { TranscriptStore } from "../../transcript/transcript-store";
import { composeRequestMessages, composeSingleMessage } from "./request-composition";

import {
  type SessionMode,
  type RouterConfigOverride,
  previewText,
  resolveBotMentionNames,
  normalizeGateText,
  parseLeadingModelOverride,
  stripLeadingModelOverrideDirective,
  parseSteerDirectiveMode,
  stripLeadingInterruptDirective,
  shouldRunDirectReplyMentionGate,
  consumerId,
  randomRequestId,
  bufferedPromptRequestIdForActiveRequest,
  parseDiscordMsgRefFromAdapterEvent,
  resolveSessionConfigId,
  getSessionMode,
  resolveSessionGateEnabled,
  resolveSessionModelOverride,
  buildDiscordUserAliasById,
  getDiscordFlags,
  withDefaultToolsConfig,
} from "./bus-request-router/common";
import {
  type BufferedMessage,
  type RouterGateInput,
  type RouterGateDecision,
  shouldForwardByGate,
} from "./bus-request-router/gate";
import {
  type PendingMentionReplyBatch,
  type PendingMentionReplyBatchItem,
  enqueuePendingMentionReplyBatch as enqueuePendingMentionReplyBatchImpl,
  takePendingMentionReplyBatch as takePendingMentionReplyBatchImpl,
  transformPendingUserText as transformPendingUserTextImpl,
} from "./bus-request-router/pending-batch";
import {
  type PublishBusRequestInput,
  publishActiveChannelPrompt as publishActiveChannelPromptImpl,
  publishBusRequest as publishBusRequestImpl,
  publishComposedRequest as publishComposedRequestImpl,
  publishSingleMessagePrompt as publishSingleMessagePromptImpl,
  publishSingleMessageToActiveRequest as publishSingleMessageToActiveRequestImpl,
  publishSurfaceOutputReanchor as publishSurfaceOutputReanchorImpl,
} from "./bus-request-router/publish";
import {
  resolvePreviousBatchMessageText as resolvePreviousBatchMessageTextImpl,
  resolvePreviousMessageText as resolvePreviousMessageTextImpl,
  resolveRepliedToMessageText as resolveRepliedToMessageTextImpl,
} from "./bus-request-router/context";

type ActiveSessionState = {
  requestId: string;
  /** IDs of bot output messages in the current active output chain. */
  activeOutputMessageIds: Set<string>;
};

type DebounceBuffer = {
  sessionId: string;
  sessionConfigId: string;
  parentChannelId?: string;
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
};

export async function startBusRequestRouter(params: {
  adapter: SurfaceAdapter;
  bus: LilacBus;
  subscriptionId: string;
  /** Optionally inject config; defaults to getCoreConfig(). */
  config?: RouterConfigOverride;
  transcriptStore?: TranscriptStore;
  /**
   * Optionally suppress routing for specific adapter events.
   * Used to prevent workflow-resume replies from also being treated as normal prompts.
   */
  shouldSuppressAdapterEvent?: (input: {
    evt: EvtAdapterMessageCreatedData;
  }) => Promise<{ suppress: boolean; reason?: string }>;
  /** Optional injection for unit tests (bypasses real model call). */
  routerGate?: (input: RouterGateInput) => Promise<RouterGateDecision>;
}) {
  const { adapter, bus, subscriptionId } = params;

  const logger = createLogger({
    module: "bus-request-router",
  });

  let cfg = params.config ? withDefaultToolsConfig(params.config) : await getCoreConfig();
  let coreConfigReloadHadError = false;
  let lastCoreConfigReloadError: string | null = null;

  async function reloadCoreConfigIfNeeded(): Promise<void> {
    if (params.config) return;

    try {
      cfg = await getCoreConfig();

      if (coreConfigReloadHadError) {
        logger.info("core-config reload recovered", {
          path: "core-config.yaml",
        });
      }

      coreConfigReloadHadError = false;
      lastCoreConfigReloadError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!coreConfigReloadHadError || lastCoreConfigReloadError !== msg) {
        logger.warn("core-config reload failed; using last known config", {
          path: "core-config.yaml",
          error: msg,
        });
      }

      coreConfigReloadHadError = true;
      lastCoreConfigReloadError = msg;
    }
  }

  const activeBySession = new Map<string, ActiveSessionState>();
  const buffers = new Map<string, DebounceBuffer>();
  const pendingMentionReplyBatchBySession = new Map<string, PendingMentionReplyBatch>();
  const evaluateRouterGate = (input: RouterGateInput): Promise<RouterGateDecision> => {
    return params.routerGate
      ? params.routerGate(input)
      : shouldForwardByGate({ cfg, input, logger });
  };

  async function resolvePreviousMessageText(input: {
    msgRef: MsgRef;
    triggerTs: number;
  }): Promise<string | undefined> {
    return resolvePreviousMessageTextImpl({ adapter, input });
  }

  async function resolveRepliedToMessageText(input: {
    sessionId: string;
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    return resolveRepliedToMessageTextImpl({ adapter, input });
  }

  async function resolvePreviousBatchMessageText(
    messages: readonly BufferedMessage[],
  ): Promise<string | undefined> {
    return resolvePreviousBatchMessageTextImpl({ adapter, messages });
  }

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
        logger.error("router.message.invalid_headers", {
          topic: "evt.request",
          messageType: msg.type,
          hasRequestId: Boolean(requestId),
          hasSessionId: Boolean(sessionId),
          cursor: ctx.cursor,
          rawHeadersKeys: msg.headers ? Object.keys(msg.headers) : [],
          action: "throw_unacked",
        });
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
          await flushPendingMentionReplyBatchAsPrompt({
            sessionId,
            sourceRequestId: requestId,
          });
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
        logger.error("router.message.invalid_headers", {
          topic: "evt.surface",
          messageType: msg.type,
          hasRequestId: Boolean(requestId),
          hasSessionId: Boolean(sessionId),
          cursor: ctx.cursor,
          rawHeadersKeys: msg.headers ? Object.keys(msg.headers) : [],
          action: "throw_unacked",
        });
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
        const shouldSample = env.perf.sampleRate > 0 && Math.random() < env.perf.sampleRate;
        if (shouldWarn || shouldSample) {
          if (shouldWarn) {
            logger.warn("perf.bus_lag", {
              stage: "evt.adapter->router",
              lagMs,
              sessionId: msg.data.channelId,
              messageId: msg.data.messageId,
              userId: msg.data.userId,
            });
          } else {
            logger.info("perf.bus_lag", {
              stage: "evt.adapter->router",
              lagMs,
              sessionId: msg.data.channelId,
              messageId: msg.data.messageId,
              userId: msg.data.userId,
            });
          }
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
      // If reload fails, keep using the last known good config.
      await reloadCoreConfigIfNeeded();

      const sessionId = msg.data.channelId;
      const msgRef = parseDiscordMsgRefFromAdapterEvent(msg.data);

      const flags = getDiscordFlags(msg.data.raw);
      const isDm = flags.isDMBased === true;
      const parentChannelId = flags.parentChannelId;
      const botMentionNames = resolveBotMentionNames({
        cfg,
        botUserId: flags.botUserId,
      });
      const requestModelOverride = parseLeadingModelOverride({
        text: msg.data.text,
        botNames: botMentionNames,
      });
      const configuredSessionModelOverride = resolveSessionModelOverride(
        cfg,
        sessionId,
        parentChannelId,
      );
      const modelOverride =
        requestModelOverride ?? flags.sessionModelOverride ?? configuredSessionModelOverride;
      const sessionConfigId = isDm
        ? sessionId
        : resolveSessionConfigId({
            cfg,
            sessionId,
            parentChannelId,
          });

      const mode: SessionMode = isDm ? "active" : getSessionMode(cfg, sessionId, parentChannelId);
      const gateEnabled = resolveSessionGateEnabled(cfg, sessionId, parentChannelId);

      const active = activeBySession.get(sessionId);

      const logRouteDecision = (input: {
        decision: "forward" | "skip" | "queue_followup" | "queue_prompt" | "steer" | "interrupt";
        reason: string;
      }) => {
        logger.info("router.route.decision", {
          sessionId,
          messageId: msgRef.messageId,
          userId: msg.data.userId,
          mode,
          gateEnabled,
          decision: input.decision,
          reason: input.reason,
          activeRequestId: active?.requestId,
          sessionConfigId,
          modelOverride,
          requestModelOverride,
        });
      };

      logger.debug("adapter.message.created", {
        sessionId,
        messageId: msgRef.messageId,
        userId: msg.data.userId,
        mode,
        isDm,
        mentionsBot: flags.mentionsBot === true,
        replyToBot: flags.replyToBot === true,
        activeRequestId: active?.requestId,
        sessionConfigId,
        modelOverride,
        requestModelOverride,
        textPreview:
          typeof msg.data.text === "string" && msg.data.text.trim().length > 0
            ? previewText(msg.data.text)
            : undefined,
      });

      if (
        !isDm &&
        gateEnabled &&
        shouldRunDirectReplyMentionGate({
          replyToBot: flags.replyToBot === true,
          mentionsBot: flags.mentionsBot === true,
          text: msg.data.text,
          botNames: botMentionNames,
        })
      ) {
        const [previousMessageText, repliedToMessageText] = await Promise.all([
          resolvePreviousMessageText({ msgRef, triggerTs: msg.data.ts }),
          resolveRepliedToMessageText({
            sessionId,
            replyToMessageId: flags.replyToMessageId,
          }),
        ]);

        const decision = await evaluateRouterGate({
          sessionId,
          botName: cfg.surface.discord.botName,
          messages: [
            {
              msgRef,
              userId: msg.data.userId,
              text: msg.data.text,
              ts: msg.data.ts,
              mentionsBot: flags.mentionsBot === true,
              replyToBot: flags.replyToBot === true,
            },
          ],
          context: {
            mode: "direct-reply-mention-disambiguation",
            triggerMessageText: normalizeGateText(msg.data.text),
            previousMessageText,
            repliedToMessageText,
          },
        }).catch((e: unknown) => {
          logger.error("router direct-reply gate failed; forwarding", { sessionId }, e);
          return {
            forward: true,
            reason: "error-fail-open",
          } satisfies RouterGateDecision;
        });

        if (!decision.forward) {
          logRouteDecision({
            decision: "skip",
            reason: `direct_reply_gate:${decision.reason ?? "skip"}`,
          });
          await ctx.commit();
          return;
        }

        logRouteDecision({
          decision: "forward",
          reason: `direct_reply_gate:${decision.reason ?? "forward"}`,
        });
      }

      if (mode === "active") {
        if (isDm) {
          await handleActiveDmMode({
            adapter,
            bus,
            cfg,
            sessionId,
            msgRef,
            userId: msg.data.userId,
            userText: msg.data.text,
            mentionsBot: flags.mentionsBot === true,
            replyToBot: flags.replyToBot === true,
            replyToMessageId: flags.replyToMessageId,
            active,
            sessionMode: mode,
            sessionConfigId,
            modelOverride,
            requestModelOverride,
            botMentionNames,
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
            messageTs: msg.data.ts,
            mentionsBot: flags.mentionsBot === true,
            replyToBot: flags.replyToBot === true,
            replyToMessageId: flags.replyToMessageId,
            botUserId: flags.botUserId,
            parentChannelId,
            active,
            sessionMode: mode,
            sessionConfigId,
            modelOverride,
            requestModelOverride,
            botMentionNames,
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
        userText: msg.data.text,
        mentionsBot: flags.mentionsBot,
        replyToBot: flags.replyToBot,
        replyToMessageId: flags.replyToMessageId,
        active,
        sessionMode: mode,
        sessionConfigId,
        modelOverride,
        requestModelOverride,
        botMentionNames,
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

  function enqueuePendingMentionReplyBatch(input: {
    sessionId: string;
    sourceRequestId: string;
    sessionConfigId: string;
    sessionMode: SessionMode;
    modelOverride?: string;
    item: PendingMentionReplyBatchItem;
  }) {
    enqueuePendingMentionReplyBatchImpl({
      pendingMentionReplyBatchBySession,
      input,
    });
  }

  function takePendingMentionReplyBatch(input: {
    sessionId: string;
    sourceRequestId: string;
  }): PendingMentionReplyBatch | null {
    return takePendingMentionReplyBatchImpl({
      pendingMentionReplyBatchBySession,
      input,
    });
  }

  function transformPendingUserText(
    item: PendingMentionReplyBatchItem,
  ): ((text: string) => string) | undefined {
    return transformPendingUserTextImpl(item);
  }

  async function flushPendingMentionReplyBatchAsFollowUp(input: {
    sessionId: string;
    sourceRequestId: string;
  }) {
    const batch = takePendingMentionReplyBatch(input);
    if (!batch || batch.items.length === 0) return;

    for (const item of batch.items) {
      await publishSingleMessageToActiveRequest({
        adapter,
        bus,
        cfg,
        requestId: input.sourceRequestId,
        sessionId: input.sessionId,
        sessionConfigId: batch.sessionConfigId,
        queue: "followUp",
        msgRef: item.msgRef,
        sessionMode: batch.sessionMode,
        transformUserText: transformPendingUserText(item),
      });
    }
  }

  async function flushPendingMentionReplyBatchAsPrompt(input: {
    sessionId: string;
    sourceRequestId: string;
  }) {
    const batch = takePendingMentionReplyBatch(input);
    if (!batch || batch.items.length === 0) return;

    const last = batch.items[batch.items.length - 1]!;
    const requestId = `discord:${input.sessionId}:${last.msgRef.messageId}`;

    const self = await adapter.getSelf();
    const discordUserAliasById = buildDiscordUserAliasById(cfg);

    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      transcriptStore: params.transcriptStore,
      discordUserAliasById,
      transformUserText: transformPendingUserText(last),
      transformUserTextForMessageId: last.msgRef.messageId,
      trigger: {
        type: "reply",
        msgRef: last.msgRef,
      },
    });

    const chainMessageIds = new Set(composed.chainMessageIds);
    const extraMessages: ModelMessage[] = [];

    for (const item of batch.items) {
      if (chainMessageIds.has(item.msgRef.messageId)) continue;
      const extra = await composeSingleMessage(adapter, {
        platform: "discord",
        botUserId: self.userId,
        botName: cfg.surface.discord.botName,
        msgRef: item.msgRef,
        discordUserAliasById,
        transformUserText: transformPendingUserText(item),
      });

      if (!extra) continue;
      extraMessages.push(extra);
      chainMessageIds.add(item.msgRef.messageId);
    }

    const finalMessages = (() => {
      if (extraMessages.length === 0) return composed.messages;

      let insertAt = -1;
      for (let i = composed.messages.length - 1; i >= 0; i--) {
        if (composed.messages[i]?.role === "user") {
          insertAt = i;
          break;
        }
      }

      if (insertAt < 0) {
        return [...composed.messages, ...extraMessages];
      }

      return [
        ...composed.messages.slice(0, insertAt),
        ...extraMessages,
        ...composed.messages.slice(insertAt),
      ];
    })();

    await publishBusRequest({
      requestId,
      sessionId: input.sessionId,
      sessionConfigId: batch.sessionConfigId,
      queue: "prompt",
      triggerType: "reply",
      sessionMode: batch.sessionMode,
      modelOverride: batch.modelOverride,
      messages: finalMessages,
      raw: {
        triggerType: "reply",
        chainMessageIds: [...chainMessageIds],
        mergedGroups: composed.mergedGroups,
        pendingMentionReplyBatch: {
          sourceRequestId: batch.sourceRequestId,
          size: batch.items.length,
        },
      },
    });
  }

  async function handleActiveDmMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    userText: string;
    mentionsBot: boolean;
    replyToBot: boolean;
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    botMentionNames: readonly string[];
  }) {
    const {
      adapter,
      bus,
      cfg,
      sessionId,
      msgRef,
      userText,
      userId: _userId,
      mentionsBot,
      replyToBot,
      active,
      sessionMode,
      sessionConfigId,
      modelOverride,
      requestModelOverride,
      botMentionNames,
    } = input;

    if (active) {
      // While a request is running:
      // - Replies to the active output message chain stay in the active request.
      //   - reply + mention => steer (plus output reanchor)
      //   - reply only => followUp
      // - Replies to other bot messages fork into a queued-behind prompt.
      // - Everything else becomes a follow-up into the running request.
      const isReplyToActiveOutput =
        replyToBot &&
        typeof input.replyToMessageId === "string" &&
        active.activeOutputMessageIds.has(input.replyToMessageId);

      if (isReplyToActiveOutput) {
        if (mentionsBot) {
          const steerMode = parseSteerDirectiveMode({
            text: userText,
            botNames: botMentionNames,
          });

          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: false,
            replyTo: msgRef,
            mode: steerMode,
          });
          active.activeOutputMessageIds.clear();

          await publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: steerMode,
            msgRef,
            sessionMode,
            sessionConfigId,
            transformUserText: requestModelOverride
              ? (text) =>
                  stripLeadingModelOverrideDirective({
                    text,
                    botNames: botMentionNames,
                  })
              : steerMode === "interrupt"
                ? (text) =>
                    stripLeadingInterruptDirective({
                      text,
                      botNames: botMentionNames,
                    })
                : undefined,
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
          sessionConfigId,
          transformUserText: requestModelOverride
            ? (text) =>
                stripLeadingModelOverrideDirective({
                  text,
                  botNames: botMentionNames,
                })
            : undefined,
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
          sessionConfigId,
          modelOverride,
          transformTriggerUserText: requestModelOverride
            ? (text: string) =>
                stripLeadingModelOverrideDirective({
                  text,
                  botNames: botMentionNames,
                })
            : undefined,
          transformUserTextForMessageId: msgRef.messageId,
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
        sessionConfigId,
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
      sessionConfigId,
      modelOverride,
      transformTriggerUserText: requestModelOverride
        ? (text) =>
            stripLeadingModelOverrideDirective({
              text,
              botNames: botMentionNames,
            })
        : undefined,
      transformUserTextForMessageId: msgRef.messageId,
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
    messageTs: number;
    mentionsBot: boolean;
    replyToBot: boolean;
    replyToMessageId?: string;
    botUserId?: string;
    parentChannelId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    botMentionNames: readonly string[];
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
      messageTs,
      mentionsBot,
      replyToBot,
      botUserId,
      parentChannelId,
      active,
      sessionMode,
      sessionConfigId,
      modelOverride,
      requestModelOverride,
      botMentionNames,
    } = input;

    if (active) {
      // Active channels behave like group chats while a request is running.
      // - Replies to the active output message chain stay in the active request.
      //   - reply + mention => steer (plus output reanchor)
      //   - reply only => followUp
      // - Mentions (not replies) can steer the active request (plus output reanchor).
      // - Replies to other bot messages fork into a queued-behind prompt.
      // - Everything else becomes a follow-up into the running request.
      const isReplyToActiveOutput =
        replyToBot &&
        typeof input.replyToMessageId === "string" &&
        active.activeOutputMessageIds.has(input.replyToMessageId);

      if (isReplyToActiveOutput) {
        if (mentionsBot) {
          const steerMode = parseSteerDirectiveMode({
            text: userText,
            botNames: botMentionNames,
          });

          await publishSurfaceOutputReanchor({
            bus,
            requestId: active.requestId,
            sessionId,
            inheritReplyTo: false,
            replyTo: msgRef,
            mode: steerMode,
          });
          active.activeOutputMessageIds.clear();

          await publishSingleMessageToActiveRequest({
            adapter,
            bus,
            cfg,
            requestId: active.requestId,
            sessionId,
            queue: steerMode,
            msgRef,
            sessionMode,
            sessionConfigId,
            transformUserText: requestModelOverride
              ? (text: string) =>
                  stripLeadingModelOverrideDirective({
                    text,
                    botNames: botMentionNames,
                  })
              : steerMode === "interrupt"
                ? (text) =>
                    stripLeadingInterruptDirective({
                      text,
                      botNames: botMentionNames,
                    })
                : undefined,
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
          sessionConfigId,
          transformUserText: requestModelOverride
            ? (text: string) =>
                stripLeadingModelOverrideDirective({
                  text,
                  botNames: botMentionNames,
                })
            : undefined,
        });
        return;
      }

      // Active channel @mention (not a reply) can steer the running request.
      // IMPORTANT: replies to non-active bot messages must still fork into a queued prompt.
      if (!replyToBot && mentionsBot) {
        const steerMode = parseSteerDirectiveMode({
          text: userText,
          botNames: botMentionNames,
        });

        await publishSurfaceOutputReanchor({
          bus,
          requestId: active.requestId,
          sessionId,
          inheritReplyTo: true,
          mode: steerMode,
        });
        active.activeOutputMessageIds.clear();

        await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: steerMode,
          msgRef,
          sessionMode,
          sessionConfigId,
          transformUserText: requestModelOverride
            ? (text: string) =>
                stripLeadingModelOverrideDirective({
                  text,
                  botNames: botMentionNames,
                })
            : steerMode === "interrupt"
              ? (text) =>
                  stripLeadingInterruptDirective({
                    text,
                    botNames: botMentionNames,
                  })
              : undefined,
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
          sessionConfigId,
          transformTriggerUserText: requestModelOverride
            ? (text: string) =>
                stripLeadingModelOverrideDirective({
                  text,
                  botNames: botMentionNames,
                })
            : undefined,
          transformUserTextForMessageId: msgRef.messageId,
          modelOverride,
          markActive: false,
        });
        return;
      }

      await publishSingleMessagePrompt({
        adapter,
        bus,
        cfg,
        requestId: bufferedPromptRequestIdForActiveRequest(active.requestId),
        sessionId,
        sessionConfigId,
        msgRef,
        sessionMode,
        modelOverride,
        transformUserText: requestModelOverride
          ? (text: string) =>
              stripLeadingModelOverrideDirective({
                text,
                botNames: botMentionNames,
              })
          : undefined,
        raw: {
          bufferedForActiveRequestId: active.requestId,
        },
      });
      return;
    }

    // No active request.
    if (mentionsBot || replyToBot) {
      // Mention/reply is a bypass trigger.
      // Discard any pending buffer to avoid a second gated request for the same context.
      clearDebounceBuffer(sessionId);

      const triggerType: "mention" | "reply" = replyToBot ? "reply" : "mention";
      const requestId =
        triggerType === "reply" ? `discord:${sessionId}:${msgRef.messageId}` : randomRequestId();

      await publishActiveChannelPrompt({
        adapter,
        bus,
        cfg,
        requestId,
        sessionId,
        triggerMsgRef: msgRef,
        triggerType,
        sessionMode,
        sessionConfigId,
        modelOverride,
        transformTriggerUserText: requestModelOverride
          ? (text: string) =>
              stripLeadingModelOverrideDirective({
                text,
                botNames: botMentionNames,
              })
          : undefined,
        transformUserTextForMessageId: msgRef.messageId,
        markActive: true,
      });
      return;
    }

    bufferActiveChannelMessage({
      buffers,
      cfg,
      sessionId,
      sessionConfigId,
      parentChannelId,
      message: {
        msgRef,
        userId,
        text: userText,
        ts: messageTs,
        mentionsBot,
        replyToBot,
        botUserId,
        sessionModelOverride: modelOverride,
        requestModelOverride,
      },
    });
  }

  function bufferActiveChannelMessage(input: {
    buffers: Map<string, DebounceBuffer>;
    cfg: CoreConfig;
    sessionId: string;
    sessionConfigId: string;
    parentChannelId?: string;
    message: BufferedMessage;
  }) {
    const { buffers, cfg, sessionId, sessionConfigId, parentChannelId, message } = input;

    const existing = buffers.get(sessionId);
    if (!existing) {
      logger.debug("router debounce start", {
        sessionId,
        debounceMs: cfg.surface.router.activeDebounceMs,
      });

      const buffer: DebounceBuffer = {
        sessionId,
        sessionConfigId,
        parentChannelId,
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
    const gateEnabled = resolveSessionGateEnabled(cfg, b.sessionId, b.parentChannelId);
    const previousMessageText = gateEnabled
      ? await resolvePreviousBatchMessageText(b.messages)
      : undefined;

    const decision = gateEnabled
      ? await evaluateRouterGate({
          sessionId,
          botName: cfg.surface.discord.botName,
          messages: b.messages,
          context: {
            mode: "active-batch",
            previousMessageText,
          },
        }).catch((e: unknown) => {
          logger.error("router gate failed; skipping", { sessionId }, e);
          return { forward: false, reason: "error" };
        })
      : ({ forward: true as const, reason: "disabled" } satisfies {
          forward: boolean;
          reason?: string;
        });

    if (!decision.forward) {
      logger.info("router.route.decision", {
        sessionId,
        mode: "active",
        gateEnabled,
        decision: "skip",
        reason: `active_batch_gate:${decision.reason ?? "skip"}`,
        messageCount: b.messages.length,
      });
      return;
    }

    logger.info("router.route.decision", {
      sessionId,
      mode: "active",
      gateEnabled,
      decision: "forward",
      reason: `active_batch_gate:${decision.reason ?? "forward"}`,
      messageCount: b.messages.length,
    });

    const overrideCarrier = (() => {
      for (let i = b.messages.length - 1; i >= 0; i--) {
        const requestOverride = b.messages[i]?.requestModelOverride;
        if (requestOverride) {
          const messageId = b.messages[i]?.msgRef.messageId;
          if (messageId) {
            return {
              model: requestOverride,
              messageId,
              botUserId: b.messages[i]?.botUserId,
            };
          }
          return {
            model: requestOverride,
            messageId: undefined,
            botUserId: b.messages[i]?.botUserId,
          };
        }
      }
      return undefined;
    })();
    const modelOverride =
      overrideCarrier?.model ?? b.messages[b.messages.length - 1]?.sessionModelOverride;

    // Gate-forwarded prompt: do NOT reply-to a message.
    // Use newest message as the context anchor.
    await publishActiveChannelPrompt({
      adapter,
      bus,
      cfg,
      requestId: randomRequestId(),
      sessionId,
      sessionConfigId: b.sessionConfigId,
      // Use newest message as the context anchor (not a reply trigger).
      triggerMsgRef: b.messages[b.messages.length - 1]?.msgRef,
      triggerType: undefined,
      sessionMode: "active",
      modelOverride,
      transformTriggerUserText: overrideCarrier
        ? (text: string) =>
            stripLeadingModelOverrideDirective({
              text,
              botNames: resolveBotMentionNames({ cfg, botUserId: overrideCarrier?.botUserId }),
            })
        : undefined,
      transformUserTextForMessageId: overrideCarrier?.messageId,
      markActive: true,
    });
  }

  async function handleMentionMode(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    activeBySession: Map<string, ActiveSessionState>;
    sessionId: string;
    msgRef: MsgRef;
    userId: string;
    userText: string;
    mentionsBot?: boolean;
    replyToBot?: boolean;
    replyToMessageId?: string;
    active: ActiveSessionState | undefined;
    sessionMode: SessionMode;
    sessionConfigId: string;
    modelOverride?: string;
    requestModelOverride?: string;
    botMentionNames: readonly string[];
  }) {
    const {
      adapter,
      bus,
      cfg,
      activeBySession,
      sessionId,
      msgRef,
      userId,
      userText,
      mentionsBot,
      replyToBot,
      active,
      requestModelOverride,
      botMentionNames,
    } = input;

    const triggerType = replyToBot ? "reply" : mentionsBot ? "mention" : null;

    if (!triggerType) {
      // Mention-only channels: ignore non-triggers (even if a request is active).
      logger.debug("router.route.decision", {
        sessionId,
        mode: input.sessionMode,
        gateEnabled: false,
        decision: "skip",
        reason: "mention_mode_non_trigger",
        activeRequestId: active?.requestId,
      });
      return;
    }

    const requestId = `discord:${sessionId}:${msgRef.messageId}`;

    // Special case: if the user is replying to the currently active output message chain,
    // treat mention replies as steer/interrupt into the running request, and
    // queue plain replies into a deferred prompt batch.
    if (
      active &&
      replyToBot &&
      typeof input.replyToMessageId === "string" &&
      active.activeOutputMessageIds.has(input.replyToMessageId)
    ) {
      if (mentionsBot) {
        const steerMode = parseSteerDirectiveMode({
          text: userText,
          botNames: botMentionNames,
        });

        await publishSurfaceOutputReanchor({
          bus,
          requestId: active.requestId,
          sessionId,
          inheritReplyTo: false,
          replyTo: msgRef,
          mode: steerMode,
        });
        active.activeOutputMessageIds.clear();

        await publishSingleMessageToActiveRequest({
          adapter,
          bus,
          cfg,
          requestId: active.requestId,
          sessionId,
          queue: steerMode,
          msgRef,
          sessionMode: input.sessionMode,
          sessionConfigId: input.sessionConfigId,
          transformUserText: requestModelOverride
            ? (text: string) =>
                stripLeadingModelOverrideDirective({
                  text,
                  botNames: botMentionNames,
                })
            : steerMode === "interrupt"
              ? (text) =>
                  stripLeadingInterruptDirective({
                    text,
                    botNames: botMentionNames,
                  })
              : undefined,
        });

        await flushPendingMentionReplyBatchAsFollowUp({
          sessionId,
          sourceRequestId: active.requestId,
        });
      } else {
        enqueuePendingMentionReplyBatch({
          sessionId,
          sourceRequestId: active.requestId,
          sessionConfigId: input.sessionConfigId,
          sessionMode: input.sessionMode,
          modelOverride: input.modelOverride,
          item: {
            msgRef,
            requestModelOverride,
            botMentionNames,
          },
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
      sessionConfigId: input.sessionConfigId,
      modelOverride: input.modelOverride,
      transformTriggerUserText: input.requestModelOverride
        ? (text: string) =>
            stripLeadingModelOverrideDirective({
              text,
              botNames: botMentionNames,
            })
        : undefined,
      transformUserTextForMessageId: msgRef.messageId,
    });
  }

  async function publishBusRequest(input: PublishBusRequestInput) {
    await publishBusRequestImpl({ logger, bus, input });
  }

  type PublishComposedLocalInput = Parameters<typeof publishComposedRequestImpl>[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishComposedRequest(input: PublishComposedLocalInput) {
    const { adapter, bus, cfg, ...requestInput } = input;
    await publishComposedRequestImpl({
      adapter,
      bus,
      cfg,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });
  }

  type PublishActiveChannelPromptLocalInput = Parameters<
    typeof publishActiveChannelPromptImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    markActive: boolean;
  };

  async function publishActiveChannelPrompt(input: PublishActiveChannelPromptLocalInput) {
    const { adapter, bus, cfg, markActive, ...requestInput } = input;
    await publishActiveChannelPromptImpl({
      adapter,
      bus,
      cfg,
      transcriptStore: params.transcriptStore,
      logger,
      input: requestInput,
    });

    if (markActive) {
      activeBySession.set(input.sessionId, {
        requestId: input.requestId,
        activeOutputMessageIds: new Set(),
      });
    }
  }

  type PublishSingleMessageToActiveRequestLocalInput = Parameters<
    typeof publishSingleMessageToActiveRequestImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishSingleMessageToActiveRequest(
    input: PublishSingleMessageToActiveRequestLocalInput,
  ) {
    const { adapter, bus, cfg, ...requestInput } = input;
    await publishSingleMessageToActiveRequestImpl({
      adapter,
      bus,
      cfg,
      logger,
      input: requestInput,
    });
  }

  type PublishSingleMessagePromptLocalInput = Parameters<
    typeof publishSingleMessagePromptImpl
  >[0]["input"] & {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
  };

  async function publishSingleMessagePrompt(input: PublishSingleMessagePromptLocalInput) {
    const { adapter, bus, cfg, ...requestInput } = input;
    await publishSingleMessagePromptImpl({
      adapter,
      bus,
      cfg,
      logger,
      input: requestInput,
    });
  }

  async function publishSurfaceOutputReanchor(
    input: Parameters<typeof publishSurfaceOutputReanchorImpl>[0],
  ) {
    await publishSurfaceOutputReanchorImpl(input);
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
      pendingMentionReplyBatchBySession.clear();
    },
  };
}
