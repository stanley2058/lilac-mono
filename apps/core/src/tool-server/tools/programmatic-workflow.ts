import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@stanley2058/lilac-utils";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";

import { isAdapterPlatform } from "../../shared/is-adapter-platform";
import { DurableWorkflowStore } from "../../workflow/durable-workflow-store";
import {
  canonicalJsonSha256,
  sha256,
  validateWorkflowArgs,
  workflowDefinitionNameSchema,
  WORKFLOW_RUNTIME_VERSION,
} from "../../workflow/workflow-definition";
import { WorkflowDefinitionStore } from "../../workflow/workflow-definition-store";
import { computeNextCronAtMs } from "../../workflow/cron";
import {
  jsonObjectSchema,
  workflowRunStateSchema,
  type WorkflowApproval,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowSafetyMode,
  type WorkflowTrigger,
} from "../../workflow/workflow-domain";
import type { RequestContext, ServerTool } from "../types";
import type { WorkflowProgressCardService } from "../../workflow/workflow-progress-projector";
import type { WorkflowReviewerResolver } from "../../workflow/workflow-reviewer";
import { parseToolInput } from "../validation-error-message";
import { zodObjectToCliLines } from "./zod-cli";
import { readWorkflowValueArtifact } from "../../workflow/workflow-artifact-store";
import { redactWorkflowValue } from "../../workflow/workflow-progress-view";
import {
  publicWorkflowWorktreeOutput,
  readWorkflowWorktreePatch,
  WORKFLOW_WORKTREE_PATCH_READ_MAX_BYTES,
} from "../../workflow/workflow-worktree-artifact";

const definitionScopeSchema = z.enum(["project", "personal", "auto"]);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const definitionSaveInputSchema = z.strictObject({
  scope: z.enum(["project", "personal"]).describe("Definition scope"),
  name: workflowDefinitionNameSchema.describe("Lowercase kebab-case workflow name"),
  source: z.string().min(1).describe("Complete JavaScript workflow source"),
  expectedSha256: hashSchema
    .optional()
    .describe("Required current source SHA-256 when replacing an existing definition"),
});

const definitionValidateInputSchema = z.strictObject({
  scope: definitionScopeSchema.describe("Use auto for project-first resolution"),
  name: workflowDefinitionNameSchema,
  args: z.record(z.string(), z.unknown()).optional().describe("Optional concrete JSON arguments"),
});

const definitionGetInputSchema = z.strictObject({
  scope: definitionScopeSchema,
  name: workflowDefinitionNameSchema,
  includeSource: z.coerce.boolean().default(false).describe("Include bounded source text"),
});

const definitionListInputSchema = z.strictObject({
  scope: definitionScopeSchema.default("auto").describe("Auto merges scopes project-first by name"),
});

const progressInputSchema = z
  .strictObject({
    requestOrigin: z.literal(true).optional(),
    client: z.enum(["discord", "github"]).optional(),
    sessionId: z.string().min(1).max(200).optional(),
  })
  .superRefine((progress, ctx) => {
    if ((progress.client === undefined) !== (progress.sessionId === undefined)) {
      ctx.addIssue({ code: "custom", message: "client and sessionId must be provided together" });
    }
  });

const runTriggerInputSchema = z.strictObject({
  scope: definitionScopeSchema,
  name: workflowDefinitionNameSchema,
  args: z.record(z.string(), z.unknown()),
  progress: progressInputSchema.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
const scheduledTriggerDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("timestamp"),
    at: z.union([z.number().int().nonnegative(), z.string().min(1).max(100)]),
  }),
  z.strictObject({
    kind: z.literal("cron"),
    expression: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (value) => value.trim().split(/\s+/u).length === 5,
        "expression must be a 5-field cron expression",
      ),
    timezone: z.string().min(1).max(200).optional(),
    startAt: z.number().int().nonnegative().optional(),
    skipMissed: z.boolean().default(true),
    overlap: z.enum(["coalesce", "parallel"]).default("coalesce"),
  }),
]);
const scheduledTriggerCreateInputSchema = z.strictObject({
  scope: definitionScopeSchema,
  name: workflowDefinitionNameSchema,
  args: z.record(z.string(), z.unknown()),
  schedule: scheduledTriggerDefinitionSchema,
  progress: progressInputSchema.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
const scheduledTriggerGetInputSchema = z.strictObject({
  triggerId: z.string().min(1).max(200),
});
const scheduledTriggerListInputSchema = z.strictObject({
  state: z.enum(["active", "paused", "completed", "cancelled"]).optional(),
  limit: z.coerce.number().int().positive().max(1_000).default(100),
});
const scheduledTriggerCancelInputSchema = scheduledTriggerGetInputSchema;

const runGetInputSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  includeSource: z.coerce.boolean().default(false),
  includeResultArtifact: z.coerce.boolean().default(false),
  includeSensitiveResult: z.coerce.boolean().default(false),
  worktreePatchArtifactId: z
    .string()
    .regex(/^workflow-worktree-patch:[a-f0-9]{64}$/u)
    .optional(),
  worktreePatchOffset: z.coerce.number().int().nonnegative().default(0),
  worktreePatchBytes: z.coerce
    .number()
    .int()
    .positive()
    .max(WORKFLOW_WORKTREE_PATCH_READ_MAX_BYTES)
    .default(WORKFLOW_WORKTREE_PATCH_READ_MAX_BYTES),
  worktreeOutputOffset: z.coerce.number().int().nonnegative().max(10_000).default(0),
  worktreeOutputLimit: z.coerce.number().int().positive().max(1_000).default(100),
});
const runListInputSchema = z.strictObject({
  state: workflowRunStateSchema.optional(),
  limit: z.coerce.number().int().positive().max(1_000).default(100),
});
const runCancelInputSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  reason: z.string().min(1).max(16_384).optional(),
});
const runPauseInputSchema = z.strictObject({ runId: z.string().min(1).max(200) });
const runResumeInputSchema = z.strictObject({ runId: z.string().min(1).max(200) });
const approvalRevokeInputSchema = z.strictObject({
  approvalId: z.string().min(1).max(200),
  reason: z.string().min(1).max(16_384).optional(),
});

function safetyMode(context: RequestContext | undefined): WorkflowSafetyMode {
  return context?.safetyMode === "trusted" ? "trusted" : "restricted";
}

function requireWorkflowControlContext(context: RequestContext | undefined): RequestContext {
  if (context?.serverOwnedRequest !== true) {
    throw new Error("Workflow tools require a server-owned active request context");
  }
  if (context.safetyMode !== "trusted") {
    throw new Error("Workflow tools require a trusted request context");
  }
  if (!context.authenticatedPrincipal && !context.operator) {
    throw new Error("Workflow tools require an authenticated canonical principal");
  }
  return context;
}

function principalReviewer(context: RequestContext) {
  const principal = context.authenticatedPrincipal;
  if (!principal || !context.sessionId) return null;
  return {
    platform: principal.platform,
    userId: principal.userId,
    sessionRef: { platform: principal.platform, channelId: context.sessionId },
    originMessageRef: null,
  } as const;
}

function assertPrincipalScope(input: {
  context: RequestContext;
  canonicalProjectId: string;
  revision: WorkflowRevision;
  run?: WorkflowRun | null;
  approval?: WorkflowApproval | null;
  trigger?: WorkflowTrigger | null;
}): void {
  const principal = input.context.authenticatedPrincipal;
  if (input.revision.canonicalProjectId !== input.canonicalProjectId) {
    throw new Error("Workflow record is outside the authenticated project scope");
  }
  if (input.context.operator) return;
  if (!principal) throw new Error("Workflow record is outside the authenticated project scope");
  if (
    input.trigger &&
    (input.trigger.origin.client !== principal.platform ||
      input.trigger.origin.userId !== principal.userId)
  ) {
    throw new Error("Workflow trigger is outside the authenticated principal scope");
  }
  if (
    input.run &&
    (input.run.origin.client !== principal.platform || input.run.origin.userId !== principal.userId)
  ) {
    throw new Error("Workflow record is outside the authenticated principal scope");
  }
  const internalGeneratedRunGrant =
    input.run?.completionTarget.kind === "live_parent" &&
    input.revision.normalizedPath === ".lilac/internal/subagent-delegate.js" &&
    input.revision.name === "subagent-delegate" &&
    input.approval?.state === "approved" &&
    input.approval.expectedReviewerPlatform === null &&
    input.approval.expectedReviewerUserId === null &&
    input.approval.decisionSource === "internal trusted subagent delegation";
  if (
    input.approval &&
    !internalGeneratedRunGrant &&
    (input.approval.expectedReviewerPlatform !== principal.platform ||
      input.approval.expectedReviewerUserId !== principal.userId)
  ) {
    throw new Error("Workflow grant is outside the authenticated principal scope");
  }
}

function hasSensitiveSchema(schema: WorkflowRun["inputSchemaSnapshot"]): boolean {
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    if (Reflect.get(value, "sensitive") === true) return true;
    return Object.values(value).some(visit);
  };
  return visit(schema);
}

function redactRun(run: WorkflowRun) {
  const sensitive = hasSensitiveSchema(run.inputSchemaSnapshot);
  const { argsSha256, ...safeRun } = run;
  return {
    ...safeRun,
    ...(sensitive ? {} : { argsSha256 }),
    args: jsonObjectSchema.parse(redactWorkflowValue(run.args, run.inputSchemaSnapshot)),
    result:
      run.result === null
        ? null
        : sensitive
          ? "<redacted; owner may request explicit full inspection>"
          : run.result,
    terminalDetail:
      sensitive && run.terminalDetail ? "<redacted terminal detail>" : run.terminalDetail,
  };
}

function redactTrigger(trigger: WorkflowTrigger, revision: WorkflowRevision) {
  const { argsSha256, ...safeTrigger } = trigger;
  const sensitive = hasSensitiveSchema(revision.inputSchema);
  return {
    ...safeTrigger,
    ...(sensitive ? {} : { argsSha256 }),
    args: jsonObjectSchema.parse(redactWorkflowValue(trigger.args, revision.inputSchema)),
  };
}

function requireTrustedTriggerContext(context: RequestContext | undefined): RequestContext & {
  cwd: string;
  safetyMode: "trusted";
} {
  requireWorkflowControlContext(context);
  if (!context?.cwd) throw new Error("workflow.run.trigger requires server-resolved request cwd");
  return { ...context, cwd: context.cwd, safetyMode: "trusted" };
}

function validationResult(definition: Awaited<ReturnType<WorkflowDefinitionStore["get"]>>) {
  return {
    scope: definition.scope,
    name: definition.name,
    path: definition.canonicalPath,
    normalizedPath: definition.normalizedPath,
    metadata: definition.validation.metadata,
    inputSchema: definition.validation.inputSchema,
    capabilities: definition.validation.capabilities,
    limits: definition.validation.limits,
    sensitiveFields: definition.validation.sensitiveFields,
    sourceSha256: definition.validation.sourceSha256,
    inputSchemaSha256: definition.validation.inputSchemaSha256,
    capabilitySha256: definition.validation.capabilitySha256,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    reviewSummary: definition.validation.reviewSummary,
  };
}

export class ProgrammaticWorkflow implements ServerTool {
  id = "workflow-programmatic";
  private durableStore: DurableWorkflowStore | null = null;
  private ownsStore = false;
  private readonly definitionsStores = new Map<string, Promise<WorkflowDefinitionStore>>();

  constructor(
    private readonly params: {
      dataDir?: string;
      dbPath?: string;
      now?: () => number;
      store?: DurableWorkflowStore;
      bus?: LilacBus;
      reviewerResolver?: WorkflowReviewerResolver;
      progressCards?: WorkflowProgressCardService;
    } = {},
  ) {}

  async init(): Promise<void> {
    if (!this.durableStore) {
      this.durableStore = this.params.store ?? new DurableWorkflowStore(this.params.dbPath);
      this.ownsStore = !this.params.store;
    }
  }

  async destroy(): Promise<void> {
    if (this.ownsStore) this.durableStore?.close();
    this.durableStore = null;
    this.ownsStore = false;
    this.definitionsStores.clear();
  }

  async list() {
    return [
      {
        callableId: "workflow.definition.save",
        name: "Workflow Definition Save",
        description:
          "Statically validate and atomically save a project or personal JavaScript workflow.",
        shortInput: zodObjectToCliLines(definitionSaveInputSchema, { mode: "required" }),
        input: [
          ...zodObjectToCliLines(definitionSaveInputSchema),
          "Example: tools workflow.definition.save --input=@save-workflow.json",
        ],
      },
      {
        callableId: "workflow.definition.validate",
        name: "Workflow Definition Validate",
        description:
          "Resolve and statically validate a workflow, optionally validating concrete arguments.",
        shortInput: zodObjectToCliLines(definitionValidateInputSchema, { mode: "required" }),
        input: [
          ...zodObjectToCliLines(definitionValidateInputSchema),
          'Example: tools workflow.definition.validate --scope=auto --name=audit-routes --args:json=\'{"directory":"src"}\'',
        ],
      },
      {
        callableId: "workflow.definition.get",
        name: "Workflow Definition Get",
        description:
          "Inspect validated definition metadata and hashes; source is opt-in and bounded.",
        shortInput: zodObjectToCliLines(definitionGetInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(definitionGetInputSchema),
      },
      {
        callableId: "workflow.definition.list",
        name: "Workflow Definition List",
        description:
          "List statically validated workflow definitions without importing or executing them.",
        shortInput: zodObjectToCliLines(definitionListInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(definitionListInputSchema),
      },
      {
        callableId: "workflow.run.trigger",
        name: "Workflow Run Trigger",
        description:
          "Persist an immutable workflow invocation for review and automatic durable execution.",
        shortInput: zodObjectToCliLines(runTriggerInputSchema, { mode: "required" }),
        input: [
          ...zodObjectToCliLines(runTriggerInputSchema),
          'Example: tools workflow.run.trigger --scope=auto --name=audit-routes --args:json=\'{"directory":"src"}\'',
        ],
      },
      {
        callableId: "workflow.trigger.create",
        name: "Workflow Trigger Create",
        description:
          "Pin a validated immutable workflow revision to a durable timestamp or cron trigger.",
        shortInput: zodObjectToCliLines(scheduledTriggerCreateInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(scheduledTriggerCreateInputSchema),
      },
      {
        callableId: "workflow.trigger.get",
        name: "Workflow Trigger Get",
        description: "Inspect a durable trigger and the actual state of its most recent run.",
        shortInput: zodObjectToCliLines(scheduledTriggerGetInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(scheduledTriggerGetInputSchema),
        primaryPositional: { field: "triggerId" },
      },
      {
        callableId: "workflow.trigger.list",
        name: "Workflow Trigger List",
        description: "List durable timestamp and cron triggers.",
        shortInput: zodObjectToCliLines(scheduledTriggerListInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(scheduledTriggerListInputSchema),
      },
      {
        callableId: "workflow.trigger.cancel",
        name: "Workflow Trigger Cancel",
        description: "Cancel a durable trigger without changing runs it already created.",
        shortInput: zodObjectToCliLines(scheduledTriggerCancelInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(scheduledTriggerCancelInputSchema),
        primaryPositional: { field: "triggerId" },
      },
      {
        callableId: "workflow.run.get",
        name: "Workflow Run Get",
        description:
          "Inspect one durable workflow run, approval, and isolated-edit patch outputs; optionally read one authorized patch in bounded chunks.",
        shortInput: zodObjectToCliLines(runGetInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(runGetInputSchema),
        primaryPositional: { field: "runId" },
      },
      {
        callableId: "workflow.run.list",
        name: "Workflow Run List",
        description: "List durable workflow runs, optionally filtered by state.",
        shortInput: zodObjectToCliLines(runListInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(runListInputSchema),
      },
      {
        callableId: "workflow.run.cancel",
        name: "Workflow Run Cancel",
        description: "Durably cancel a non-terminal workflow run before execution or while active.",
        shortInput: zodObjectToCliLines(runCancelInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(runCancelInputSchema),
        primaryPositional: { field: "runId" },
      },
      {
        callableId: "workflow.run.pause",
        name: "Workflow Run Pause",
        description: "Durably pause a queued or active workflow run.",
        shortInput: zodObjectToCliLines(runPauseInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(runPauseInputSchema),
        primaryPositional: { field: "runId" },
      },
      {
        callableId: "workflow.run.resume",
        name: "Workflow Run Resume",
        description: "Return a paused workflow run to the durable queue.",
        shortInput: zodObjectToCliLines(runResumeInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(runResumeInputSchema),
        primaryPositional: { field: "runId" },
      },
      {
        callableId: "workflow.approval.revoke",
        name: "Workflow Approval Revoke",
        description: "Revoke an exact revision grant and pause attached queued runs.",
        shortInput: zodObjectToCliLines(approvalRevokeInputSchema, { mode: "required" }),
        input: zodObjectToCliLines(approvalRevokeInputSchema),
        primaryPositional: { field: "approvalId" },
      },
    ];
  }

  private store(): DurableWorkflowStore {
    if (!this.durableStore) throw new Error("Programmatic workflow tool is not initialized");
    return this.durableStore;
  }

  private async projectScope(context: RequestContext | undefined): Promise<{
    canonicalRoot: string;
    canonicalProjectId: string;
  }> {
    this.store();
    if (!context?.projectRoot) {
      throw new Error("Workflow request lacks server-resolved project root authority");
    }
    const requestedRoot = path.resolve(context.projectRoot);
    const stats = await fs.lstat(requestedRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Workflow project root must be a real directory: ${requestedRoot}`);
    }
    const canonicalRoot = await fs.realpath(requestedRoot);
    return {
      canonicalRoot,
      canonicalProjectId: `project:${sha256(canonicalRoot)}`,
    };
  }

  private async definitions(canonicalRoot: string): Promise<WorkflowDefinitionStore> {
    let definitions = this.definitionsStores.get(canonicalRoot);
    if (!definitions) {
      definitions = WorkflowDefinitionStore.create({
        workspaceRoot: canonicalRoot,
        dataDir: this.params.dataDir ?? env.dataDir,
      });
      this.definitionsStores.set(canonicalRoot, definitions);
      definitions.catch(() => this.definitionsStores.delete(canonicalRoot));
    }
    return await definitions;
  }

  async call(
    callableId: string,
    rawInput: Record<string, unknown>,
    opts?: { signal?: AbortSignal; context?: RequestContext; messages?: readonly unknown[] },
  ): Promise<unknown> {
    const controlContext = requireWorkflowControlContext(opts?.context);
    const projectScope = await this.projectScope(opts?.context);
    const mode = safetyMode(opts?.context);

    if (callableId === "workflow.definition.save") {
      const definitions = await this.definitions(projectScope.canonicalRoot);
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: definitionSaveInputSchema,
      });
      const saved = await definitions.save({ ...input, safetyMode: mode });
      return { ok: true as const, ...validationResult(saved) };
    }
    if (callableId === "workflow.definition.validate") {
      const definitions = await this.definitions(projectScope.canonicalRoot);
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: definitionValidateInputSchema,
      });
      const definition = await definitions.get({ ...input, safetyMode: mode });
      const args = input.args
        ? validateWorkflowArgs({
            inputSchema: definition.validation.inputSchema,
            args: input.args,
            maxInputBytes: definition.validation.limits.maxInputBytes,
          })
        : undefined;
      return {
        ok: true as const,
        ...validationResult(definition),
        argsValid: args ? true : undefined,
      };
    }
    if (callableId === "workflow.definition.get") {
      const definitions = await this.definitions(projectScope.canonicalRoot);
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: definitionGetInputSchema,
      });
      const definition = await definitions.get({ ...input, safetyMode: mode });
      return {
        ok: true as const,
        ...validationResult(definition),
        source: input.includeSource ? definition.source : undefined,
      };
    }
    if (callableId === "workflow.definition.list") {
      const definitions = await this.definitions(projectScope.canonicalRoot);
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: definitionListInputSchema,
      });
      const entries = await definitions.list({ scope: input.scope, safetyMode: mode });
      return {
        ok: true as const,
        definitions: entries.map((entry) =>
          entry.valid
            ? { valid: true as const, ...validationResult({ ...entry, source: "" }) }
            : entry,
        ),
      };
    }
    if (callableId === "workflow.trigger.create") {
      const definitions = await this.definitions(projectScope.canonicalRoot);
      const context = requireTrustedTriggerContext(opts?.context);
      const reviewer =
        (this.params.reviewerResolver
          ? await this.params.reviewerResolver.resolve(context)
          : null) ?? principalReviewer(context);
      if (!reviewer) {
        throw new Error("workflow.trigger.create requires an authenticated originating reviewer");
      }
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: scheduledTriggerCreateInputSchema,
      });
      if (
        input.progress?.client &&
        (input.progress.client !== reviewer.platform ||
          input.progress.sessionId !== reviewer.sessionRef.channelId)
      ) {
        throw new Error("Workflow progress must target the authenticated originating session");
      }
      const definition = await definitions.get({
        scope: input.scope,
        name: input.name,
        safetyMode: "trusted",
      });
      const args = validateWorkflowArgs({
        inputSchema: definition.validation.inputSchema,
        args: input.args,
        maxInputBytes: definition.validation.limits.maxInputBytes,
      });
      const snapshot = await definitions.createSnapshot(
        definition.source,
        definition.validation.sourceSha256,
      );
      const now = this.params.now?.() ?? Date.now();
      const revisionIdentity = {
        canonicalProjectId: definitions.canonicalProjectId,
        canonicalWorkspaceRoot: definitions.canonicalWorkspaceRoot,
        scope: definition.scope,
        normalizedPath: definition.normalizedPath,
        sourceSha256: definition.validation.sourceSha256,
        inputSchemaSha256: definition.validation.inputSchemaSha256,
        capabilitySha256: definition.validation.capabilitySha256,
        runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      } as const;
      const revisionId = `wfr:${canonicalJsonSha256(jsonObjectSchema.parse(revisionIdentity))}`;
      const revision: WorkflowRevision = {
        ...revisionIdentity,
        revisionId,
        name: definition.name,
        snapshotArtifactId: snapshot.artifactId,
        metadata: definition.validation.metadata,
        inputSchema: definition.validation.inputSchema,
        capabilities: definition.validation.capabilities,
        limits: definition.validation.limits,
        createdAt: now,
      };
      this.store().createRevision(revision);
      const storedRevision = this.store().findRevisionByIdentity(revisionIdentity);
      if (!storedRevision || storedRevision.revisionId !== revisionId) {
        throw new Error("Scheduled workflow revision identity collision");
      }
      const idempotencyKey =
        input.idempotencyKey ??
        `tool:${context.requestId ?? "missing"}:${context.toolCallId ?? canonicalJsonSha256(args)}`;
      const triggerFingerprint = canonicalJsonSha256(
        jsonObjectSchema.parse({
          revisionId,
          args,
          schedule: input.schedule,
          progress: input.progress ?? null,
          principal: context.authenticatedPrincipal,
        }),
      );
      const triggerId = `wftrigger:${canonicalJsonSha256(
        jsonObjectSchema.parse({ idempotencyKey, triggerFingerprint }),
      )}`;
      const schedule = input.schedule;
      const timestampAt =
        schedule.kind === "timestamp"
          ? typeof schedule.at === "number"
            ? schedule.at
            : Date.parse(schedule.at)
          : null;
      if (schedule.kind === "timestamp" && !Number.isFinite(timestampAt)) {
        throw new Error(`Invalid workflow trigger timestamp: ${schedule.at}`);
      }
      const nextFireAt =
        schedule.kind === "timestamp"
          ? (timestampAt ?? now)
          : computeNextCronAtMs(
              {
                expr: schedule.expression,
                tz: schedule.timezone,
                startAtMs: schedule.startAt,
              },
              now,
            );
      const progressTarget = {
        platform: reviewer.platform,
        channelId: reviewer.sessionRef.channelId,
        replyToMessageId: reviewer.originMessageRef?.messageId ?? null,
      };
      const trigger: WorkflowTrigger = {
        triggerId,
        revisionId,
        state: "active",
        definition:
          schedule.kind === "timestamp"
            ? { kind: "timestamp", at: nextFireAt }
            : {
                kind: "cron",
                expression: schedule.expression,
                timezone: schedule.timezone ?? null,
              },
        args,
        argsSha256: canonicalJsonSha256(args),
        schedulingPolicy: {
          skipMissed: schedule.kind === "cron" ? schedule.skipMissed : true,
          overlap: schedule.kind === "cron" ? schedule.overlap : "coalesce",
        },
        origin: {
          requestId: context.requestId ?? null,
          sessionId: context.sessionId ?? null,
          client: reviewer.platform,
          userId: reviewer.userId,
          safetyMode: "trusted",
          projectCwd: definitions.canonicalWorkspaceRoot,
        },
        completionTarget: { kind: "durable_surface" },
        progressTarget,
        nextFireAt,
        lastFireAt: null,
        lastRunId: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const stored = this.store().createTriggerInvocation({
        trigger,
        idempotency: { key: idempotencyKey, fingerprintSha256: triggerFingerprint },
      });
      return {
        ok: true as const,
        trigger: redactTrigger(stored.trigger, revision),
        created: stored.created,
        revisionId,
        sourceSha256: revision.sourceSha256,
        message:
          "The immutable revision is pinned. Every fire creates a distinct run and rechecks exact-revision approval.",
      };
    }
    if (callableId === "workflow.trigger.get") {
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: scheduledTriggerGetInputSchema,
      });
      const trigger = this.store().getTrigger(input.triggerId);
      if (!trigger) throw new Error(`Workflow trigger not found: ${input.triggerId}`);
      const revision = this.store().getRevision(trigger.revisionId);
      if (!revision) throw new Error(`Workflow revision not found: ${trigger.revisionId}`);
      assertPrincipalScope({
        context: controlContext,
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
        trigger,
      });
      return {
        ok: true as const,
        trigger: redactTrigger(trigger, revision),
        lastRun: trigger.lastRunId
          ? ((run) => (run ? redactRun(run) : null))(this.store().getRun(trigger.lastRunId))
          : null,
      };
    }
    if (callableId === "workflow.trigger.list") {
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: scheduledTriggerListInputSchema,
      });
      const triggers = this.store().listTriggers({
        ...input,
        canonicalProjectId: projectScope.canonicalProjectId,
        ...(controlContext.operator
          ? {}
          : {
              originClient: controlContext.authenticatedPrincipal?.platform,
              originUserId: controlContext.authenticatedPrincipal?.userId,
            }),
      });
      return {
        ok: true as const,
        triggers: triggers.map((trigger) => {
          const revision = this.store().getRevision(trigger.revisionId);
          if (!revision) throw new Error(`Workflow revision not found: ${trigger.revisionId}`);
          const lastRun = trigger.lastRunId ? this.store().getRun(trigger.lastRunId) : null;
          return {
            trigger: redactTrigger(trigger, revision),
            lastRun: lastRun ? redactRun(lastRun) : null,
          };
        }),
      };
    }
    if (callableId === "workflow.trigger.cancel") {
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: scheduledTriggerCancelInputSchema,
      });
      const trigger = this.store().getTrigger(input.triggerId);
      if (!trigger) throw new Error(`Workflow trigger not found: ${input.triggerId}`);
      const revision = this.store().getRevision(trigger.revisionId);
      if (!revision) throw new Error(`Workflow revision not found: ${trigger.revisionId}`);
      assertPrincipalScope({
        context: controlContext,
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
        trigger,
      });
      if (trigger.state === "completed" || trigger.state === "cancelled") {
        return {
          ok: true as const,
          trigger: redactTrigger(trigger, revision),
          changed: false,
        };
      }
      const changed = this.store().transitionTrigger({
        triggerId: trigger.triggerId,
        from: trigger.state,
        to: "cancelled",
        now: this.params.now?.() ?? Date.now(),
        nextFireAt: null,
      });
      const updated = this.store().getTrigger(trigger.triggerId);
      return {
        ok: true as const,
        trigger: updated ? redactTrigger(updated, revision) : null,
        changed,
      };
    }
    if (callableId === "workflow.run.trigger") {
      const definitions = await this.definitions(projectScope.canonicalRoot);
      const context = requireTrustedTriggerContext(opts?.context);
      const reviewer =
        (this.params.reviewerResolver
          ? await this.params.reviewerResolver.resolve(context)
          : null) ?? principalReviewer(context);
      const input = parseToolInput({ callableId, input: rawInput, schema: runTriggerInputSchema });
      const definition = await definitions.get({
        scope: input.scope,
        name: input.name,
        safetyMode: "trusted",
      });
      const args = validateWorkflowArgs({
        inputSchema: definition.validation.inputSchema,
        args: input.args,
        maxInputBytes: definition.validation.limits.maxInputBytes,
      });
      const snapshot = await definitions.createSnapshot(
        definition.source,
        definition.validation.sourceSha256,
      );
      const now = this.params.now?.() ?? Date.now();
      const revisionIdentity = {
        canonicalProjectId: definitions.canonicalProjectId,
        canonicalWorkspaceRoot: definitions.canonicalWorkspaceRoot,
        scope: definition.scope,
        normalizedPath: definition.normalizedPath,
        sourceSha256: definition.validation.sourceSha256,
        inputSchemaSha256: definition.validation.inputSchemaSha256,
        capabilitySha256: definition.validation.capabilitySha256,
        runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      } as const;
      const revisionId = `wfr:${canonicalJsonSha256(jsonObjectSchema.parse(revisionIdentity))}`;
      const revision: WorkflowRevision = {
        ...revisionIdentity,
        revisionId,
        name: definition.name,
        snapshotArtifactId: snapshot.artifactId,
        metadata: definition.validation.metadata,
        inputSchema: definition.validation.inputSchema,
        capabilities: definition.validation.capabilities,
        limits: definition.validation.limits,
        createdAt: now,
      };
      const idempotencyKey =
        input.idempotencyKey ??
        `tool:${context.requestId ?? "missing"}:${context.toolCallId ?? canonicalJsonSha256(args)}`;
      const invocationFingerprint = canonicalJsonSha256(
        jsonObjectSchema.parse({
          revisionId,
          args,
          progress: input.progress ?? null,
          principal: context.authenticatedPrincipal,
        }),
      );
      const runId = `wfrun:${canonicalJsonSha256(
        jsonObjectSchema.parse({ idempotencyKey, invocationFingerprint }),
      )}`;
      const requestedProgress = input.progress;
      if (
        reviewer &&
        requestedProgress?.client &&
        (requestedProgress.client !== reviewer.platform ||
          requestedProgress.sessionId !== reviewer.sessionRef.channelId)
      ) {
        throw new Error("Workflow progress must target the authenticated originating session");
      }
      const progressTarget = reviewer
        ? {
            platform: reviewer.platform,
            channelId: reviewer.sessionRef.channelId,
            replyToMessageId: reviewer.originMessageRef?.messageId ?? null,
          }
        : null;
      const run: WorkflowRun = {
        runId,
        revisionId,
        approvalId: null,
        state: "awaiting_review",
        inputSchemaSnapshot: definition.validation.inputSchema,
        args,
        argsSha256: canonicalJsonSha256(args),
        origin: {
          requestId: context.requestId ?? null,
          sessionId: context.sessionId ?? null,
          client:
            context.requestClient && isAdapterPlatform(context.requestClient)
              ? context.requestClient
              : null,
          userId: reviewer?.userId ?? null,
          safetyMode: "trusted",
          projectCwd: definitions.canonicalWorkspaceRoot,
        },
        completionTarget: progressTarget ? { kind: "durable_surface" } : { kind: "detached" },
        progressTarget,
        terminalDetail: null,
        result: null,
        resultArtifactId: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        terminalAt: null,
      };
      const approval: WorkflowApproval = {
        approvalId: `wfapproval:${crypto.randomUUID()}`,
        revisionId,
        state: "pending",
        expectedReviewerPlatform: reviewer?.platform ?? null,
        expectedReviewerUserId: reviewer?.userId ?? null,
        firstRunId: runId,
        decisionActorPlatform: null,
        decisionActorUserId: null,
        decisionSource: null,
        expiresAt: null,
        decidedAt: null,
        revokedAt: null,
        revocationReason: null,
        createdAt: now,
        updatedAt: now,
      };
      const invocation = this.store().createInvocation({
        revision,
        run,
        pendingApproval: approval,
        queueApproved: true,
        idempotency: { key: idempotencyKey, fingerprintSha256: invocationFingerprint },
      });
      let card: { platform: string; channelId: string; messageId: string } | null = null;
      if (invocation.run.progressTarget) {
        if (!this.params.progressCards) {
          throw new Error(
            `Workflow run ${invocation.run.runId} was persisted, but no progress card service is available`,
          );
        }
        card = await this.params.progressCards.ensureInitialCard(invocation.run.runId);
      }
      await this.params.bus?.publish(lilacEventTypes.EvtWorkflowRunChanged, {
        runId: invocation.run.runId,
        revisionId: invocation.revision.revisionId,
        state: invocation.run.state,
        ts: now,
      });
      await this.params.bus?.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: invocation.run.runId,
        revisionId: invocation.revision.revisionId,
        reason: "created",
        ts: now,
      });
      return {
        ok: true as const,
        runId: invocation.run.runId,
        state: invocation.run.state,
        approvalId: invocation.approval.approvalId,
        approvalState: invocation.approval.state,
        resolvedScope: definition.scope,
        path: definition.canonicalPath,
        revisionId: invocation.revision.revisionId,
        sourceSha256: invocation.revision.sourceSha256,
        inputSchemaSha256: invocation.revision.inputSchemaSha256,
        capabilitySha256: invocation.revision.capabilitySha256,
        argsSha256: invocation.run.argsSha256,
        reviewerAvailable: reviewer !== null,
        progressCard: card,
        message:
          invocation.run.state === "queued"
            ? "Exact revision grant already approved; run is queued for durable execution."
            : reviewer
              ? "Run awaits deterministic review from the authenticated originating user."
              : "Run remains awaiting_review because no authenticated originating reviewer is available.",
      };
    }
    if (callableId === "workflow.run.get") {
      const input = parseToolInput({ callableId, input: rawInput, schema: runGetInputSchema });
      const run = this.store().getRun(input.runId);
      if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
      const revision = this.store().getRevision(run.revisionId);
      if (!revision) throw new Error(`Workflow revision not found: ${run.revisionId}`);
      const approval = run.approvalId ? this.store().getApproval(run.approvalId) : null;
      assertPrincipalScope({
        context: controlContext,
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
        run,
        approval,
      });
      const fullResultAllowed = input.includeSensitiveResult;
      const worktreeOutputTotal = this.store().countWorktreeOutputs(run.runId);
      const worktreeOutputs = this.store().listWorktreeOutputs(run.runId, {
        offset: input.worktreeOutputOffset,
        limit: input.worktreeOutputLimit,
      });
      let worktreePatch:
        | {
            artifactId: string;
            encoding: "base64";
            offset: number;
            nextOffset: number | null;
            totalBytes: number;
            content: string;
          }
        | undefined;
      if (input.worktreePatchArtifactId) {
        if (!fullResultAllowed) {
          throw new Error("Worktree patch content requires includeSensitiveResult=true");
        }
        const output = this.store().getWorktreeOutputByArtifact(
          run.runId,
          input.worktreePatchArtifactId,
        );
        if (!output?.artifactId || output.bytes === null) {
          throw new Error("Workflow worktree patch artifact is not part of this run");
        }
        const patch = await readWorkflowWorktreePatch({
          dataDir: this.params.dataDir ?? env.dataDir,
          artifactId: output.artifactId,
          expectedBytes: output.bytes,
        });
        const offset = Math.min(input.worktreePatchOffset, patch.byteLength);
        const end = Math.min(offset + input.worktreePatchBytes, patch.byteLength);
        worktreePatch = {
          artifactId: output.artifactId,
          encoding: "base64",
          offset,
          nextOffset: end < patch.byteLength ? end : null,
          totalBytes: patch.byteLength,
          content: Buffer.from(patch.subarray(offset, end)).toString("base64"),
        };
      }
      return {
        ok: true as const,
        run: fullResultAllowed ? run : redactRun(run),
        revision,
        approval,
        worktreeOutputs: worktreeOutputs.map(publicWorkflowWorktreeOutput),
        worktreeOutputPage: {
          offset: input.worktreeOutputOffset,
          limit: input.worktreeOutputLimit,
          total: worktreeOutputTotal,
        },
        worktreePatch,
        source:
          input.includeSource && revision
            ? await (
                await this.definitions(projectScope.canonicalRoot)
              ).readSnapshot(revision.sourceSha256)
            : undefined,
        resultArtifact:
          input.includeResultArtifact && fullResultAllowed && run.resultArtifactId
            ? await readWorkflowValueArtifact({
                dataDir: this.params.dataDir ?? env.dataDir,
                artifactId: run.resultArtifactId,
                maxBytes: revision.limits.maxResultBytes,
              })
            : undefined,
      };
    }
    if (callableId === "workflow.run.list") {
      const input = parseToolInput({ callableId, input: rawInput, schema: runListInputSchema });
      return {
        ok: true as const,
        runs: this.store()
          .listRuns({
            ...input,
            canonicalProjectId: projectScope.canonicalProjectId,
            ...(controlContext.operator
              ? {}
              : {
                  originClient: controlContext.authenticatedPrincipal?.platform,
                  originUserId: controlContext.authenticatedPrincipal?.userId,
                }),
          })
          .map(redactRun),
      };
    }
    if (callableId === "workflow.run.cancel") {
      const input = parseToolInput({ callableId, input: rawInput, schema: runCancelInputSchema });
      const run = this.store().getRun(input.runId);
      if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
      const revision = this.store().getRevision(run.revisionId);
      if (!revision) throw new Error(`Workflow revision not found: ${run.revisionId}`);
      const approval = run.approvalId ? this.store().getApproval(run.approvalId) : null;
      assertPrincipalScope({
        context: controlContext,
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
        run,
        approval,
      });
      const terminal = ["succeeded", "failed", "rejected", "cancelled"].includes(run.state);
      if (terminal) return { ok: true as const, run: redactRun(run), changed: false };
      const now = this.params.now?.() ?? Date.now();
      const activeRequests = this.store()
        .listOperations(run.runId, { limit: 1_000 })
        .flatMap((operation) => (operation.requestId ? [operation.requestId] : []));
      const cancelled = this.store().cancelRunAndChildren({
        runId: run.runId,
        now,
        detail: input.reason ?? "Cancelled through workflow.run.cancel",
      });
      const changed = cancelled?.state === "cancelled";
      for (const requestId of activeRequests) {
        await this.params.bus?.publish(
          lilacEventTypes.CmdRequestMessage,
          { queue: "interrupt", messages: [], raw: { cancel: true, cancelQueued: true } },
          {
            headers: {
              request_id: requestId,
              session_id: `workflow:${run.runId}:cancel`,
              request_client: "unknown",
            },
          },
        );
      }
      if (changed && cancelled) {
        await this.params.bus?.publish(lilacEventTypes.EvtWorkflowRunChanged, {
          runId: cancelled.runId,
          revisionId: cancelled.revisionId,
          state: cancelled.state,
          previousState: run.state,
          detail: cancelled.terminalDetail ?? undefined,
          ts: now,
        });
        this.params.progressCards?.requestProjection(cancelled.runId);
      }
      return {
        ok: true as const,
        run: cancelled ? redactRun(cancelled) : null,
        changed,
      };
    }
    if (callableId === "workflow.run.pause" || callableId === "workflow.run.resume") {
      const schema =
        callableId === "workflow.run.pause" ? runPauseInputSchema : runResumeInputSchema;
      const input = parseToolInput({ callableId, input: rawInput, schema });
      const run = this.store().getRun(input.runId);
      if (!run) throw new Error(`Workflow run not found: ${input.runId}`);
      const revision = this.store().getRevision(run.revisionId);
      if (!revision) throw new Error(`Workflow revision not found: ${run.revisionId}`);
      const approval = run.approvalId ? this.store().getApproval(run.approvalId) : null;
      assertPrincipalScope({
        context: controlContext,
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
        run,
        approval,
      });
      const to = callableId === "workflow.run.pause" ? "paused" : "queued";
      if (to === "queued" && approval?.state !== "approved") {
        throw new Error("Cannot resume a workflow without an active exact-revision grant");
      }
      const allowed =
        to === "paused"
          ? ["queued", "running", "blocked"].includes(run.state)
          : run.state === "paused";
      if (!allowed) return { ok: true as const, run: redactRun(run), changed: false };
      const now = this.params.now?.() ?? Date.now();
      const paused =
        to === "paused"
          ? this.store().pauseRunAndChildren({
              runId: run.runId,
              now,
              detail: "Paused through workflow.run.pause",
            })
          : null;
      const changed =
        to === "paused"
          ? paused?.state === "paused"
          : this.store().transitionRun({
              runId: run.runId,
              from: run.state,
              to,
              now,
            });
      const updated = paused ?? this.store().getRun(run.runId);
      if (to === "queued" && !changed) {
        const ambiguity = this.store().getManualReconciliationDetail(run.runId);
        if (ambiguity) throw new Error(ambiguity);
      }
      if (changed && updated) {
        await this.params.bus?.publish(lilacEventTypes.EvtWorkflowRunChanged, {
          runId: updated.runId,
          revisionId: updated.revisionId,
          state: updated.state,
          previousState: run.state,
          ts: now,
        });
        this.params.progressCards?.requestProjection(updated.runId);
      }
      return {
        ok: true as const,
        run: updated ? redactRun(updated) : null,
        changed,
      };
    }
    if (callableId === "workflow.approval.revoke") {
      const input = parseToolInput({
        callableId,
        input: rawInput,
        schema: approvalRevokeInputSchema,
      });
      const approval = this.store().getApproval(input.approvalId);
      if (!approval) throw new Error(`Workflow approval not found: ${input.approvalId}`);
      const revision = this.store().getRevision(approval.revisionId);
      if (!revision) throw new Error(`Workflow revision not found: ${approval.revisionId}`);
      assertPrincipalScope({
        context: controlContext,
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
        approval,
      });
      if (approval.state !== "approved") {
        return { ok: true as const, approval, changed: false };
      }
      const now = this.params.now?.() ?? Date.now();
      const changed = this.store().transitionApproval({
        approvalId: approval.approvalId,
        from: "approved",
        to: "revoked",
        now,
        reason: input.reason ?? "Revoked through workflow.approval.revoke",
      });
      const updated = this.store().getApproval(approval.approvalId);
      await this.params.bus?.publish(lilacEventTypes.EvtWorkflowApprovalChanged, {
        approvalId: approval.approvalId,
        revisionId: approval.revisionId,
        state: "revoked",
        previousState: "approved",
        ts: now,
      });
      for (const run of this.store().listRuns({ approvalId: approval.approvalId, limit: 1_000 })) {
        this.params.progressCards?.requestProjection(run.runId);
      }
      return { ok: true as const, approval: updated, changed };
    }
    throw new Error(`Invalid callable ID '${callableId}'`);
  }
}
