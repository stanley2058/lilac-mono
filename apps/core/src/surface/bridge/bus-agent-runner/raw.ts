import { z } from "zod";

const SUBAGENT_PROFILES = ["explore", "general", "self"] as const;
const SESSION_MODES = ["mention", "active"] as const;
const CUSTOM_COMMAND_SOURCES = ["text", "discord-slash"] as const;

export type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];
export type AgentRunProfile = "primary" | SubagentProfile;

export type ParsedSubagentMeta = {
  profile: AgentRunProfile;
  depth: number;
};

const nonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));
const optionalNonEmptyStringSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length > 0 ? value : undefined),
  nonEmptyStringSchema.optional(),
);
const sessionModeSchema = z.preprocess(
  (value) => (value === "mention" || value === "active" ? value : undefined),
  z.enum(SESSION_MODES).optional(),
);
const stringArraySchema = z.preprocess(
  (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []),
  z.array(z.string()),
);
const booleanTrueSchema = z.preprocess((value) => value === true, z.boolean());
const optionalStringSchema = z.preprocess(
  (value) => (typeof value === "string" ? value : undefined),
  z.string().optional(),
);
const subagentProfileSchema = z.preprocess(
  (value) => (isSubagentProfile(value) ? value : undefined),
  z.enum(SUBAGENT_PROFILES).optional(),
);
const optionalFiniteNumberSchema = z.preprocess(
  (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined),
  z.number().optional(),
);

const routerRawSchema = z
  .object({
    sessionMode: sessionModeSchema,
    sessionConfigId: optionalNonEmptyStringSchema,
    parentChannelId: optionalNonEmptyStringSchema,
    modelOverride: optionalNonEmptyStringSchema,
    bufferedForActiveRequestId: optionalNonEmptyStringSchema,
    chainMessageIds: stringArraySchema,
    participantUserIds: stringArraySchema,
  })
  .passthrough();

const requestControlRawSchema = z
  .object({
    requiresActive: booleanTrueSchema,
    cancel: booleanTrueSchema,
    cancelQueued: booleanTrueSchema,
    messageId: optionalStringSchema,
  })
  .passthrough();

const subagentRawSchema = z
  .object({
    subagent: z
      .object({
        profile: subagentProfileSchema,
        depth: optionalFiniteNumberSchema,
      })
      .optional(),
  })
  .passthrough();

const customCommandRawSchema = z
  .object({
    customCommand: z
      .object({
        name: z.string(),
        args: z.array(z.unknown()).optional(),
        prompt: z.string().optional(),
        text: z.string(),
        source: z.enum(CUSTOM_COMMAND_SOURCES),
        error: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

function parseRouterRaw(raw: unknown): z.infer<typeof routerRawSchema> | null {
  const parsed = routerRawSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseRouterSessionModeFromRaw(raw: unknown): "mention" | "active" | null {
  return parseRouterRaw(raw)?.sessionMode ?? null;
}

export function parseSessionConfigIdFromRaw(raw: unknown): string | null {
  return parseRouterRaw(raw)?.sessionConfigId ?? null;
}

export function parseParentChannelIdFromRaw(raw: unknown): string | null {
  return parseRouterRaw(raw)?.parentChannelId ?? null;
}

export function parseRequestModelOverrideFromRaw(raw: unknown): string | null {
  return parseRouterRaw(raw)?.modelOverride ?? null;
}

export type RequestControl = {
  requiresActive: boolean;
  cancel: boolean;
  cancelQueued: boolean;
  targetMessageId: string | null;
};

export function parseRequestControlFromRaw(raw: unknown): RequestControl {
  const parsed = requestControlRawSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      requiresActive: false,
      cancel: false,
      cancelQueued: false,
      targetMessageId: null,
    };
  }

  const record = parsed.data;
  return {
    requiresActive: record.requiresActive === true,
    cancel: record.cancel === true,
    cancelQueued: record.cancelQueued === true,
    targetMessageId: record.messageId ?? null,
  };
}

export function parseBufferedForActiveRequestIdFromRaw(raw: unknown): string | null {
  return parseRouterRaw(raw)?.bufferedForActiveRequestId ?? null;
}

export function getChainMessageIdsFromRaw(raw: unknown): readonly string[] {
  return parseRouterRaw(raw)?.chainMessageIds ?? [];
}

export function getParticipantUserIdsFromRaw(raw: unknown): readonly string[] {
  const value = parseRouterRaw(raw)?.participantUserIds;
  if (!value) return [];
  return [...new Set(value.map((id) => id.trim()).filter((id) => id.length > 0))];
}

export function requestRawReferencesMessage(raw: unknown, messageId: string): boolean {
  return getChainMessageIdsFromRaw(raw).includes(messageId);
}

function isSubagentProfile(value: unknown): value is SubagentProfile {
  return typeof value === "string" && (SUBAGENT_PROFILES as readonly string[]).includes(value);
}

export function parseSubagentMetaFromRaw(raw: unknown): ParsedSubagentMeta {
  const parsed = subagentRawSchema.safeParse(raw);
  const subagent = parsed.success ? parsed.data.subagent : undefined;
  if (!subagent) {
    return { profile: "primary", depth: 0 };
  }

  const profile: AgentRunProfile = isSubagentProfile(subagent.profile)
    ? subagent.profile
    : "primary";

  const defaultDepth = profile === "primary" ? 0 : 1;
  const depth =
    typeof subagent.depth === "number" ? Math.max(0, Math.trunc(subagent.depth)) : defaultDepth;

  return { profile, depth };
}

export type ParsedCustomCommand = {
  name: string;
  args: unknown[];
  prompt?: string;
  text: string;
  source: "text" | "discord-slash";
  error?: string;
};

export function parseCustomCommandFromRaw(raw: unknown): ParsedCustomCommand | null {
  const parsed = customCommandRawSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.customCommand) return null;

  const record = parsed.data.customCommand;
  return {
    name: record.name,
    args: record.args ?? [],
    ...(record.prompt !== undefined ? { prompt: record.prompt } : {}),
    text: record.text,
    source: record.source,
    ...(record.error !== undefined ? { error: record.error } : {}),
  };
}
