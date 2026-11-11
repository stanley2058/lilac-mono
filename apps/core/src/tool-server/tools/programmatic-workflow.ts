import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@stanley2058/lilac-utils";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { Panic, Result, type Result as ResultType } from "better-result";
import type { BlobStore } from "@stanley2058/lilac-blob-storage";
import { preserveToolPanic } from "../../tools/tool-result-adapters";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { defineServerTool } from "../types";

import { isAdapterPlatform } from "../../shared/is-adapter-platform";
import {
  DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS,
  DurableWorkflowStore,
  type CreateWorkflowInvocationError,
  type DurableWorkflowReadError,
} from "../../workflow/durable-workflow-store";
import {
  canonicalJsonSha256,
  sha256,
  validateWorkflowArgsUnchecked,
  workflowDefinitionNameSchema,
  WORKFLOW_RUNTIME_VERSION,
} from "../../workflow/workflow-definition";
import { WorkflowDefinitionStore } from "../../workflow/workflow-definition-store";
import { cancelWorkflowRun } from "../../workflow/workflow-run-cancel";
import type {
  ResolvedWorkflowDefinition,
  WorkflowDefinitionStoreFailed,
} from "../../workflow/workflow-definition-store";
import { computeNextCronAtMs } from "../../workflow/cron";
import {
  jsonObjectSchema,
  workflowRunStateSchema,
  type JsonObject,
  type WorkflowRevision,
  type WorkflowRun,
  type WorkflowTrigger,
} from "../../workflow/workflow-domain";
import type { RequestContext, ServerTool } from "../types";
import type { WorkflowProgressCardService } from "../../workflow/workflow-progress-projector";
import { zodObjectToCliLines } from "./zod-cli";
import {
  readWorkflowValueArtifact,
  type WorkflowArtifactReadError,
} from "../../workflow/workflow-artifact-store";
import { redactWorkflowValue } from "../../workflow/workflow-progress-view";
import { getBuiltinSurfaceProtocol } from "../../surface/builtin-surface-protocols";
import type { RegisteredSurfacePlatform } from "../../surface/types";

function workflowFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `workflow_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

function captureWorkflowFailure(error: unknown): { readonly cause: Error | Panic } {
  if (Panic.is(error)) return { cause: error };
  if (error instanceof Error) return { cause: error };
  return { cause: new Error("Workflow operation failed", { cause: error }) };
}

function workflowRunCreatedProjectionFailure(runId: string): ServerToolFailure {
  return serverToolFailure({
    kind: "conflict",
    code: "workflow_run_created_projection_failed",
    message: `Workflow run ${runId} already exists, but its initial progress projection failed. Inspect the durable run and reconcile its projection rather than blindly retrying the trigger.`,
    retryable: false,
    details: { runId },
  });
}

function workflowDefinitionFailure(error: WorkflowDefinitionStoreFailed): ServerToolFailure {
  if (Panic.is(error)) return preserveToolPanic(error);
  const normalized = error.message.toLowerCase();
  let category: ServerToolFailure["kind"] = "unavailable";
  if (/not found|does not exist|no such file/.test(normalized)) {
    category = "not_found";
  } else if (/expectedsha256|already exists|changed|conflict/.test(normalized)) {
    category = "conflict";
  } else if (/invalid|must |cannot |exceeds |unsupported/.test(normalized)) {
    category = "usage";
  } else if (/symlink|escapes|outside|permission|denied/.test(normalized)) {
    category = "denied";
  }
  return workflowFailure(category, error.message);
}

function workflowInvocationFailure(error: CreateWorkflowInvocationError): ServerToolFailure {
  if (Panic.is(error)) return preserveToolPanic(error);
  switch (error._tag) {
    case "WorkflowInvocationConflict":
      return workflowFailure("conflict", error.message);
    case "WorkflowInvocationInvalid":
      return workflowFailure("internal", error.message);
    default:
      return workflowFailure("unavailable", error.message);
  }
}

function workflowArtifactFailure(error: WorkflowArtifactReadError): ServerToolFailure {
  if (Panic.is(error)) return preserveToolPanic(error);
  switch (error._tag) {
    case "WorkflowArtifactAbsent":
      return workflowFailure("not_found", error.message);
    case "WorkflowArtifactUnsafePath":
      return workflowFailure("denied", error.message);
    case "WorkflowArtifactInvalidId":
    case "WorkflowArtifactFileTooLarge":
      return workflowFailure("usage", error.message);
    default:
      return workflowFailure("unavailable", error.message);
  }
}

function validateWorkflowArgsResult(
  input: Parameters<typeof validateWorkflowArgsUnchecked>[0],
): ResultType<JsonObject, ServerToolFailure> {
  return validateWorkflowArgsUnchecked(input).mapError((error) => {
    if (Panic.is(error)) return preserveToolPanic(error);
    return workflowFailure("usage", error.message);
  });
}

function workflowDefinitionResult<T>(
  result: ResultType<T, WorkflowDefinitionStoreFailed>,
): ResultType<T, ServerToolFailure> {
  return result.mapError(workflowDefinitionFailure);
}

function durableWorkflowReadResult<T>(
  result: ResultType<T, DurableWorkflowReadError>,
): ResultType<T, ServerToolFailure> {
  return result.mapError((error) => {
    if (Panic.is(error)) return preserveToolPanic(error);
    return workflowFailure("unavailable", error.message);
  });
}

export function decodeWorkflowJsonObject(
  value: unknown,
): ResultType<JsonObject, ServerToolFailure> {
  const decoded = jsonObjectSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(workflowFailure("internal", "Workflow value is not a JSON object"));
}

function projectWorkflowJsonObject(value: unknown): ResultType<JsonObject, ServerToolFailure> {
  return decodeWorkflowJsonObject(value);
}

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
    client: z.string().min(1).max(200).optional(),
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

type WorkflowCallOptions = {
  readonly signal?: AbortSignal;
  readonly context?: RequestContext;
  readonly messages?: readonly unknown[];
};

function requestSessionsMatch(context: RequestContext): boolean {
  if (!context.sessionId || !context.requestInitiatorSessionId || !context.requestClient)
    return false;
  const protocol = getBuiltinSurfaceProtocol(context.requestClient);
  if (!protocol) return false;
  return (
    protocol.refs.createSessionRef(context.sessionId).channelId ===
    protocol.refs.createSessionRef(context.requestInitiatorSessionId).channelId
  );
}

function requestProgressTarget(context: RequestContext) {
  if (!context.sessionId || !context.requestClient) return null;
  const protocol = getBuiltinSurfaceProtocol(context.requestClient);
  if (!protocol) return null;
  const principal = context.requestInitiator;
  const principalMatchesRequest =
    principal !== undefined &&
    principal.platform === protocol.platform &&
    requestSessionsMatch(context);
  return {
    platform: protocol.platform,
    userId: principalMatchesRequest ? principal.userId : null,
    sessionRef: protocol.refs.createSessionRef(context.sessionId),
    originMessageRef: null,
  } as const;
}

function validateWorkflowRequestIdentity(
  context: RequestContext,
): ResultType<void, ServerToolFailure> {
  const principal = context.requestInitiator;
  if (!principal && context.requestInitiatorSessionId === undefined) {
    return Result.ok(undefined);
  }
  if (
    !principal ||
    principal.platform !== context.requestClient ||
    !context.sessionId ||
    !requestSessionsMatch(context)
  ) {
    return Result.err(
      workflowFailure(
        "denied",
        "Workflow authenticated identity does not match the request origin",
      ),
    );
  }
  return Result.ok(undefined);
}

function resolveWorkflowProgressTarget(
  progress: z.output<typeof progressInputSchema> | undefined,
  requestTarget: ReturnType<typeof requestProgressTarget>,
  explicitPlatform: RegisteredSurfacePlatform | null,
  requestPlatform: RegisteredSurfacePlatform | null,
): WorkflowRun["progressTarget"] {
  if (progress?.client && explicitPlatform) {
    return {
      platform: explicitPlatform,
      channelId: progress.sessionId!,
      replyToMessageId: null,
    };
  }
  if (!requestTarget || !requestPlatform) return null;
  return {
    platform: requestPlatform,
    channelId: requestTarget.sessionRef.channelId,
    replyToMessageId: null,
  };
}

function resolveRequestWorkflowProgressPlatform(
  progress: z.output<typeof progressInputSchema> | undefined,
  requestTarget: ReturnType<typeof requestProgressTarget>,
  progressCards: WorkflowProgressCardService | undefined,
): ResultType<RegisteredSurfacePlatform | null, ServerToolFailure> {
  if (!requestTarget) return Result.ok(null);
  const platform = progressCards?.resolveTarget(requestTarget.platform) ?? null;
  if (platform === requestTarget.platform) return Result.ok(platform);
  if (progress?.requestOrigin) {
    return Result.err(
      workflowFailure(
        "unavailable",
        `Workflow request-origin surface is not registered with a progress port: ${requestTarget.platform}`,
      ),
    );
  }
  return Result.ok(null);
}

function resolveExplicitWorkflowProgressPlatform(
  progress: z.output<typeof progressInputSchema> | undefined,
  progressCards: WorkflowProgressCardService | undefined,
): ResultType<RegisteredSurfacePlatform | null, ServerToolFailure> {
  if (!progress?.client) return Result.ok(null);
  const platform = progressCards?.resolveTarget(progress.client) ?? null;
  if (!platform || platform !== progress.client) {
    return Result.err(
      workflowFailure(
        "unavailable",
        `Workflow progress surface is not registered with a progress port: ${progress.client}`,
      ),
    );
  }
  return Result.ok(platform);
}

function resolveScheduleTiming(
  schedule: z.output<typeof scheduledTriggerDefinitionSchema>,
  now: number,
): { timestampAt: number | null; nextFireAt: number } {
  switch (schedule.kind) {
    case "timestamp": {
      const timestampAt = typeof schedule.at === "number" ? schedule.at : Date.parse(schedule.at);
      return { timestampAt, nextFireAt: timestampAt };
    }
    case "cron":
      return {
        timestampAt: null,
        nextFireAt: computeNextCronAtMs(
          {
            expr: schedule.expression,
            tz: schedule.timezone,
            startAtMs: schedule.startAt,
          },
          now,
        ),
      };
  }
}

function validateProjectScope(input: {
  canonicalProjectId: string;
  revision: WorkflowRevision;
}): ResultType<void, ServerToolFailure> {
  if (input.revision.canonicalProjectId !== input.canonicalProjectId) {
    return Result.err(
      workflowFailure("denied", "Workflow record is outside the current project scope"),
    );
  }
  return Result.ok(undefined);
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

function redactRun(run: WorkflowRun): ResultType<Record<string, unknown>, ServerToolFailure> {
  const sensitive = hasSensitiveSchema(run.inputSchemaSnapshot);
  const { argsSha256, ...safeRun } = run;
  return projectWorkflowJsonObject(redactWorkflowValue(run.args, run.inputSchemaSnapshot)).map(
    (args) => ({
      ...safeRun,
      ...(sensitive ? {} : { argsSha256 }),
      args,
    }),
  );
}

function redactTrigger(
  trigger: WorkflowTrigger,
  revision: WorkflowRevision,
): ResultType<Record<string, unknown>, ServerToolFailure> {
  const { argsSha256, ...safeTrigger } = trigger;
  const sensitive = hasSensitiveSchema(revision.inputSchema);
  return projectWorkflowJsonObject(redactWorkflowValue(trigger.args, revision.inputSchema)).map(
    (args) => ({
      ...safeTrigger,
      ...(sensitive ? {} : { argsSha256 }),
      args,
    }),
  );
}

function decodeTriggerContext(
  context: RequestContext | undefined,
): ResultType<RequestContext & { cwd: string }, ServerToolFailure> {
  if (!context?.cwd) {
    return Result.err(
      workflowFailure("usage", "workflow.run.trigger requires server-resolved request cwd"),
    );
  }
  return Result.ok({ ...context, cwd: context.cwd });
}

function validationResult(definition: ResolvedWorkflowDefinition) {
  return {
    scope: definition.scope,
    name: definition.name,
    path: definition.canonicalPath,
    normalizedPath: definition.normalizedPath,
    metadata: definition.validation.metadata,
    inputSchema: definition.validation.inputSchema,
    resources: definition.validation.resources,
    limits: definition.validation.limits,
    sensitiveFields: definition.validation.sensitiveFields,
    sourceSha256: definition.validation.sourceSha256,
    inputSchemaSha256: definition.validation.inputSchemaSha256,
    resourcePolicySha256: definition.validation.resourcePolicySha256,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    validationSummary: definition.validation.validationSummary,
  };
}

export class ProgrammaticWorkflow implements ServerTool {
  id = "workflow-programmatic";
  private readonly serverTool: ServerTool;
  private durableStore: DurableWorkflowStore | null = null;
  private ownsStore = false;
  private readonly definitionsStores = new Map<
    string,
    Promise<ResultType<WorkflowDefinitionStore, ServerToolFailure>>
  >();

  constructor(
    private readonly params: {
      dataDir?: string;
      blobStore: BlobStore;
      dbPath?: string;
      now?: () => number;
      store?: DurableWorkflowStore;
      bus?: LilacBus;
      progressCards?: WorkflowProgressCardService;
      getMaxActiveRuns?: () => number | Promise<number>;
    },
  ) {
    this.serverTool = defineServerTool({
      id: this.id,
      init: () => this.initialize(),
      destroy: () => this.destroyResources(),
      callables: ({ callable }) => ({
        "workflow.definition.save": callable({
          name: "Workflow Definition Save",
          description:
            "Statically validate and atomically save a project or personal JavaScript workflow.",
          inputSchema: definitionSaveInputSchema,
          cli: {
            input: [
              ...zodObjectToCliLines(definitionSaveInputSchema),
              "Example: tools workflow.definition.save --input=@save-workflow.json",
            ],
          },
          run: (input, opts) => this.callDefinitionSave(input, opts),
        }),
        "workflow.definition.validate": callable({
          name: "Workflow Definition Validate",
          description:
            "Resolve and statically validate a workflow, optionally validating concrete arguments.",
          inputSchema: definitionValidateInputSchema,
          cli: {
            input: [
              ...zodObjectToCliLines(definitionValidateInputSchema),
              'Example: tools workflow.definition.validate --scope=auto --name=audit-routes --args:json=\'{"directory":"src"}\'',
            ],
          },
          run: (input, opts) => this.callDefinitionValidate(input, opts),
        }),
        "workflow.definition.get": callable({
          name: "Workflow Definition Get",
          description:
            "Inspect validated definition metadata and hashes; source is opt-in and bounded.",
          inputSchema: definitionGetInputSchema,
          run: (input, opts) => this.callDefinitionGet(input, opts),
        }),
        "workflow.definition.list": callable({
          name: "Workflow Definition List",
          description:
            "List statically validated workflow definitions without importing or executing them.",
          inputSchema: definitionListInputSchema,
          run: (input, opts) => this.callDefinitionList(input, opts),
        }),
        "workflow.run.trigger": callable({
          name: "Workflow Run Trigger",
          description:
            "Persist an immutable trusted workflow invocation for immediate durable execution.",
          inputSchema: runTriggerInputSchema,
          cli: {
            input: [
              ...zodObjectToCliLines(runTriggerInputSchema),
              'Example: tools workflow.run.trigger --scope=auto --name=audit-routes --args:json=\'{"directory":"src"}\'',
            ],
          },
          run: (input, opts) => this.callRunTrigger(input, opts),
        }),
        "workflow.trigger.create": callable({
          name: "Workflow Trigger Create",
          description:
            "Pin a validated immutable workflow revision to a durable timestamp or cron trigger.",
          inputSchema: scheduledTriggerCreateInputSchema,
          run: (input, opts) => this.callTriggerCreate(input, opts),
        }),
        "workflow.trigger.get": callable({
          name: "Workflow Trigger Get",
          description: "Inspect a durable trigger and the actual state of its most recent run.",
          inputSchema: scheduledTriggerGetInputSchema,
          primaryPositional: "triggerId",
          run: (input, opts) => this.callTriggerGet(input, opts),
        }),
        "workflow.trigger.list": callable({
          name: "Workflow Trigger List",
          description: "List durable timestamp and cron triggers.",
          inputSchema: scheduledTriggerListInputSchema,
          run: (input, opts) => this.callTriggerList(input, opts),
        }),
        "workflow.trigger.cancel": callable({
          name: "Workflow Trigger Cancel",
          description: "Cancel a durable trigger without changing runs it already created.",
          inputSchema: scheduledTriggerCancelInputSchema,
          primaryPositional: "triggerId",
          run: (input, opts) => this.callTriggerCancel(input, opts),
        }),
        "workflow.run.get": callable({
          name: "Workflow Run Get",
          description: "Inspect one durable workflow run and its immutable revision.",
          inputSchema: runGetInputSchema,
          primaryPositional: "runId",
          run: (input, opts) => this.callRunGet(input, opts),
        }),
        "workflow.run.list": callable({
          name: "Workflow Run List",
          description: "List durable workflow runs, optionally filtered by state.",
          inputSchema: runListInputSchema,
          run: (input, opts) => this.callRunList(input, opts),
        }),
        "workflow.run.cancel": callable({
          name: "Workflow Run Cancel",
          description:
            "Durably cancel a non-terminal workflow run before execution or while active.",
          inputSchema: runCancelInputSchema,
          primaryPositional: "runId",
          run: (input, opts) => this.callRunCancel(input, opts),
        }),
        "workflow.run.pause": callable({
          name: "Workflow Run Pause",
          description: "Durably pause a queued or active workflow run.",
          inputSchema: runPauseInputSchema,
          primaryPositional: "runId",
          run: (input, opts) => this.callRunPause(input, opts),
        }),
        "workflow.run.resume": callable({
          name: "Workflow Run Resume",
          description: "Return a paused workflow run to the durable queue.",
          inputSchema: runResumeInputSchema,
          primaryPositional: "runId",
          run: (input, opts) => this.callRunResume(input, opts),
        }),
      }),
    });
  }

  private async initialize(): Promise<void> {
    if (!this.durableStore) {
      this.durableStore = this.params.store ?? new DurableWorkflowStore(this.params.dbPath);
      this.ownsStore = !this.params.store;
    }
  }

  private async destroyResources(): Promise<void> {
    if (this.ownsStore) this.durableStore?.close();
    this.durableStore = null;
    this.ownsStore = false;
    this.definitionsStores.clear();
  }

  async init(): Promise<void> {
    await this.serverTool.init();
  }

  async destroy(): Promise<void> {
    await this.serverTool.destroy();
  }

  async list() {
    return this.serverTool.list();
  }

  private storeResult(): ResultType<DurableWorkflowStore, ServerToolFailure> {
    if (this.durableStore) return Result.ok(this.durableStore);
    return Result.err(workflowFailure("internal", "Programmatic workflow tool is not initialized"));
  }

  private async projectScope(
    context: RequestContext | undefined,
  ): Promise<ResultType<{ canonicalRoot: string; canonicalProjectId: string }, ServerToolFailure>> {
    if (!context?.cwd) {
      return Result.err(workflowFailure("usage", "Workflow request lacks a cwd"));
    }
    const requestedRoot = path.resolve(context.cwd);
    return Result.tryPromise({
      try: async () => {
        const stats = await fs.lstat(requestedRoot);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          return Result.err(
            workflowFailure(
              "denied",
              `Workflow project root must be a real directory: ${requestedRoot}`,
            ),
          );
        }
        const canonicalRoot = await fs.realpath(requestedRoot);
        return Result.ok({
          canonicalRoot,
          canonicalProjectId: `project:${sha256(canonicalRoot)}`,
        });
      },
      catch: captureWorkflowFailure,
    }).then((captured) =>
      captured
        .mapError(({ cause }) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          const message = cause.message;
          let category: ServerToolFailure["kind"] = "unavailable";
          if (/ENOENT|not found|no such file/i.test(message)) {
            category = "not_found";
          } else if (/EACCES|EPERM|permission/i.test(message)) {
            category = "denied";
          }
          return workflowFailure(category, message);
        })
        .andThen((result) => result),
    );
  }

  private async definitions(
    canonicalRoot: string,
  ): Promise<ResultType<WorkflowDefinitionStore, ServerToolFailure>> {
    const workflowStore = this.durableStore;
    if (!workflowStore) {
      return Result.err(
        workflowFailure("internal", "Programmatic workflow tool is not initialized"),
      );
    }
    let definitions = this.definitionsStores.get(canonicalRoot);
    if (!definitions) {
      definitions = WorkflowDefinitionStore.createResult({
        workspaceRoot: canonicalRoot,
        dataDir: this.params.dataDir ?? env.dataDir,
        blobStore: this.params.blobStore,
        workflowStore,
      }).then(workflowDefinitionResult);
      this.definitionsStores.set(canonicalRoot, definitions);
      definitions.then((result) =>
        result.match({
          ok: () => undefined,
          err: () => this.definitionsStores.delete(canonicalRoot),
        }),
      );
    }
    return await definitions;
  }

  async call(
    callableId: string,
    rawInput: Record<string, unknown>,
    opts?: { signal?: AbortSignal; context?: RequestContext; messages?: readonly unknown[] },
  ): Promise<ServerToolResult> {
    return this.serverTool.call(callableId, rawInput, opts);
  }

  private async workflowCallContext(opts: WorkflowCallOptions | undefined) {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const store = yield* this.storeResult();
      const projectScope = yield* Result.await(this.projectScope(opts?.context));
      return Result.ok({ store, projectScope });
    }, this);
  }

  private async callDefinitionSave(
    input: z.output<typeof definitionSaveInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const definitions = yield* Result.await(this.definitions(projectScope.canonicalRoot));
      const saved = yield* Result.await(
        definitions.saveResult(input).then(workflowDefinitionResult),
      );
      return Result.ok({ ok: true as const, ...validationResult(saved) });
    }, this);
  }

  private async callDefinitionValidate(
    input: z.output<typeof definitionValidateInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const definitions = yield* Result.await(this.definitions(projectScope.canonicalRoot));
      const definition = yield* Result.await(
        definitions.getResult(input).then(workflowDefinitionResult),
      );
      const args = input.args
        ? yield* validateWorkflowArgsResult({
            inputSchema: definition.validation.inputSchema,
            args: input.args,
            maxInputBytes: definition.validation.limits.maxInputBytes,
          })
        : undefined;
      return Result.ok({
        ok: true as const,
        ...validationResult(definition),
        argsValid: args ? true : undefined,
      });
    }, this);
  }

  private async callDefinitionGet(
    input: z.output<typeof definitionGetInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const definitions = yield* Result.await(this.definitions(projectScope.canonicalRoot));
      const definition = yield* Result.await(
        definitions.getResult(input).then(workflowDefinitionResult),
      );
      return Result.ok({
        ok: true as const,
        ...validationResult(definition),
        source: input.includeSource ? definition.source : undefined,
      });
    }, this);
  }

  private async callDefinitionList(
    input: z.output<typeof definitionListInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const definitions = yield* Result.await(this.definitions(projectScope.canonicalRoot));
      const entries = yield* Result.await(
        definitions.listResult({ scope: input.scope }).then(workflowDefinitionResult),
      );
      return Result.ok({
        ok: true as const,
        definitions: entries.map((entry) =>
          entry.valid
            ? { valid: true as const, ...validationResult({ ...entry, source: "" }) }
            : entry,
        ),
      });
    }, this);
  }

  private async callTriggerCreate(
    input: z.output<typeof scheduledTriggerCreateInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const definitions = yield* Result.await(this.definitions(projectScope.canonicalRoot));
      const context = yield* decodeTriggerContext(opts?.context);
      yield* validateWorkflowRequestIdentity(context);
      const requestTarget = requestProgressTarget(context);
      const explicitProgressPlatform = yield* resolveExplicitWorkflowProgressPlatform(
        input.progress,
        this.params.progressCards,
      );
      const requestProgressPlatform = yield* resolveRequestWorkflowProgressPlatform(
        input.progress,
        requestTarget,
        this.params.progressCards,
      );
      const definition = yield* Result.await(
        definitions
          .getResult({ scope: input.scope, name: input.name })
          .then(workflowDefinitionResult),
      );
      const args = yield* validateWorkflowArgsResult({
        inputSchema: definition.validation.inputSchema,
        args: input.args,
        maxInputBytes: definition.validation.limits.maxInputBytes,
      });
      const snapshot = yield* Result.await(
        definitions
          .createSnapshotResult(definition.source, definition.validation.sourceSha256)
          .then(workflowDefinitionResult),
      );
      const now = this.params.now?.() ?? Date.now();
      const revisionIdentity = {
        canonicalProjectId: definitions.canonicalProjectId,
        canonicalWorkspaceRoot: definitions.canonicalWorkspaceRoot,
        scope: definition.scope,
        normalizedPath: definition.normalizedPath,
        sourceSha256: definition.validation.sourceSha256,
        inputSchemaSha256: definition.validation.inputSchemaSha256,
        resourcePolicySha256: definition.validation.resourcePolicySha256,
        runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      } as const;
      const revisionId = `wfr:${canonicalJsonSha256(yield* projectWorkflowJsonObject(revisionIdentity))}`;
      const revision: WorkflowRevision = {
        ...revisionIdentity,
        revisionId,
        name: definition.name,
        snapshotArtifact: snapshot.artifact,
        metadata: definition.validation.metadata,
        inputSchema: definition.validation.inputSchema,
        resources: definition.validation.resources,
        limits: definition.validation.limits,
        createdAt: now,
      };
      yield* Result.try({
        try: () => store.createRevision(revision),
        catch: captureWorkflowFailure,
      }).mapError(({ cause }) => {
        if (Panic.is(cause)) return preserveToolPanic(cause);
        return workflowFailure("unavailable", cause.message);
      });
      const storedRevisionResult = store.findRevisionByIdentity(revisionIdentity);
      const storedRevision = yield* durableWorkflowReadResult(storedRevisionResult);
      if (!storedRevision || storedRevision.revisionId !== revisionId) {
        return Result.err(
          workflowFailure("internal", "Scheduled workflow revision identity collision"),
        );
      }
      const idempotencyKey =
        input.idempotencyKey ??
        `tool:${context.requestId ?? "missing"}:${context.toolCallId ?? canonicalJsonSha256(args)}`;
      const triggerFingerprint = canonicalJsonSha256(
        yield* projectWorkflowJsonObject({
          revisionId,
          args,
          schedule: input.schedule,
          progress: input.progress ?? null,
        }),
      );
      const triggerId = `wftrigger:${canonicalJsonSha256(
        yield* projectWorkflowJsonObject({ idempotencyKey, triggerFingerprint }),
      )}`;
      const schedule = input.schedule;
      const { timestampAt, nextFireAt } = yield* Result.try({
        try: () => resolveScheduleTiming(schedule, now),
        catch: captureWorkflowFailure,
      }).mapError(({ cause }) => {
        if (Panic.is(cause)) return preserveToolPanic(cause);
        return workflowFailure("usage", cause.message);
      });
      if (schedule.kind === "timestamp" && !Number.isFinite(timestampAt)) {
        return Result.err(
          workflowFailure("usage", `Invalid workflow trigger timestamp: ${schedule.at}`),
        );
      }
      const progressTarget = resolveWorkflowProgressTarget(
        input.progress,
        requestTarget,
        explicitProgressPlatform,
        requestProgressPlatform,
      );
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
          client:
            context.requestClient && isAdapterPlatform(context.requestClient)
              ? context.requestClient
              : null,
          userId: requestTarget?.userId ?? null,
          projectCwd: definitions.canonicalWorkspaceRoot,
        },
        completionTarget: progressTarget ? { kind: "durable_surface" } : { kind: "detached" },
        progressTarget,
        nextFireAt,
        lastFireAt: null,
        lastRunId: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      const stored = yield* Result.try({
        try: () =>
          store.createTriggerInvocation({
            trigger,
            idempotency: { key: idempotencyKey, fingerprintSha256: triggerFingerprint },
          }),
        catch: captureWorkflowFailure,
      }).mapError(({ cause }) => {
        if (Panic.is(cause)) return preserveToolPanic(cause);
        return workflowFailure(
          /idempotency|conflict|already/i.test(cause.message) ? "conflict" : "unavailable",
          cause.message,
        );
      });
      return Result.ok({
        ok: true as const,
        trigger: yield* redactTrigger(stored.trigger, revision),
        created: stored.created,
        revisionId,
        sourceSha256: revision.sourceSha256,
        message: "The immutable revision is pinned. Every fire creates a distinct queued run.",
      });
    }, this);
  }

  private async callTriggerGet(
    input: z.output<typeof scheduledTriggerGetInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const triggerResult = store.getTrigger(input.triggerId);
      const trigger = yield* durableWorkflowReadResult(triggerResult);
      if (!trigger)
        return Result.err(
          workflowFailure("not_found", `Workflow trigger not found: ${input.triggerId}`),
        );
      const revisionResult = store.getRevision(trigger.revisionId);
      const revision = yield* durableWorkflowReadResult(revisionResult);
      if (!revision)
        return Result.err(
          workflowFailure("not_found", `Workflow revision not found: ${trigger.revisionId}`),
        );
      yield* validateProjectScope({
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
      });
      let lastRun = null;
      if (trigger.lastRunId) {
        const lastRunResult = store.getRun(trigger.lastRunId);
        const lastRunValue = yield* durableWorkflowReadResult(lastRunResult);
        lastRun = lastRunValue ? yield* redactRun(lastRunValue) : null;
      }
      return Result.ok({
        ok: true as const,
        trigger: yield* redactTrigger(trigger, revision),
        lastRun,
      });
    }, this);
  }

  private async callTriggerList(
    input: z.output<typeof scheduledTriggerListInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const triggersResult = store.listTriggers({
        ...input,
        canonicalProjectId: projectScope.canonicalProjectId,
      });
      const triggers = yield* durableWorkflowReadResult(triggersResult);
      const projected = [];
      for (const trigger of triggers) {
        const revisionResult = store.getRevision(trigger.revisionId);
        const revision = yield* durableWorkflowReadResult(revisionResult);
        if (!revision) {
          return Result.err(
            workflowFailure("not_found", `Workflow revision not found: ${trigger.revisionId}`),
          );
        }
        const lastRunResult = trigger.lastRunId ? store.getRun(trigger.lastRunId) : Result.ok(null);
        const lastRun = yield* durableWorkflowReadResult(lastRunResult);
        projected.push({
          trigger: yield* redactTrigger(trigger, revision),
          lastRun: lastRun ? yield* redactRun(lastRun) : null,
        });
      }
      return Result.ok({
        ok: true as const,
        triggers: projected,
      });
    }, this);
  }

  private async callTriggerCancel(
    input: z.output<typeof scheduledTriggerCancelInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const triggerResult = store.getTrigger(input.triggerId);
      const trigger = yield* durableWorkflowReadResult(triggerResult);
      if (!trigger)
        return Result.err(
          workflowFailure("not_found", `Workflow trigger not found: ${input.triggerId}`),
        );
      const revisionResult = store.getRevision(trigger.revisionId);
      const revision = yield* durableWorkflowReadResult(revisionResult);
      if (!revision)
        return Result.err(
          workflowFailure("not_found", `Workflow revision not found: ${trigger.revisionId}`),
        );
      yield* validateProjectScope({
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
      });
      if (trigger.state === "completed" || trigger.state === "cancelled") {
        return Result.ok({
          ok: true as const,
          trigger: yield* redactTrigger(trigger, revision),
          changed: false,
        });
      }
      const changed = store.transitionTrigger({
        triggerId: trigger.triggerId,
        from: trigger.state,
        to: "cancelled",
        now: this.params.now?.() ?? Date.now(),
        nextFireAt: null,
      });
      const updatedResult = store.getTrigger(trigger.triggerId);
      const updated = yield* durableWorkflowReadResult(updatedResult);
      return Result.ok({
        ok: true as const,
        trigger: updated ? yield* redactTrigger(updated, revision) : null,
        changed,
      });
    }, this);
  }

  private async callRunTrigger(
    input: z.output<typeof runTriggerInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const definitions = yield* Result.await(this.definitions(projectScope.canonicalRoot));
      const context = yield* decodeTriggerContext(opts?.context);
      yield* validateWorkflowRequestIdentity(context);
      const requestTarget = requestProgressTarget(context);
      const explicitProgressPlatform = yield* resolveExplicitWorkflowProgressPlatform(
        input.progress,
        this.params.progressCards,
      );
      const requestProgressPlatform = yield* resolveRequestWorkflowProgressPlatform(
        input.progress,
        requestTarget,
        this.params.progressCards,
      );
      const definition = yield* Result.await(
        definitions
          .getResult({ scope: input.scope, name: input.name })
          .then(workflowDefinitionResult),
      );
      const args = yield* validateWorkflowArgsResult({
        inputSchema: definition.validation.inputSchema,
        args: input.args,
        maxInputBytes: definition.validation.limits.maxInputBytes,
      });
      const snapshot = yield* Result.await(
        definitions
          .createSnapshotResult(definition.source, definition.validation.sourceSha256)
          .then(workflowDefinitionResult),
      );
      const now = this.params.now?.() ?? Date.now();
      const revisionIdentity = {
        canonicalProjectId: definitions.canonicalProjectId,
        canonicalWorkspaceRoot: definitions.canonicalWorkspaceRoot,
        scope: definition.scope,
        normalizedPath: definition.normalizedPath,
        sourceSha256: definition.validation.sourceSha256,
        inputSchemaSha256: definition.validation.inputSchemaSha256,
        resourcePolicySha256: definition.validation.resourcePolicySha256,
        runtimeVersion: WORKFLOW_RUNTIME_VERSION,
      } as const;
      const revisionId = `wfr:${canonicalJsonSha256(yield* projectWorkflowJsonObject(revisionIdentity))}`;
      const revision: WorkflowRevision = {
        ...revisionIdentity,
        revisionId,
        name: definition.name,
        snapshotArtifact: snapshot.artifact,
        metadata: definition.validation.metadata,
        inputSchema: definition.validation.inputSchema,
        resources: definition.validation.resources,
        limits: definition.validation.limits,
        createdAt: now,
      };
      const idempotencyKey =
        input.idempotencyKey ??
        `tool:${context.requestId ?? "missing"}:${context.toolCallId ?? canonicalJsonSha256(args)}`;
      const invocationFingerprint = canonicalJsonSha256(
        yield* projectWorkflowJsonObject({
          revisionId,
          args,
          progress: input.progress ?? null,
        }),
      );
      const runId = `wfrun:${canonicalJsonSha256(
        yield* projectWorkflowJsonObject({ idempotencyKey, invocationFingerprint }),
      )}`;
      const progressTarget = resolveWorkflowProgressTarget(
        input.progress,
        requestTarget,
        explicitProgressPlatform,
        requestProgressPlatform,
      );
      const run: WorkflowRun = {
        runId,
        revisionId,
        state: "queued",
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
          userId: requestTarget?.userId ?? null,
          projectCwd: definitions.canonicalWorkspaceRoot,
        },
        completionTarget: progressTarget ? { kind: "durable_surface" } : { kind: "detached" },
        progressTarget,
        terminalDetail: null,
        result: null,
        resultArtifact: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        terminalAt: null,
      };
      const maxActiveRuns = yield* Result.await(
        Result.tryPromise({
          try: async () =>
            (await this.params.getMaxActiveRuns?.()) ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS,
          catch: captureWorkflowFailure,
        }).then((result) =>
          result.mapError(({ cause }) => {
            if (Panic.is(cause)) return preserveToolPanic(cause);
            return workflowFailure("unavailable", cause.message);
          }),
        ),
      );
      const invocation = yield* store
        .createInvocation({
          revision,
          run,
          idempotency: { key: idempotencyKey, fingerprintSha256: invocationFingerprint },
          maxActiveRuns,
        })
        .mapError(workflowInvocationFailure);
      if (invocation.status === "rejected_capacity") {
        return Result.err(
          serverToolFailure({
            kind: "unavailable",
            code: "workflow_capacity_exceeded",
            message: `Global workflow capacity is full (${invocation.activeRuns}/${invocation.limit} active runs). Wait for a workflow to finish or cancel one, then retry with the same idempotency key.`,
            retryable: true,
            details: { activeRuns: invocation.activeRuns, limit: invocation.limit },
          }),
        );
      }
      let card: { platform: string; channelId: string; messageId: string } | null = null;
      if (invocation.run.progressTarget) {
        if (!this.params.progressCards) {
          return Result.err(workflowRunCreatedProjectionFailure(invocation.run.runId));
        }
        card = yield* Result.await(
          Result.tryPromise({
            try: () => this.params.progressCards!.ensureInitialCard(invocation.run.runId),
            catch: captureWorkflowFailure,
          }).then((result) =>
            result.mapError(({ cause }) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return workflowRunCreatedProjectionFailure(invocation.run.runId);
            }),
          ),
        );
      }
      if (this.params.bus) {
        yield* Result.await(
          this.params.bus
            .publish(lilacEventTypes.EvtWorkflowRunChanged, {
              runId: invocation.run.runId,
              revisionId: invocation.revision.revisionId,
              state: invocation.run.state,
              ts: now,
            })
            .then((result) =>
              result.mapError((error) => {
                if (Panic.is(error)) return preserveToolPanic(error);
                return workflowRunCreatedProjectionFailure(invocation.run.runId);
              }),
            ),
        );
        yield* Result.await(
          this.params.bus
            .publish(lilacEventTypes.EvtWorkflowProgressRequested, {
              runId: invocation.run.runId,
              revisionId: invocation.revision.revisionId,
              reason: "created",
              ts: now,
            })
            .then((result) =>
              result.mapError((error) => {
                if (Panic.is(error)) return preserveToolPanic(error);
                return workflowRunCreatedProjectionFailure(invocation.run.runId);
              }),
            ),
        );
      }
      return Result.ok({
        ok: true as const,
        runId: invocation.run.runId,
        state: invocation.run.state,
        resolvedScope: definition.scope,
        path: definition.canonicalPath,
        revisionId: invocation.revision.revisionId,
        sourceSha256: invocation.revision.sourceSha256,
        inputSchemaSha256: invocation.revision.inputSchemaSha256,
        resourcePolicySha256: invocation.revision.resourcePolicySha256,
        argsSha256: invocation.run.argsSha256,
        progressCard: card,
        message: "Workflow invocation is queued for durable execution.",
      });
    }, this);
  }

  private async callRunGet(
    input: z.output<typeof runGetInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const runResult = store.getRun(input.runId);
      const run = yield* durableWorkflowReadResult(runResult);
      if (!run)
        return Result.err(workflowFailure("not_found", `Workflow run not found: ${input.runId}`));
      const revisionResult = store.getRevision(run.revisionId);
      const revision = yield* durableWorkflowReadResult(revisionResult);
      if (!revision)
        return Result.err(
          workflowFailure("not_found", `Workflow revision not found: ${run.revisionId}`),
        );
      yield* validateProjectScope({
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
      });
      let resultArtifact;
      if (input.includeResultArtifact && run.resultArtifact) {
        const loaded = await readWorkflowValueArtifact({
          blobStore: this.params.blobStore,
          reference: run.resultArtifact,
          maxBytes: revision.limits.maxResultBytes,
        });
        resultArtifact = yield* loaded.mapError(workflowArtifactFailure);
      }
      const source = input.includeSource
        ? yield* Result.await(
            (yield* Result.await(this.definitions(projectScope.canonicalRoot)))
              .readSnapshotResult(revision.snapshotArtifact)
              .then(workflowDefinitionResult),
          )
        : undefined;
      return Result.ok({
        ok: true as const,
        run: yield* redactRun(run),
        revision,
        source,
        resultArtifact,
      });
    }, this);
  }

  private async callRunList(
    input: z.output<typeof runListInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const runs = store.listRuns({
        ...input,
        canonicalProjectId: projectScope.canonicalProjectId,
      });
      const runValues = yield* durableWorkflowReadResult(runs);
      const projected = [];
      for (const run of runValues) projected.push(yield* redactRun(run));
      return Result.ok({
        ok: true as const,
        runs: projected,
      });
    }, this);
  }

  private async callRunCancel(
    input: z.output<typeof runCancelInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const runResult = store.getRun(input.runId);
      const run = yield* durableWorkflowReadResult(runResult);
      if (!run)
        return Result.err(workflowFailure("not_found", `Workflow run not found: ${input.runId}`));
      const revisionResult = store.getRevision(run.revisionId);
      const revision = yield* durableWorkflowReadResult(revisionResult);
      if (!revision)
        return Result.err(
          workflowFailure("not_found", `Workflow revision not found: ${run.revisionId}`),
        );
      yield* validateProjectScope({
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
      });
      const { run: cancelled, changed } = yield* Result.await(
        cancelWorkflowRun({
          store,
          ...(this.params.bus ? { bus: this.params.bus } : {}),
          ...(this.params.progressCards ? { progressCards: this.params.progressCards } : {}),
          run,
          detail: input.reason ?? "Cancelled through workflow.run.cancel",
          now: this.params.now?.() ?? Date.now(),
        }).then((result) =>
          result.mapError((error) => {
            if (Panic.is(error)) return preserveToolPanic(error);
            return workflowFailure("unavailable", error.message);
          }),
        ),
      );
      return Result.ok({
        ok: true as const,
        run: cancelled ? yield* redactRun(cancelled) : null,
        changed,
      });
    }, this);
  }

  private callRunPause(
    input: z.output<typeof runPauseInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ) {
    return this.callRunPauseState(input, opts, "paused");
  }

  private callRunResume(
    input: z.output<typeof runResumeInputSchema>,
    opts: WorkflowCallOptions | undefined,
  ) {
    return this.callRunPauseState(input, opts, "queued");
  }

  private async callRunPauseState(
    input: z.output<typeof runPauseInputSchema>,
    opts: WorkflowCallOptions | undefined,
    to: "paused" | "queued",
  ): Promise<ServerToolResult> {
    return Result.gen(async function* (this: ProgrammaticWorkflow) {
      const { store, projectScope } = yield* Result.await(this.workflowCallContext(opts));
      const runResult = store.getRun(input.runId);
      const run = yield* durableWorkflowReadResult(runResult);
      if (!run)
        return Result.err(workflowFailure("not_found", `Workflow run not found: ${input.runId}`));
      const revisionResult = store.getRevision(run.revisionId);
      const revision = yield* durableWorkflowReadResult(revisionResult);
      if (!revision)
        return Result.err(
          workflowFailure("not_found", `Workflow revision not found: ${run.revisionId}`),
        );
      yield* validateProjectScope({
        canonicalProjectId: projectScope.canonicalProjectId,
        revision,
      });
      const allowed =
        to === "paused"
          ? ["queued", "running", "blocked"].includes(run.state)
          : run.state === "paused";
      if (!allowed)
        return Result.ok({ ok: true as const, run: yield* redactRun(run), changed: false });
      const now = this.params.now?.() ?? Date.now();
      const paused =
        to === "paused"
          ? store.pauseRunAndChildren({
              runId: run.runId,
              now,
              detail: "Paused through workflow.run.pause",
            })
          : null;
      const changed =
        to === "paused"
          ? paused?.state === "paused"
          : store.transitionRun({
              runId: run.runId,
              from: run.state,
              to,
              now,
            });
      const updatedResult = paused === null ? store.getRun(run.runId) : Result.ok(paused);
      const updated = yield* durableWorkflowReadResult(updatedResult);
      if (to === "queued" && !changed) {
        const ambiguity = store.getManualReconciliationDetail(run.runId);
        if (ambiguity) return Result.err(workflowFailure("conflict", ambiguity));
      }
      if (changed && updated) {
        if (this.params.bus) {
          yield* Result.await(
            this.params.bus
              .publish(lilacEventTypes.EvtWorkflowRunChanged, {
                runId: updated.runId,
                revisionId: updated.revisionId,
                state: updated.state,
                previousState: run.state,
                ts: now,
              })
              .then((result) =>
                result.mapError((error) => {
                  if (Panic.is(error)) return preserveToolPanic(error);
                  return workflowFailure("unavailable", error.message);
                }),
              ),
          );
        }
        this.params.progressCards?.requestProjection(updated.runId);
      }
      return Result.ok({
        ok: true as const,
        run: updated ? yield* redactRun(updated) : null,
        changed,
      });
    }, this);
  }
}
