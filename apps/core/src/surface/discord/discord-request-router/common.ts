import { captureError } from "../../../shared/error-capture";
import type { EvtAdapterMessageCreatedData } from "@stanley2058/lilac-event-bus";
import {
  getDiscordUserAliasValue,
  isPanic,
  isRecord,
  parseCoreConfigResult,
  resolveRouterSessionConfig,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Result } from "better-result";
import { z } from "zod";

import type { MsgRefFor } from "../../runtime-descriptor";
import { formatGenericRequestId, formatQueuedRequestId } from "../../bridge/request-ids";

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
      const resolved = getDiscordUserAliasValue(rec);
      if (!resolved || resolved.discordId !== input.botUserId) continue;
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
const LEADING_MODEL_OVERRIDE_RE = /^\s*(?:[:,]\s*)?!(?:m|model):([^\s]+)(?:\s+|$)/iu;
const DEFAULT_CONTINUE_DIRECTIVE_COUNT = 8;
const LEADING_CONTINUE_DIRECTIVE_RE = /^\s*(?:[:,]\s*)?!(?:continue|cont)(?:=(\d+))?(?:\s+|$)/iu;

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

export function parseLeadingContinueDirective(input: {
  text: string;
  botNames: readonly string[];
}): number | undefined {
  const stripped = stripLeadingBotMentionPrefix(input.text, input.botNames);
  const target = stripped.hadLeadingMention ? stripped.text : input.text;
  const m = target.match(LEADING_CONTINUE_DIRECTIVE_RE);
  if (!m) return undefined;

  if (m[1] === undefined) return DEFAULT_CONTINUE_DIRECTIVE_COUNT;

  const rawCount = Number.parseInt(String(m[1]).trim(), 10);
  if (!Number.isFinite(rawCount) || rawCount < 1) return undefined;
  return Math.min(200, rawCount);
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

export function stripLeadingContinueDirective(input: {
  text: string;
  botNames: readonly string[];
}): string {
  const strippedMention = stripLeadingBotMentionPrefix(input.text, input.botNames);
  if (!strippedMention.hadLeadingMention) {
    return input.text.replace(LEADING_CONTINUE_DIRECTIVE_RE, "").replace(/^\s+/u, "");
  }

  if (!LEADING_CONTINUE_DIRECTIVE_RE.test(strippedMention.text)) {
    return input.text;
  }

  const remainder = strippedMention.text
    .replace(LEADING_CONTINUE_DIRECTIVE_RE, "")
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

export function randomRequestId(): string {
  return formatGenericRequestId();
}

export function bufferedPromptRequestIdForActiveRequest(activeRequestId: string): string {
  return formatQueuedRequestId(activeRequestId);
}

export function parseDiscordMsgRefFromAdapterEvent(data: {
  channelId: string;
  messageId: string;
}): MsgRefFor<"discord"> {
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
  guildId?: string;
}): string {
  for (const candidate of [input.sessionId, input.parentChannelId, input.guildId]) {
    const configId = candidate?.trim();
    if (!configId) continue;

    const entry = input.cfg.surface.router.sessionModes[configId];
    if (entry && Object.prototype.hasOwnProperty.call(entry, "additionalPrompts")) {
      return configId;
    }
  }

  return input.sessionId;
}

export function getSessionMode(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
  guildId?: string,
): SessionMode {
  return (
    resolveRouterSessionConfig(cfg, { sessionId, parentChannelId, guildId }).mode ??
    cfg.surface.router.defaultMode
  );
}

export function resolveSessionGateEnabled(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
  guildId?: string,
): boolean {
  return (
    resolveRouterSessionConfig(cfg, { sessionId, parentChannelId, guildId }).gate ??
    cfg.surface.router.activeGate.enabled
  );
}

export function resolveSessionModelOverride(
  cfg: CoreConfig,
  sessionId: string,
  parentChannelId?: string,
  guildId?: string,
): string | undefined {
  return resolveRouterSessionConfig(cfg, { sessionId, parentChannelId, guildId }).model;
}

export function buildDiscordUserAliasById(cfg: CoreConfig): Map<string, string> {
  const out = new Map<string, string>();
  const users = cfg.entity?.users ?? {};

  for (const [alias, rec] of Object.entries(users)) {
    const resolved = getDiscordUserAliasValue(rec);
    if (!resolved) continue;
    if (!out.has(resolved.discordId)) {
      out.set(resolved.discordId, alias);
    }
  }

  return out;
}

const discordFlagsSchema = z.strictObject({
  isDMBased: z.boolean().optional(),
  mentionsBot: z.boolean().optional(),
  replyToBot: z.boolean().optional(),
  replyToMessageId: z.string().optional(),
  parentChannelId: z.string().optional(),
  guildId: z.string().optional(),
  sessionModelOverride: z.string().optional(),
  botUserId: z.string().optional(),
});

export type DiscordFlags = z.output<typeof discordFlagsSchema>;

export function getDiscordFlags(raw: unknown): DiscordFlags {
  const captured = Result.try({
    try: (): DiscordFlags => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};

      const discordDescriptor = Object.getOwnPropertyDescriptor(raw, "discord");
      if (!discordDescriptor || !("value" in discordDescriptor)) return {};

      const discord = discordDescriptor.value;
      if (discord === null || typeof discord !== "object" || Array.isArray(discord)) return {};

      const ownDataProperty = (key: keyof DiscordFlags): unknown => {
        const descriptor = Object.getOwnPropertyDescriptor(discord, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
      };
      const parsed = discordFlagsSchema.safeParse({
        isDMBased: ownDataProperty("isDMBased"),
        mentionsBot: ownDataProperty("mentionsBot"),
        replyToBot: ownDataProperty("replyToBot"),
        replyToMessageId: ownDataProperty("replyToMessageId"),
        parentChannelId: ownDataProperty("parentChannelId"),
        guildId: ownDataProperty("guildId"),
        sessionModelOverride: ownDataProperty("sessionModelOverride"),
        botUserId: ownDataProperty("botUserId"),
      });
      return parsed.success ? parsed.data : {};
    },
    catch: captureError,
  }).match<
    | { readonly kind: "success"; readonly flags: DiscordFlags }
    | { readonly kind: "failure"; readonly failure: { readonly cause: unknown } }
  >({
    ok: (flags) => ({ kind: "success", flags }),
    err: (failure) => ({ kind: "failure", failure }),
  });
  if (captured.kind === "success") return captured.flags;
  const cause = captured.failure.cause;
  if (isPanic(cause)) throw cause;
  return {};
}

export type RouterConfigOverride = Record<string, unknown>;

export function withDefaultToolsConfig(
  config: RouterConfigOverride,
): ReturnType<typeof parseCoreConfigResult> {
  const parsedResult = parseCoreConfigResult(config);
  const agent = isRecord(config.agent) ? config.agent : {};
  const systemPrompt = typeof agent.systemPrompt === "string" ? agent.systemPrompt : "";

  return parsedResult.map((parsed) => ({
    ...parsed,
    agent: {
      ...parsed.agent,
      systemPrompt,
    },
  }));
}

export type RouterAdapterMessage = EvtAdapterMessageCreatedData;
