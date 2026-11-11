import { z } from "zod";
import {
  isRecord,
  MODEL_REASONING_EFFORTS,
  type ModelReasoningEffort,
} from "@stanley2058/lilac-utils";

const SESSION_MODES = ["mention", "active"] as const;
const CUSTOM_COMMAND_SOURCES = ["text", "discord-slash"] as const;

/** Name of a configured subagent permission profile. */
export type SubagentProfile = string;
export type AgentRunProfile = "primary" | (SubagentProfile & {});
export type AgentRunnerRaw = {} | null;

export function preserveAgentRunnerRaw(message: {
  readonly data: { readonly raw?: unknown };
}): AgentRunnerRaw | undefined {
  const { raw } = message.data;
  if (raw === undefined || raw === null) return raw;
  return raw;
}

const NATIVE_SERVICE_USER_ID = "lilac";

export type ParsedSubagentMeta = {
  profile: AgentRunProfile;
  depth: number;
  reasoning?: ModelReasoningEffort;
};

const nonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));
function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
const optionalNonEmptyStringSchema = z.preprocess(
  normalizeOptionalNonEmptyString,
  nonEmptyStringSchema.optional(),
);
function normalizeSessionMode(value: unknown): "mention" | "active" | undefined {
  return value === "mention" || value === "active" ? value : undefined;
}
const sessionModeSchema = z.preprocess(normalizeSessionMode, z.enum(SESSION_MODES).optional());
function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}
const stringArraySchema = z.preprocess(normalizeStringArray, z.array(z.string()));
function normalizeBooleanTrue(value: unknown): boolean {
  return value === true;
}
const booleanTrueSchema = z.preprocess(normalizeBooleanTrue, z.boolean());
function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
const optionalStringSchema = z.preprocess(normalizeOptionalString, z.string().optional());
function normalizeSubagentProfile(value: unknown): SubagentProfile | undefined {
  return isSubagentProfile(value) ? value : undefined;
}
const subagentProfileSchema = z.preprocess(normalizeSubagentProfile, z.string().optional());
function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
const optionalFiniteNumberSchema = z.preprocess(
  normalizeOptionalFiniteNumber,
  z.number().optional(),
);

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === "string" && MODEL_REASONING_EFFORTS.some((effort) => effort === value);
}

function normalizeModelReasoningEffort(value: unknown): ModelReasoningEffort | undefined {
  return isModelReasoningEffort(value) ? value : undefined;
}

const modelReasoningEffortSchema = z.preprocess(
  normalizeModelReasoningEffort,
  z.enum(MODEL_REASONING_EFFORTS).optional(),
);

const routerRawSchema = z
  .object({
    sessionMode: sessionModeSchema,
    sessionConfigId: optionalNonEmptyStringSchema,
    parentChannelId: optionalNonEmptyStringSchema,
    guildId: optionalNonEmptyStringSchema,
    modelOverride: optionalNonEmptyStringSchema,
    bufferedForActiveRequestId: optionalNonEmptyStringSchema,
    chainMessageIds: stringArraySchema,
    participantUserIds: stringArraySchema,
  })
  .loose();

const requestControlRawSchema = z.strictObject({
  requiresActive: booleanTrueSchema,
  autoFollowUp: z
    .strictObject({
      parentRequestId: z.string().min(1).max(512),
      parentToolCallId: z.string().min(1).max(512),
    })
    .optional(),
  cancel: booleanTrueSchema,
  cancelQueued: booleanTrueSchema,
  messageId: optionalStringSchema,
});

const subagentRawSchema = z
  .object({
    subagent: z
      .object({
        profile: subagentProfileSchema,
        depth: optionalFiniteNumberSchema,
        reasoning: modelReasoningEffortSchema,
      })
      .optional(),
  })
  .loose();

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
  .loose();

const workflowPolicyRawSchema = z
  .object({
    workflow: z
      .strictObject({
        runId: z.string().min(1).max(200),
        operationId: z.string().min(1).max(200),
        dispatchEpoch: z.string().min(16).max(200),
      })
      .optional(),
  })
  .loose();

export type WorkflowRequestHint = NonNullable<z.infer<typeof workflowPolicyRawSchema>["workflow"]>;

export function parseWorkflowRequestHintFromRaw(raw: unknown): WorkflowRequestHint | null {
  const parsed = workflowPolicyRawSchema.safeParse(raw);
  return parsed.success ? (parsed.data.workflow ?? null) : null;
}

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

export function parseGuildIdFromRaw(raw: unknown): string | null {
  return parseRouterRaw(raw)?.guildId ?? null;
}

export function parseRequestModelOverrideFromRaw(raw: unknown): string | null {
  return parseRouterRaw(raw)?.modelOverride ?? null;
}

export type RequestControl = {
  requiresActive: boolean;
  /**
   * For a subagent steer that becomes a follow-up when it misses the child's run: the request and
   * tool call that sent it, which the follow-up reports to.
   */
  autoFollowUp: { readonly parentRequestId: string; readonly parentToolCallId: string } | null;
  cancel: boolean;
  cancelQueued: boolean;
  targetMessageId: string | null;
};

const jobWakeRawSchema = z
  .object({
    jobWake: z.literal(true).optional(),
    native: z.object({ authorUserId: z.string() }).loose().optional(),
  })
  .loose();

/** True for requests a background job started, which do not count as input from a person. */
export function isJobWakeRequestRaw(raw: unknown): boolean {
  const parsed = jobWakeRawSchema.safeParse(raw);
  if (!parsed.success) return false;
  return (
    parsed.data.jobWake === true || parsed.data.native?.authorUserId === NATIVE_SERVICE_USER_ID
  );
}

export function parseRequestControlFromRaw(raw: unknown): RequestControl {
  if (!isRecord(raw)) {
    return {
      requiresActive: false,
      autoFollowUp: null,
      cancel: false,
      cancelQueued: false,
      targetMessageId: null,
    };
  }

  const ownDataProperty = (
    key: "requiresActive" | "autoFollowUp" | "cancel" | "cancelQueued" | "messageId",
  ) => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const parsed = requestControlRawSchema.safeParse({
    requiresActive: ownDataProperty("requiresActive"),
    autoFollowUp: ownDataProperty("autoFollowUp"),
    cancel: ownDataProperty("cancel"),
    cancelQueued: ownDataProperty("cancelQueued"),
    messageId: ownDataProperty("messageId"),
  });
  if (!parsed.success) {
    return {
      requiresActive: false,
      autoFollowUp: null,
      cancel: false,
      cancelQueued: false,
      targetMessageId: null,
    };
  }

  const record = parsed.data;
  return {
    requiresActive: record.requiresActive === true,
    autoFollowUp: record.autoFollowUp ?? null,
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
  return typeof value === "string" && value.length > 0 && value !== "primary";
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

  return {
    profile,
    depth,
    ...(subagent.reasoning ? { reasoning: subagent.reasoning } : {}),
  };
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
