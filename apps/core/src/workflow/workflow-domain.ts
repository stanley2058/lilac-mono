import { z } from "zod";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = z.infer<typeof jsonObjectSchema>;

const idSchema = z.string().min(1).max(200);
const boundedTextSchema = z.string().max(16_384);
const timestampSchema = z.number().int().nonnegative();
const nullableTimestampSchema = timestampSchema.nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const platformSchema = z.enum([
  "discord",
  "github",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);

export const workflowScopeSchema = z.enum(["project", "personal"]);
export type WorkflowScope = z.infer<typeof workflowScopeSchema>;

export const workflowSafetyModeSchema = z.enum(["trusted", "restricted"]);
export type WorkflowSafetyMode = z.infer<typeof workflowSafetyModeSchema>;

const workflowCapabilityProfileInputSchema = z
  .strictObject({
    agents: z.strictObject({
      profiles: z.array(z.string().min(1).max(100)).max(64),
      models: z.array(z.string().min(1).max(200)).max(64),
      editing: z.boolean(),
      isolation: z.enum(["shared", "worktree"]),
      maxConcurrent: z.number().int().min(1).max(64),
      maxTotal: z.number().int().min(1).max(10_000),
    }),
    maxNestingDepth: z.number().int().min(1).max(64),
    maxWallTimeMs: z
      .number()
      .int()
      .min(1_000)
      .max(7 * 24 * 60 * 60 * 1_000),
    operationIdleTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1_000),
    waits: z.array(z.enum(["reply", "sleep"])).max(16),
    surfaceSends: z.boolean(),
    externalTools: z.boolean(),
    safety: z.strictObject({
      originatingMode: workflowSafetyModeSchema,
      escalation: z.enum(["none", "trusted_with_review"]),
    }),
  })
  .superRefine((profile, ctx) => {
    if (profile.agents.maxConcurrent > profile.agents.maxTotal) {
      ctx.addIssue({
        code: "custom",
        path: ["agents", "maxConcurrent"],
        message: "maxConcurrent cannot exceed maxTotal",
      });
    }
    if (
      profile.agents.editing &&
      profile.agents.isolation !== "worktree" &&
      profile.agents.maxConcurrent > 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["agents", "isolation"],
        message: "parallel edit-capable agents require worktree isolation",
      });
    }
    if (
      profile.safety.originatingMode === "restricted" &&
      profile.safety.escalation === "trusted_with_review"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["safety", "escalation"],
        message: "restricted workflows cannot escalate to trusted mode",
      });
    }
  });

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

export const workflowCapabilityProfileSchema = workflowCapabilityProfileInputSchema.superRefine(
  (profile, ctx) => {
    if (!isSortedUnique(profile.agents.profiles)) {
      ctx.addIssue({
        code: "custom",
        path: ["agents", "profiles"],
        message: "profiles must be sorted and unique",
      });
    }
    if (!isSortedUnique(profile.agents.models)) {
      ctx.addIssue({
        code: "custom",
        path: ["agents", "models"],
        message: "models must be sorted and unique",
      });
    }
    if (!isSortedUnique(profile.waits)) {
      ctx.addIssue({
        code: "custom",
        path: ["waits"],
        message: "waits must be sorted and unique",
      });
    }
  },
);
export type WorkflowCapabilityProfile = z.infer<typeof workflowCapabilityProfileSchema>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function normalizeWorkflowCapabilityProfile(input: unknown): WorkflowCapabilityProfile {
  const parsed = workflowCapabilityProfileInputSchema.parse(input);
  return workflowCapabilityProfileSchema.parse({
    ...parsed,
    agents: {
      ...parsed.agents,
      profiles: sortedUnique(parsed.agents.profiles),
      models: sortedUnique(parsed.agents.models),
    },
    waits: sortedUnique(parsed.waits),
  });
}

export const workflowLimitsSchema = z.strictObject({
  maxSourceBytes: z.number().int().positive(),
  maxInputBytes: z.number().int().positive(),
  maxOperationOutputBytes: z.number().int().positive(),
  maxResultBytes: z.number().int().positive(),
  maxRuntimeMemoryBytes: z
    .number()
    .int()
    .min(64 * 1024 * 1024)
    .max(256 * 1024 * 1024)
    .default(256 * 1024 * 1024),
});
export type WorkflowLimits = z.infer<typeof workflowLimitsSchema>;

export const workflowMetadataSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().min(1).max(2_000),
});
export type WorkflowMetadata = z.infer<typeof workflowMetadataSchema>;

export const workflowRevisionIdentitySchema = z.strictObject({
  canonicalProjectId: idSchema,
  canonicalWorkspaceRoot: z.string().min(1).max(4_096),
  scope: workflowScopeSchema,
  normalizedPath: z.string().min(1).max(1_024),
  sourceSha256: sha256Schema,
  inputSchemaSha256: sha256Schema,
  capabilitySha256: sha256Schema,
  runtimeVersion: z.string().min(1).max(100),
});
export type WorkflowRevisionIdentity = z.infer<typeof workflowRevisionIdentitySchema>;

export const workflowRevisionSchema = workflowRevisionIdentitySchema.extend({
  revisionId: idSchema,
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  snapshotArtifactId: idSchema,
  metadata: workflowMetadataSchema,
  inputSchema: jsonObjectSchema,
  capabilities: workflowCapabilityProfileSchema,
  limits: workflowLimitsSchema,
  createdAt: timestampSchema,
});
export type WorkflowRevision = z.infer<typeof workflowRevisionSchema>;

export const workflowApprovalStateSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "revoked",
  "expired",
]);
export type WorkflowApprovalState = z.infer<typeof workflowApprovalStateSchema>;

export const workflowApprovalSchema = z.strictObject({
  approvalId: idSchema,
  revisionId: idSchema,
  state: workflowApprovalStateSchema,
  expectedReviewerPlatform: platformSchema.nullable(),
  expectedReviewerUserId: idSchema.nullable(),
  firstRunId: idSchema,
  decisionActorPlatform: platformSchema.nullable(),
  decisionActorUserId: idSchema.nullable(),
  decisionSource: boundedTextSchema.nullable(),
  expiresAt: nullableTimestampSchema,
  decidedAt: nullableTimestampSchema,
  revokedAt: nullableTimestampSchema,
  revocationReason: boundedTextSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type WorkflowApproval = z.infer<typeof workflowApprovalSchema>;

export const workflowRunStateSchema = z.enum([
  "awaiting_review",
  "queued",
  "running",
  "blocked",
  "paused",
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
]);
export type WorkflowRunState = z.infer<typeof workflowRunStateSchema>;

export const workflowRunOriginSchema = z.strictObject({
  requestId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  client: platformSchema.nullable(),
  userId: idSchema.nullable(),
  safetyMode: workflowSafetyModeSchema,
  projectCwd: z.string().min(1).max(4_096),
});
export type WorkflowRunOrigin = z.infer<typeof workflowRunOriginSchema>;

export const workflowProgressTargetSchema = z.strictObject({
  platform: platformSchema,
  channelId: idSchema,
  replyToMessageId: idSchema.nullable(),
});
export type WorkflowProgressTarget = z.infer<typeof workflowProgressTargetSchema>;

export const workflowCompletionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("detached") }),
  z.strictObject({ kind: z.literal("durable_surface") }),
  z.strictObject({
    kind: z.literal("live_parent"),
    parentRequestId: idSchema,
    parentSessionId: idSchema,
    parentRequestClient: platformSchema,
    parentToolCallId: idSchema,
    childRequestId: idSchema,
    childSessionId: idSchema,
    profile: z.enum(["explore", "general", "self"]),
    sessionName: idSchema,
    depth: z.number().int().positive().max(64),
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .nullable(),
    fallbackToSurface: z.boolean(),
    fallbackProgressTarget: workflowProgressTargetSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("new_session_request"),
    sessionId: idSchema,
    client: platformSchema,
  }),
]);
export type WorkflowCompletionTarget = z.infer<typeof workflowCompletionTargetSchema>;

export const workflowRunSchema = z.strictObject({
  runId: idSchema,
  revisionId: idSchema,
  approvalId: idSchema.nullable(),
  state: workflowRunStateSchema,
  inputSchemaSnapshot: jsonObjectSchema,
  args: jsonObjectSchema,
  argsSha256: sha256Schema,
  origin: workflowRunOriginSchema,
  completionTarget: workflowCompletionTargetSchema,
  progressTarget: workflowProgressTargetSchema.nullable(),
  terminalDetail: boundedTextSchema.nullable(),
  result: jsonValueSchema.nullable(),
  resultArtifactId: idSchema.nullable(),
  claimedBy: idSchema.nullable(),
  claimedAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  startedAt: nullableTimestampSchema,
  updatedAt: timestampSchema,
  terminalAt: nullableTimestampSchema,
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const workflowOperationKindSchema = z.enum([
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "wait",
]);
export type WorkflowOperationKind = z.infer<typeof workflowOperationKindSchema>;

export const workflowOperationStateSchema = z.enum([
  "queued",
  "dispatched",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);
export type WorkflowOperationState = z.infer<typeof workflowOperationStateSchema>;

export const workflowUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type WorkflowUsage = z.infer<typeof workflowUsageSchema>;

export const workflowOperationSchema = z.strictObject({
  runId: idSchema,
  operationId: idSchema,
  callSiteId: idSchema,
  parentOperationId: idSchema.nullable(),
  phase: z.string().min(1).max(200).nullable(),
  label: z.string().min(1).max(500).nullable(),
  kind: workflowOperationKindSchema,
  input: jsonValueSchema,
  inputSha256: sha256Schema,
  state: workflowOperationStateSchema,
  attempt: z.number().int().nonnegative(),
  requestId: idSchema.nullable(),
  output: jsonValueSchema.nullable(),
  resultArtifactId: idSchema.nullable(),
  error: boundedTextSchema.nullable(),
  usage: workflowUsageSchema.nullable(),
  claimedBy: idSchema.nullable(),
  claimedAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  startedAt: nullableTimestampSchema,
  updatedAt: timestampSchema,
  terminalAt: nullableTimestampSchema,
});
export type WorkflowOperation = z.infer<typeof workflowOperationSchema>;

export const workflowWaitMatchSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("reply"),
    platform: platformSchema,
    channelId: idSchema,
    messageId: idSchema.nullable(),
    fromUserId: idSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("sleep") }),
]);
export type WorkflowWaitMatch = z.infer<typeof workflowWaitMatchSchema>;

export const workflowWaitStateSchema = z.enum([
  "pending",
  "claimed",
  "resolved",
  "expired",
  "cancelled",
]);
export type WorkflowWaitState = z.infer<typeof workflowWaitStateSchema>;

export const workflowWaitSchema = z.strictObject({
  runId: idSchema,
  operationId: idSchema,
  state: workflowWaitStateSchema,
  match: workflowWaitMatchSchema,
  matchKey: z.string().min(1).max(1_000),
  dueAt: nullableTimestampSchema,
  deadlineAt: nullableTimestampSchema,
  resolverCursor: z.string().max(1_000).nullable(),
  result: jsonValueSchema.nullable(),
  resolvedBy: z.string().max(1_000).nullable(),
  claimedBy: idSchema.nullable(),
  claimedAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  resolvedAt: nullableTimestampSchema,
});
export type WorkflowWait = z.infer<typeof workflowWaitSchema>;

export const workflowTriggerDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("immediate") }),
  z.strictObject({ kind: z.literal("timestamp"), at: timestampSchema }),
  z.strictObject({
    kind: z.literal("cron"),
    expression: z.string().min(1).max(500),
    timezone: z.string().min(1).max(200).nullable(),
  }),
  z.strictObject({
    kind: z.literal("reply"),
    platform: platformSchema,
    channelId: idSchema,
    messageId: idSchema.nullable(),
    fromUserId: idSchema.nullable(),
  }),
]);
export type WorkflowTriggerDefinition = z.infer<typeof workflowTriggerDefinitionSchema>;

export const workflowTriggerStateSchema = z.enum(["active", "paused", "completed", "cancelled"]);
export type WorkflowTriggerState = z.infer<typeof workflowTriggerStateSchema>;

export const workflowTriggerSchema = z.strictObject({
  triggerId: idSchema,
  revisionId: idSchema,
  state: workflowTriggerStateSchema,
  definition: workflowTriggerDefinitionSchema,
  args: jsonObjectSchema,
  argsSha256: sha256Schema,
  schedulingPolicy: z.strictObject({ skipMissed: z.boolean() }),
  origin: workflowRunOriginSchema,
  completionTarget: workflowCompletionTargetSchema,
  progressTarget: workflowProgressTargetSchema.nullable(),
  nextFireAt: nullableTimestampSchema,
  lastFireAt: nullableTimestampSchema,
  lastRunId: idSchema.nullable(),
  claimedBy: idSchema.nullable(),
  claimedAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export const workflowSurfaceBindingSchema = z.strictObject({
  runId: idSchema,
  target: workflowProgressTargetSchema,
  messageRef: z
    .strictObject({ platform: platformSchema, channelId: idSchema, messageId: idSchema })
    .nullable(),
  lastRenderedSha256: sha256Schema.nullable(),
  lastError: boundedTextSchema.nullable(),
  retryCount: z.number().int().nonnegative(),
  nextAttemptAt: nullableTimestampSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type WorkflowSurfaceBinding = z.infer<typeof workflowSurfaceBindingSchema>;

export const workflowSurfaceActionKindSchema = z.enum([
  "approve",
  "reject",
  "pause",
  "resume",
  "cancel",
]);
export type WorkflowSurfaceActionKind = z.infer<typeof workflowSurfaceActionKindSchema>;

export const workflowSurfaceActionSchema = z.strictObject({
  actionId: idSchema,
  tokenSha256: sha256Schema,
  runId: idSchema,
  approvalId: idSchema.nullable(),
  kind: workflowSurfaceActionKindSchema,
  expectedPlatform: platformSchema,
  expectedUserId: idSchema,
  expectedMessageRef: z
    .strictObject({ platform: platformSchema, channelId: idSchema, messageId: idSchema })
    .nullable(),
  expiresAt: timestampSchema,
  consumedAt: nullableTimestampSchema,
  consumedByPlatform: platformSchema.nullable(),
  consumedByUserId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type WorkflowSurfaceAction = z.infer<typeof workflowSurfaceActionSchema>;

export const workflowSchemaMigrationSchema = z.strictObject({
  version: z.number().int().positive(),
  name: z.string().min(1).max(200),
  appliedAt: timestampSchema,
});
export type WorkflowSchemaMigration = z.infer<typeof workflowSchemaMigrationSchema>;

const RUN_TRANSITIONS = {
  awaiting_review: ["queued", "rejected", "cancelled"],
  queued: ["running", "paused", "cancelled"],
  running: ["blocked", "paused", "succeeded", "failed", "cancelled"],
  blocked: ["queued", "running", "paused", "failed", "cancelled"],
  paused: ["queued", "running", "cancelled"],
  succeeded: [],
  failed: [],
  rejected: [],
  cancelled: [],
} as const satisfies Record<WorkflowRunState, readonly WorkflowRunState[]>;

const APPROVAL_TRANSITIONS = {
  pending: ["approved", "rejected", "expired"],
  approved: ["revoked", "expired"],
  rejected: [],
  revoked: [],
  expired: [],
} as const satisfies Record<WorkflowApprovalState, readonly WorkflowApprovalState[]>;

const OPERATION_TRANSITIONS = {
  queued: ["dispatched", "cancelled"],
  dispatched: ["running", "queued", "failed", "cancelled", "timed_out"],
  running: ["blocked", "succeeded", "failed", "cancelled", "timed_out"],
  blocked: ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"],
  succeeded: [],
  failed: ["queued"],
  cancelled: [],
  timed_out: ["queued"],
} as const satisfies Record<WorkflowOperationState, readonly WorkflowOperationState[]>;

const WAIT_TRANSITIONS = {
  pending: ["claimed", "resolved", "expired", "cancelled"],
  claimed: ["pending", "resolved", "expired", "cancelled"],
  resolved: [],
  expired: [],
  cancelled: [],
} as const satisfies Record<WorkflowWaitState, readonly WorkflowWaitState[]>;

const TRIGGER_TRANSITIONS = {
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [],
  cancelled: [],
} as const satisfies Record<WorkflowTriggerState, readonly WorkflowTriggerState[]>;

function includesState<TState extends string>(allowed: readonly TState[], next: TState): boolean {
  return allowed.includes(next);
}

export function canTransitionWorkflowRun(from: WorkflowRunState, to: WorkflowRunState): boolean {
  return from === to || includesState(RUN_TRANSITIONS[from], to);
}

export function canTransitionWorkflowApproval(
  from: WorkflowApprovalState,
  to: WorkflowApprovalState,
): boolean {
  return from === to || includesState(APPROVAL_TRANSITIONS[from], to);
}

export function canTransitionWorkflowOperation(
  from: WorkflowOperationState,
  to: WorkflowOperationState,
): boolean {
  return from === to || includesState(OPERATION_TRANSITIONS[from], to);
}

export function canTransitionWorkflowWait(from: WorkflowWaitState, to: WorkflowWaitState): boolean {
  return from === to || includesState(WAIT_TRANSITIONS[from], to);
}

export function canTransitionWorkflowTrigger(
  from: WorkflowTriggerState,
  to: WorkflowTriggerState,
): boolean {
  return from === to || includesState(TRIGGER_TRANSITIONS[from], to);
}

export const WORKFLOW_TERMINAL_RUN_STATES = [
  "succeeded",
  "failed",
  "rejected",
  "cancelled",
] as const satisfies readonly WorkflowRunState[];

export const WORKFLOW_REVISION_IDENTITY_VERSION = 1;
