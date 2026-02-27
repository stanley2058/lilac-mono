import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";
import type { CoreConfig } from "@stanley2058/lilac-utils";

import type { MsgRef } from "../../types";

export type SessionMode = "mention" | "active";

export function previewText(text: string, max = 200): string {
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

export function resolveBotMentionNames(input: { cfg: CoreConfig; botUserId?: string }): string[] {
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

export function compareMessagePosition(
  a: { ts: number; messageId: string },
  b: { ts: number; messageId: string },
): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.messageId.localeCompare(b.messageId);
}

export function normalizeGateText(text: string | undefined, max = 280): string | undefined {
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

export function parseLeadingModelOverride(input: {
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

export function stripLeadingModelOverrideDirective(input: {
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

export function parseSteerDirectiveMode(input: {
  text: string;
  botNames: readonly string[];
}): "steer" | "interrupt" {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!stripped.hadLeadingMention) return "steer";
  return LEADING_INTERRUPT_COMMAND_RE.test(stripped.text) ? "interrupt" : "steer";
}

export function stripLeadingInterruptDirective(input: {
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

export function shouldRunDirectReplyMentionGate(input: {
  replyToBot: boolean;
  mentionsBot: boolean;
  text: string;
  botNames: readonly string[];
}): boolean {
  if (!input.replyToBot) return false;
  if (input.mentionsBot) return false;
  return hasNonSelfMentionToken({ text: input.text, botNames: input.botNames });
}

export function consumerId(prefix: string): string {
  return `${prefix}:${process.pid}:${Math.random().toString(16).slice(2)}`;
}

export function randomRequestId(): string {
  // Use a stable prefix to make it easy to spot in logs.
  return `req:${crypto.randomUUID()}`;
}

export function bufferedPromptRequestIdForActiveRequest(activeRequestId: string): string {
  return `queued:${activeRequestId}`;
}

export function parseDiscordMsgRefFromAdapterEvent(data: {
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

export function resolveSessionConfigId(input: {
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

export function getSessionMode(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
): SessionMode {
  const threadMode = cfg.surface.router.sessionModes[sessionId]?.mode;
  if (threadMode) return threadMode;

  const parentId = parentChannelId?.trim();
  if (parentId) {
    const parentMode = cfg.surface.router.sessionModes[parentId]?.mode;
    if (parentMode) return parentMode;
  }

  return cfg.surface.router.defaultMode;
}

export function resolveSessionGateEnabled(
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

export function resolveSessionModelOverride(
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

export function buildDiscordUserAliasById(cfg: CoreConfig): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    if (!out.has(rec.discord)) {
      out.set(rec.discord, alias);
    }
  }

  return out;
}

export function getDiscordFlags(raw: unknown): {
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

export type RouterConfigOverride = Omit<CoreConfig, "tools"> & {
  tools?: CoreConfig["tools"];
};

export function withDefaultToolsConfig(config: RouterConfigOverride): CoreConfig {
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

export type RouterAdapterMessage = EvtAdapterMessageCreatedData;
