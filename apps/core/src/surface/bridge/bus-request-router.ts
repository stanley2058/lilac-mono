import { generateText, Output, type ModelMessage } from "ai";
import { z } from "zod";

import {
  createLogger,
  getCoreConfig,
  env,
  resolveModelSlot,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import {
  lilacEventTypes,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
  type RequestQueueMode,
} from "@stanley2058/lilac-event-bus";
import type { SurfaceAdapter } from "../adapter";
import type { MsgRef, SurfaceMessage } from "../types";
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

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sanitizeUserToken(name: string): string {
  return name.replace(/\s+/gu, "_").replace(/^@+/u, "");
}

const USER_MENTION_TOKEN_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/gu;

function hasNonSelfMentionToken(input: { text: string; botNames: readonly string[] }): boolean {
  const selfNamesLc = new Set(
    input.botNames
      .map((name) => sanitizeUserToken(name).toLowerCase())
      .filter((name) => name.length > 0),
  );

  for (const m of input.text.matchAll(USER_MENTION_TOKEN_RE)) {
    const token = String(m[2] ?? "").trim();
    if (!token) continue;
    if (selfNamesLc.has(sanitizeUserToken(token).toLowerCase())) continue;
    return true;
  }

  return false;
}

function resolveBotMentionNames(input: { cfg: CoreConfig; botUserId?: string }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const addName = (raw: string | undefined) => {
    if (typeof raw !== "string") return;
    const sanitized = sanitizeUserToken(raw);
    if (!sanitized) return;
    const key = sanitized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(sanitized);
  };

  addName(input.cfg.surface.discord.botName);

  if (input.botUserId) {
    const users = input.cfg.entity?.users ?? {};
    for (const [alias, rec] of Object.entries(users)) {
      if (rec.discord !== input.botUserId) continue;
      addName(alias);
    }
  }

  return out;
}

function compareMessagePosition(
  a: { ts: number; messageId: string },
  b: { ts: number; messageId: string },
): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.messageId.localeCompare(b.messageId);
}

function normalizeGateText(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function stripLeadingBotMentionPrefix(
  text: string,
  botNames: readonly string[],
): {
  hadLeadingMention: boolean;
  mentionPrefix: string;
  text: string;
} {
  const sanitizedBotNames = botNames
    .map((name) => sanitizeUserToken(name))
    .filter((name) => name.length > 0);
  const nameAlternation =
    sanitizedBotNames.length > 0
      ? `|@(?:${sanitizedBotNames.map((name) => escapeRegExp(name)).join("|")})`
      : "";
  const mentionRe = new RegExp(`^\\s*(?:<@!?[^>]+>${nameAlternation})(?:[,:]\\s*|\\s+)`, "iu");
  const m = text.match(mentionRe);
  if (!m) return { hadLeadingMention: false, mentionPrefix: "", text };
  return {
    hadLeadingMention: true,
    mentionPrefix: m[0],
    text: text.slice(m[0].length),
  };
}

const LEADING_INTERRUPT_COMMAND_RE = /^\s*(?:[:,]\s*)?!(?:interrupt|int)\b(?:\s+|$)/iu;
const LEADING_MODEL_OVERRIDE_RE = /^\s*(?:[:,]\s*)?!m:([^\s]+)(?:\s+|$)/iu;

function parseLeadingModelOverride(input: {
  text: string;
  botNames: readonly string[];
}): string | undefined {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  const target = stripped.hadLeadingMention ? stripped.text : input.text;
  const m = target.match(LEADING_MODEL_OVERRIDE_RE);
  if (!m) return undefined;

  const model = String(m[1] ?? "").trim();
  return model.length > 0 ? model : undefined;
}

function stripLeadingModelOverrideDirective(input: {
  text: string;
  botNames: readonly string[];
}): string {
  const strippedMention = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!strippedMention.hadLeadingMention) {
    return input.text.replace(LEADING_MODEL_OVERRIDE_RE, "").replace(/^\s+/u, "");
  }

  if (!LEADING_MODEL_OVERRIDE_RE.test(strippedMention.text)) {
    return input.text;
  }

  const remainder = strippedMention.text
    .replace(LEADING_MODEL_OVERRIDE_RE, "")
    .replace(/^\s+/u, "");
  return `${strippedMention.mentionPrefix}${remainder}`;
}

function parseSteerDirectiveMode(input: {
  text: string;
  botNames: readonly string[];
}): "steer" | "interrupt" {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!stripped.hadLeadingMention) return "steer";
  return LEADING_INTERRUPT_COMMAND_RE.test(stripped.text) ? "interrupt" : "steer";
}

function stripLeadingInterruptDirective(input: {
  text: string;
  botNames: readonly string[];
}): string {
  const strippedMention = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!strippedMention.hadLeadingMention) {
    return input.text.replace(LEADING_INTERRUPT_COMMAND_RE, "").replace(/^\s+/u, "");
  }

  if (!LEADING_INTERRUPT_COMMAND_RE.test(strippedMention.text)) {
    return input.text;
  }

  const remainder = strippedMention.text
    .replace(LEADING_INTERRUPT_COMMAND_RE, "")
    .replace(/^\s+/u, "");
  return `${strippedMention.mentionPrefix}${remainder}`;
}

function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

function randomRequestId(): string {
  // Use a stable prefix to make it easy to spot in logs.
  return `req:${crypto.randomUUID()}`;
}

function bufferedPromptRequestIdForActiveRequest(activeRequestId: string): string {
  return `queued:${activeRequestId}`;
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

function resolveSessionConfigId(input: {
  cfg: CoreConfig;
  sessionId: string;
  parentChannelId?: string;
}): string {
  const entry = input.cfg.surface.router.sessionModes[input.sessionId];
  if (entry && Object.prototype.hasOwnProperty.call(entry, "additionalPrompts")) {
    return input.sessionId;
  }

  const parentChannelId = input.parentChannelId?.trim();
  if (!parentChannelId) return input.sessionId;

  const parentEntry = input.cfg.surface.router.sessionModes[parentChannelId];
  if (parentEntry && Object.prototype.hasOwnProperty.call(parentEntry, "additionalPrompts")) {
    return parentChannelId;
  }

  return input.sessionId;
}

function getSessionMode(cfg: CoreConfig, sessionId: string, parentChannelId?: string): SessionMode {
  const threadMode = cfg.surface.router.sessionModes[sessionId]?.mode;
  if (threadMode) return threadMode;

  const parentId = parentChannelId?.trim();
  if (parentId) {
    const parentMode = cfg.surface.router.sessionModes[parentId]?.mode;
    if (parentMode) return parentMode;
  }

  return cfg.surface.router.defaultMode;
}

function resolveSessionGateEnabled(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): boolean {
  const threadGate = cfg.surface.router.sessionModes[sessionId]?.gate;
  if (typeof threadGate === "boolean") return threadGate;

  const parentId = parentChannelId?.trim();
  const parentGate = parentId ? cfg.surface.router.sessionModes[parentId]?.gate : undefined;
  if (typeof parentGate === "boolean") return parentGate;

  return cfg.surface.router.activeGate.enabled;
}

function resolveSessionModelOverride(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): string | undefined {
  const threadModel = cfg.surface.router.sessionModes[sessionId]?.model;
  if (typeof threadModel === "string" && threadModel.trim().length > 0) {
    return threadModel.trim();
  }

  const parentId = parentChannelId?.trim();
  if (!parentId) return undefined;

  const parentModel = cfg.surface.router.sessionModes[parentId]?.model;
  if (typeof parentModel === "string" && parentModel.trim().length > 0) {
    return parentModel.trim();
  }

  return undefined;
}

function buildDiscordUserAliasById(cfg: CoreConfig): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    if (!out.has(rec.discord)) {
      out.set(rec.discord, alias);
    }
  }

  return out;
}

function getDiscordFlags(raw: unknown): {
  isDMBased?: boolean;
  mentionsBot?: boolean;
  replyToBot?: boolean;
  replyToMessageId?: string;
  parentChannelId?: string;
  sessionModelOverride?: string;
  botUserId?: string;
} {
  if (!raw || typeof raw !== "object") return {};
  const discord = (raw as { discord?: unknown }).discord;
  if (!discord || typeof discord !== "object") return {};

  const o = discord as Record<string, unknown>;

  return {
    isDMBased: typeof o.isDMBased === "boolean" ? o.isDMBased : undefined,
    mentionsBot: typeof o.mentionsBot === "boolean" ? o.mentionsBot : undefined,
    replyToBot: typeof o.replyToBot === "boolean" ? o.replyToBot : undefined,
    replyToMessageId: typeof o.replyToMessageId === "string" ? o.replyToMessageId : undefined,
    parentChannelId: typeof o.parentChannelId === "string" ? o.parentChannelId : undefined,
    sessionModelOverride:
      typeof o.sessionModelOverride === "string" ? o.sessionModelOverride : undefined,
    botUserId: typeof o.botUserId === "string" ? o.botUserId : undefined,
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
  ts: number;
  mentionsBot: boolean;
  replyToBot: boolean;
  botUserId?: string;
  sessionModelOverride?: string;
  requestModelOverride?: string;
};

type RouterGateContextMode = "active-batch" | "direct-reply-mention-disambiguation";

type RouterGateInput = {
  sessionId: string;
  botName: string;
  messages: BufferedMessage[];
  context?: {
    mode: RouterGateContextMode;
    triggerMessageText?: string;
    previousMessageText?: string;
    repliedToMessageText?: string;
  };
};

type RouterGateDecision = {
  forward: boolean;
  reason?: string;
};

type DebounceBuffer = {
  sessionId: string;
  sessionConfigId: string;
  parentChannelId?: string;
  messages: BufferedMessage[];
  timer: ReturnType<typeof setTimeout> | null;
};

type PendingMentionReplyBatchItem = {
  msgRef: MsgRef;
  requestModelOverride?: string;
  botMentionNames: readonly string[];
};

type PendingMentionReplyBatch = {
  sourceRequestId: string;
  sessionConfigId: string;
  sessionMode: SessionMode;
  modelOverride?: string;
  items: PendingMentionReplyBatchItem[];
};

type RouterConfigOverride = Omit<CoreConfig, "tools"> & {
  tools?: CoreConfig["tools"];
};

function withDefaultToolsConfig(config: RouterConfigOverride): CoreConfig {
  return {
    ...config,
    tools: config.tools ?? {
      web: {
        search: {
          provider: "tavily",
        },
      },
    },
  };
}

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

  async function resolvePreviousMessageText(input: {
    msgRef: MsgRef;
    triggerTs: number;
  }): Promise<string | undefined> {
    const around = await adapter.getReplyContext(input.msgRef, { limit: 8 }).catch(() => []);
    if (around.length === 0) return undefined;

    let prev: SurfaceMessage | null = null;
    for (const candidate of around) {
      const cmp = compareMessagePosition(
        { ts: candidate.ts, messageId: candidate.ref.messageId },
        { ts: input.triggerTs, messageId: input.msgRef.messageId },
      );
      if (cmp >= 0) continue;
      if (
        !prev ||
        compareMessagePosition(
          { ts: prev.ts, messageId: prev.ref.messageId },
          { ts: candidate.ts, messageId: candidate.ref.messageId },
        ) < 0
      ) {
        prev = candidate;
      }
    }

    return normalizeGateText(prev?.text);
  }

  async function resolveRepliedToMessageText(input: {
    sessionId: string;
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    if (!input.replyToMessageId) return undefined;

    const repliedTo = await adapter
      .readMsg({
        platform: "discord",
        channelId: input.sessionId,
        messageId: input.replyToMessageId,
      })
      .catch(() => null);

    return normalizeGateText(repliedTo?.text ?? undefined);
  }

  async function resolvePreviousBatchMessageText(
    messages: readonly BufferedMessage[],
  ): Promise<string | undefined> {
    if (messages.length === 0) return undefined;

    const oldest = messages.reduce((best, cur) => {
      return compareMessagePosition(
        { ts: cur.ts, messageId: cur.msgRef.messageId },
        { ts: best.ts, messageId: best.msgRef.messageId },
      ) < 0
        ? cur
        : best;
    });

    return resolvePreviousMessageText({
      msgRef: oldest.msgRef,
      triggerTs: oldest.ts,
    });
  }

  function shouldRunDirectReplyMentionGate(input: {
    replyToBot: boolean;
    mentionsBot: boolean;
    text: string;
    botNames: readonly string[];
  }): boolean {
    if (!input.replyToBot) return false;
    if (input.mentionsBot) return false;
    return hasNonSelfMentionToken({ text: input.text, botNames: input.botNames });
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
        const gate = params.routerGate ?? shouldForwardByGate;
        const [previousMessageText, repliedToMessageText] = await Promise.all([
          resolvePreviousMessageText({ msgRef, triggerTs: msg.data.ts }),
          resolveRepliedToMessageText({
            sessionId,
            replyToMessageId: flags.replyToMessageId,
          }),
        ]);

        const decision = await gate({
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
    const existing = pendingMentionReplyBatchBySession.get(input.sessionId);

    if (!existing || existing.sourceRequestId !== input.sourceRequestId) {
      pendingMentionReplyBatchBySession.set(input.sessionId, {
        sourceRequestId: input.sourceRequestId,
        sessionConfigId: input.sessionConfigId,
        sessionMode: input.sessionMode,
        modelOverride: input.modelOverride,
        items: [
          {
            msgRef: input.item.msgRef,
            requestModelOverride: input.item.requestModelOverride,
            botMentionNames: [...input.item.botMentionNames],
          },
        ],
      });
      return;
    }

    const alreadyTracked = existing.items.some(
      (item) => item.msgRef.messageId === input.item.msgRef.messageId,
    );
    if (!alreadyTracked) {
      existing.items.push({
        msgRef: input.item.msgRef,
        requestModelOverride: input.item.requestModelOverride,
        botMentionNames: [...input.item.botMentionNames],
      });
    }

    if (input.modelOverride) {
      existing.modelOverride = input.modelOverride;
    }
    existing.sessionConfigId = input.sessionConfigId;
    existing.sessionMode = input.sessionMode;
  }

  function takePendingMentionReplyBatch(input: {
    sessionId: string;
    sourceRequestId: string;
  }): PendingMentionReplyBatch | null {
    const batch = pendingMentionReplyBatchBySession.get(input.sessionId);
    if (!batch) return null;
    if (batch.sourceRequestId !== input.sourceRequestId) return null;

    pendingMentionReplyBatchBySession.delete(input.sessionId);
    return batch;
  }

  function transformPendingUserText(
    item: PendingMentionReplyBatchItem,
  ): ((text: string) => string) | undefined {
    if (!item.requestModelOverride) return undefined;
    return (text: string) =>
      stripLeadingModelOverrideDirective({
        text,
        botNames: item.botMentionNames,
      });
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
    const gate = params.routerGate ?? shouldForwardByGate;
    const previousMessageText = gateEnabled
      ? await resolvePreviousBatchMessageText(b.messages)
      : undefined;

    const decision = gateEnabled
      ? await gate({
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

  const gateSchema = z.object({
    forward: z.boolean(),
    reason: z.string().optional(),
  });

  async function shouldForwardByGate(input: RouterGateInput): Promise<RouterGateDecision> {
    const gateCfg = cfg.surface.router.activeGate;

    const timeoutMs = gateCfg.timeoutMs;
    const abort = new AbortController();

    const timeout = setTimeout(() => abort.abort(), timeoutMs);

    try {
      const resolved = resolveModelSlot(cfg, "fast");

      const prompt = (() => {
        if (input.context?.mode === "direct-reply-mention-disambiguation") {
          const triggerMessageText = input.context.triggerMessageText ?? "";
          const previousMessageText = input.context.previousMessageText ?? "";
          const repliedToMessageText = input.context.repliedToMessageText ?? "";

          return [
            {
              role: "system",
              content: [
                "You are a router gate for a chat bot.",
                "Decide whether THIS bot should reply to this direct-reply message.",
                "The user replied to this bot, did not mention this bot explicitly, and included another @mention.",
                'Return strict JSON only: {"forward": true|false, "reason"?: string}',
                "Use context to distinguish address vs reference mentions.",
                "If uncertain, return forward=true.",
              ].join("\n"),
            },
            {
              role: "user",
              content: [
                `sessionId=${input.sessionId}`,
                `botName=${input.botName}`,
                "",
                `triggerMessage=${triggerMessageText || "(none)"}`,
                `repliedToMessage=${repliedToMessageText || "(none)"}`,
                `previousMessage=${previousMessageText || "(none)"}`,
                "",
                "forward=true when the message still seeks this bot's input (even if another bot is referenced).",
                "forward=false only when it is clearly addressed to someone else.",
              ].join("\n"),
            },
          ] satisfies ModelMessage[];
        }

        const indirectMention = input.messages.some((m) =>
          m.text.toLowerCase().includes(input.botName.toLowerCase()),
        );

        const transcript = input.messages.map((m) => `[user_id=${m.userId}] ${m.text}`).join("\n");

        return [
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
              `previousMessage=${input.context?.previousMessageText ?? "(none)"}`,
              "",
              "Batch:",
              transcript,
              "",
              "Special case: if this looks like a heartbeat poll that expects a reply (e.g. mentions HEARTBEAT.md/HEARTBEAT_OK), forward=true.",
            ].join("\n"),
          },
        ] satisfies ModelMessage[];
      })();

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
      const failOpen = input.context?.mode === "direct-reply-mention-disambiguation";
      logger.error(
        "router gate error",
        {
          sessionId: input.sessionId,
          mode: input.context?.mode ?? "active-batch",
          failOpen,
        },
        e,
      );
      return {
        forward: failOpen,
        reason: failOpen ? "error-fail-open" : "error",
      };
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

  async function publishBusRequest(input: {
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    queue: RequestQueueMode;
    triggerType: "mention" | "reply" | "active";
    sessionMode: SessionMode;
    modelOverride?: string;
    messages: ModelMessage[];
    raw: unknown;
  }) {
    logger.debug("cmd.request.message publish", {
      requestId: input.requestId,
      sessionId: input.sessionId,
      queue: input.queue,
      triggerType: input.triggerType,
      modelOverride: input.modelOverride,
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
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
        raw: {
          ...(input.raw && typeof input.raw === "object"
            ? (input.raw as Record<string, unknown>)
            : {}),
          sessionMode: input.sessionMode,
          sessionConfigId: input.sessionConfigId,
          ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
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
    sessionConfigId: string;
    queue: RequestQueueMode;
    triggerType: "mention" | "reply" | "active";
    msgRef: MsgRef;
    userId: string;
    sessionMode: SessionMode;
    modelOverride?: string;
    transformTriggerUserText?: (text: string) => string;
    transformUserTextForMessageId?: string;
  }) {
    const { adapter, cfg, requestId, sessionId, queue, triggerType, msgRef } = input;

    const self = await adapter.getSelf();
    const discordUserAliasById = buildDiscordUserAliasById(cfg);

    const composed = await composeRequestMessages(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      transcriptStore: params.transcriptStore,
      discordUserAliasById,
      transformUserText: input.transformTriggerUserText,
      transformUserTextForMessageId: input.transformUserTextForMessageId,
      trigger: {
        type: triggerType === "mention" ? "mention" : "reply",
        msgRef,
      },
    });

    await publishBusRequest({
      requestId,
      sessionId,
      sessionConfigId: input.sessionConfigId,
      queue,
      triggerType,
      sessionMode: input.sessionMode,
      modelOverride: input.modelOverride,
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
    sessionConfigId: string;
    triggerMsgRef: MsgRef | undefined;
    triggerType: "mention" | "reply" | undefined;
    sessionMode: SessionMode;
    modelOverride?: string;
    transformTriggerUserText?: (text: string) => string;
    transformUserTextForMessageId?: string;
    /** When true, update router's active session state immediately. */
    markActive: boolean;
  }) {
    const { adapter, cfg, requestId, sessionId, triggerMsgRef, triggerType } = input;

    const self = await adapter.getSelf();
    const discordUserAliasById = buildDiscordUserAliasById(cfg);

    const composed =
      triggerMsgRef && triggerType === "reply"
        ? await composeRequestMessages(adapter, {
            platform: "discord",
            botUserId: self.userId,
            botName: cfg.surface.discord.botName,
            transcriptStore: params.transcriptStore,
            discordUserAliasById,
            transformUserText: input.transformTriggerUserText,
            transformUserTextForMessageId: input.transformUserTextForMessageId,
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
            discordUserAliasById,
            transformUserText: input.transformTriggerUserText,
            transformUserTextForMessageId: input.transformUserTextForMessageId,
            triggerMsgRef,
            triggerType,
          });

    await publishBusRequest({
      requestId,
      sessionId,
      sessionConfigId: input.sessionConfigId,
      queue: "prompt",
      triggerType: triggerType ?? "active",
      sessionMode: input.sessionMode,
      modelOverride: input.modelOverride,
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
    sessionConfigId: string;
    queue: "followUp" | "steer" | "interrupt";
    msgRef: MsgRef;
    sessionMode: SessionMode;
    transformUserText?: (text: string) => string;
  }) {
    const { adapter, cfg, requestId, sessionId, queue, msgRef } = input;

    const self = await adapter.getSelf();
    const discordUserAliasById = buildDiscordUserAliasById(cfg);

    const msg = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      msgRef,
      discordUserAliasById,
      transformUserText: input.transformUserText,
    });

    if (!msg) return;

    await publishBusRequest({
      requestId,
      sessionId,
      sessionConfigId: input.sessionConfigId,
      queue,
      triggerType: "active",
      sessionMode: input.sessionMode,
      messages: [msg],
      raw: {
        triggerType: "active",
      },
    });
  }

  async function publishSingleMessagePrompt(input: {
    adapter: SurfaceAdapter;
    bus: LilacBus;
    cfg: CoreConfig;
    requestId: string;
    sessionId: string;
    sessionConfigId: string;
    msgRef: MsgRef;
    sessionMode: SessionMode;
    modelOverride?: string;
    transformUserText?: (text: string) => string;
    raw?: Record<string, unknown>;
  }) {
    const { adapter, cfg, requestId, sessionId, msgRef } = input;

    const self = await adapter.getSelf();
    const discordUserAliasById = buildDiscordUserAliasById(cfg);

    const msg = await composeSingleMessage(adapter, {
      platform: "discord",
      botUserId: self.userId,
      botName: cfg.surface.discord.botName,
      msgRef,
      discordUserAliasById,
      transformUserText: input.transformUserText,
    });

    if (!msg) return;

    await publishBusRequest({
      requestId,
      sessionId,
      sessionConfigId: input.sessionConfigId,
      queue: "prompt",
      triggerType: "active",
      sessionMode: input.sessionMode,
      modelOverride: input.modelOverride,
      messages: [msg],
      raw: {
        triggerType: "active",
        chainMessageIds: [msgRef.messageId],
        ...input.raw,
      },
    });
  }

  async function publishSurfaceOutputReanchor(input: {
    bus: LilacBus;
    requestId: string;
    sessionId: string;
    inheritReplyTo: boolean;
    replyTo?: MsgRef;
    mode?: "steer" | "interrupt";
  }) {
    const { bus, requestId, sessionId, inheritReplyTo, replyTo, mode } = input;

    await bus.publish(
      lilacEventTypes.CmdSurfaceOutputReanchor,
      {
        inheritReplyTo,
        mode,
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
      pendingMentionReplyBatchBySession.clear();
    },
  };
}
