import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import {
  subagentDelegateBaseInputSchema,
  subagentDelegateOutputSchema,
  subagentTerminalStatusSchema,
  type SubagentDelegateOutput,
  type SubagentMode,
  type SubagentProfile,
} from "@stanley2058/lilac-coding-tools/schemas";
import {
  projectModelCatalog,
  createLogger,
  formatTaggedErrorForLog,
  isPermissionProfileWithin,
  opaqueErrorMessage,
  MODEL_REASONING_EFFORTS,
  resolveSubagentPermissionProfile,
  type CoreConfig,
  type ModelReasoningEffort,
  type ResolvedSubagentPermissionProfile,
  type SubagentPermissionProfileConfig,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { getBuiltinSurfaceProtocol } from "../surface/builtin-surface-protocols";
import type { SurfaceProtocolRouting } from "../surface/protocol";
import type {
  AuthenticatedSurfaceOrigin,
  AuthenticatedSurfaceOriginFor,
  RegisteredSurfacePlatform,
  SurfacePrincipal,
} from "../surface/types";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

const modelReasoningEffortSchema = z.enum(MODEL_REASONING_EFFORTS);

type AgentSelectableModelPreset = {
  model: string;
  reasoning?: ModelReasoningEffort;
  comment?: string;
  agentCanSelect?: boolean;
};

type SubagentDelegateInput = z.input<typeof subagentDelegateBaseInputSchema> & {
  model?: string;
  reasoning?: ModelReasoningEffort;
  permissions?: string;
};

type ParsedSubagentDelegateInput = z.output<typeof subagentDelegateBaseInputSchema> & {
  model?: string;
  reasoning?: ModelReasoningEffort;
  permissions?: string;
};

function isSelectableModelPreset(entry: readonly [string, AgentSelectableModelPreset]): boolean {
  const [alias, preset] = entry;
  return preset.agentCanSelect === true && !alias.includes("/") && /^[^/]+\/.+/u.test(preset.model);
}

function describePermissionProfile(
  name: string,
  profile: Readonly<SubagentPermissionProfileConfig>,
): string {
  const bash = profile.execution === false ? "no bash" : `${profile.execution} bash`;
  return [
    `- ${name}:`,
    profile.workspaceWrites ? "workspace writes," : "no workspace writes,",
    profile.network ? "network," : "no network,",
    `${bash},`,
    profile.delegation ? "can delegate" : "cannot delegate",
  ].join(" ");
}

function createSubagentDelegateInputSchema(params: {
  selectableModels: ReadonlyArray<readonly [string, AgentSelectableModelPreset]>;
  permissionProfiles: ReadonlyArray<ResolvedSubagentPermissionProfile>;
  defaultPermissionProfile: string;
  catalogSelection?: boolean;
}): z.ZodType<ParsedSubagentDelegateInput> {
  const { selectableModels, permissionProfiles } = params;
  const documentedModels = selectableModels.slice(0, 5).map(([alias, preset]) => {
    const detail = preset.comment?.trim()
      ? truncateEnd(normalizeToolDisplay(preset.comment), 240)
      : `${preset.model}${preset.reasoning ? `; default reasoning: ${preset.reasoning}` : ""}`;
    return `- ${alias}: ${detail}`;
  });
  let configuredAliasDescription =
    "No agent-selectable model aliases are configured; omit this field.";
  if (selectableModels.length > 0) {
    const qualifier =
      selectableModels.length > 5 ? " (first 5 documented; all aliases are in the enum)" : "";
    configuredAliasDescription = `Configured aliases${qualifier}:\n${documentedModels.join("\n")}`;
  }
  const modelDescription = [
    "Optional agent-selectable alias from models.def. Direct provider/model values are not accepted. When omitted, the main model runs the child.",
    configuredAliasDescription,
  ].join("\n");

  const permissionNames = permissionProfiles.map((profile) => profile.name);
  const permissionsDescription = [
    `Optional permission profile for the child. When omitted, ${params.defaultPermissionProfile} applies. Only profiles within this run's own authority are listed.`,
    ...permissionProfiles.map((profile) => describePermissionProfile(profile.name, profile)),
  ].join("\n");

  let schema = subagentDelegateBaseInputSchema as z.ZodType<ParsedSubagentDelegateInput>;
  if (permissionNames.length > 0) {
    const [firstName, ...remainingNames] = permissionNames;
    schema = subagentDelegateBaseInputSchema.extend({
      permissions: z
        .enum([firstName!, ...remainingNames])
        .optional()
        .describe(permissionsDescription),
    });
  }

  if (params.catalogSelection)
    return (schema as typeof subagentDelegateBaseInputSchema).extend({
      model: z
        .string()
        .optional()
        .describe(
          "Model alias or provider/model from model_catalog. Omit to use the main model. Choose a model suited to this task.",
        ),
      reasoning: modelReasoningEffortSchema
        .optional()
        .describe("Optional reasoning setting supported by the selected model."),
    });
  if (selectableModels.length === 0) return schema;

  const [firstAlias, ...remainingAliases] = selectableModels.map(([alias]) => alias);
  return (schema as typeof subagentDelegateBaseInputSchema).extend({
    model: z
      .enum([firstAlias!, ...remainingAliases])
      .optional()
      .describe(modelDescription),
    reasoning: modelReasoningEffortSchema
      .optional()
      .describe(
        "Optional reasoning-effort override for this child run. When omitted, the selected alias default applies.",
      ),
  });
}

/** Profiles a run may grant to its children: every profile for primary, otherwise those within its own. */
export function delegablePermissionProfiles(
  config: CoreConfig,
  currentRunProfile: string,
): ResolvedSubagentPermissionProfile[] {
  const configured = Object.keys(config.agent.subagents.permissions).map((name) =>
    resolveSubagentPermissionProfile(config, name),
  );
  if (currentRunProfile === "primary") return configured;
  const parent = resolveSubagentPermissionProfile(config, currentRunProfile);
  return configured.filter((profile) => isPermissionProfileWithin(profile, parent));
}

type SubagentTerminalStatus = z.infer<typeof subagentTerminalStatusSchema>;
export type { SubagentDelegateOutput, SubagentMode, SubagentProfile };

type ChildToolStatus = "running" | "done";

export type ChildToolState = {
  toolCallId: string;
  status: ChildToolStatus;
  ok: boolean | null;
  display: string;
  updatedSeq: number;
};

type RequestContextLike = {
  requestId: string;
  sessionId: string;
  requestClient: string;
  subagentDepth?: number | string;
  subagentProfile?: string;
  requestInitiator?: SurfacePrincipal;
  requestInitiatorSessionId?: string;
};

const requestContextSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  requestClient: z.string(),
  subagentDepth: z.union([z.number(), z.string()]).optional(),
  subagentProfile: z.string().optional(),
  requestInitiator: z
    .object({ platform: z.string().trim().min(1), userId: z.string().trim().min(1) })
    .optional(),
  requestInitiatorSessionId: z.string().trim().min(1).optional(),
});

class SubagentDelegationError extends TaggedError("SubagentDelegationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

function signalSubagentFailure(operation: string, message: string): never {
  return adaptToolResultToHost(
    Result.err(new SubagentDelegationError({ operation, cause: new Error(message), message })),
  );
}

async function captureSubagentOperation<T>(params: {
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, SubagentDelegationError>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque subagent ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, SubagentDelegationError>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      return Result.err(
        new SubagentDelegationError({
          operation: params.operation,
          cause,
          message: opaqueErrorMessage(cause, `Subagent ${params.operation} failed`),
        }),
      );
    },
  })();
}

function decodeRequestContext(
  context: unknown,
): ResultType<RequestContextLike, SubagentDelegationError> {
  const decoded = requestContextSchema.safeParse(context);
  if (decoded.success) {
    const initiator = decoded.data.requestInitiator;
    const { requestInitiator: _, ...common } = decoded.data;
    if (!initiator) return Result.ok(common);
    const protocol = getBuiltinSurfaceProtocol(initiator.platform);
    if (protocol) {
      return Result.ok({
        ...common,
        requestInitiator: {
          platform: protocol.platform,
          userId: initiator.userId,
        },
      });
    }
  }
  return Result.err(
    new SubagentDelegationError({
      operation: "decode_context",
      cause: decoded.error,
      message: "subagent_delegate requires request context",
    }),
  );
}

function createAuthenticatedSurfaceOrigin<P extends RegisteredSurfacePlatform>(
  protocol: SurfaceProtocolRouting<P>,
  userId: string,
  sessionId: string,
): AuthenticatedSurfaceOriginFor<P> {
  return {
    platform: protocol.platform,
    userId,
    sessionRef: protocol.refs.createSessionRef(sessionId),
  };
}

export function parseSubagentDepth(ctx: RequestContextLike): number {
  const raw = ctx.subagentDepth;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw));
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }
  return 0;
}

function toAdapterPlatform(value: string): AdapterPlatform {
  switch (value) {
    case "discord":
    case "github":
    case "whatsapp":
    case "slack":
    case "telegram":
    case "web":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

function generateSessionName(profile: SubagentProfile): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${profile}-${token}`;
}

function truncateEnd(input: string, maxLen: number): string {
  if (input.length <= maxLen) return input;
  if (maxLen <= 3) return "...".slice(0, maxLen);
  return input.slice(0, maxLen - 3) + "...";
}

function normalizeToolDisplay(display: string): string {
  return display
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function childToolIcon(state: ChildToolState): string {
  if (state.status === "running") return ">";
  if (state.ok) return "+";
  return "x";
}

export function renderSubagentDisplay(params: {
  profile: SubagentProfile;
  children: ReadonlyMap<string, ChildToolState>;
  model?: string;
  reasoning?: ModelReasoningEffort;
}): string {
  const children = Array.from(params.children.values());
  const total = children.length;
  const done = children.filter((c) => c.status === "done").length;
  let model: string | null = null;
  if (params.model) {
    model = params.reasoning ? `${params.model} [${params.reasoning}]` : params.model;
  }
  const header = `subagent (${[params.profile, model, `${done}/${total} done`]
    .filter((part): part is string => part !== null)
    .join("; ")})`;

  if (children.length === 0) return header;

  const recent = children
    .filter((c) => c.updatedSeq > 0)
    .sort((a, b) => b.updatedSeq - a.updatedSeq)
    .slice(0, 3)
    .sort((a, b) => a.updatedSeq - b.updatedSeq);

  if (recent.length === 0) return header;

  const lines = recent.map((c, idx) => {
    const branch = idx === recent.length - 1 ? "`-" : "|-";
    const display = normalizeToolDisplay(c.display || "tool");
    return `${branch} ${childToolIcon(c)} ${truncateEnd(display, 120)}`;
  });

  return [header, ...lines].join("\n");
}

function buildDelegatedTaskPrompt(task: string): ModelMessage {
  return {
    role: "user",
    content: task,
  };
}

export type SubagentDelegationRegistration = {
  mode: SubagentMode;
  profile: SubagentProfile;
  sessionName: string;
  stableNamedContinuation: true;
  task: string;
  title?: string;
  idleTimeoutMs: number;
  depth: number;
  parentRequestId: string;
  parentSessionId: string;
  parentRequestClient: string;
  parentToolCallId: string;
  childRequestId: string;
  childSessionId: string;
  parentHeaders: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
  };
  childHeaders: {
    request_id: string;
    session_id: string;
    request_client: "unknown";
    parent_request_id: string;
    parent_tool_call_id: string;
    subagent_profile: SubagentProfile;
    subagent_depth: string;
  };
  initialMessages: ModelMessage[];
  modelOverride?: string;
  reasoningOverride?: ModelReasoningEffort;
  authenticatedOrigin?: AuthenticatedSurfaceOrigin;
};

export type SubagentRequestContext = RequestContextLike;

/** Builds the child request, session, and headers for one subagent assignment. */
export function buildSubagentDelegationRegistration(input: {
  readonly ctx: SubagentRequestContext;
  readonly toolCallId: string;
  readonly mode: SubagentMode;
  readonly profile: SubagentProfile;
  readonly sessionName: string;
  readonly task: string;
  readonly title?: string;
  readonly idleTimeoutMs: number;
  /** The child's depth. */
  readonly depth: number;
  readonly modelOverride?: string;
  readonly reasoningOverride?: ModelReasoningEffort;
  /** A stable child request ID for a keyed follow-up; otherwise each assignment gets a new one. */
  readonly childRequestId?: string;
}): SubagentDelegationRegistration {
  const { ctx, toolCallId, profile, sessionName } = input;
  const childRequestId = input.childRequestId ?? `sub:${ctx.requestId}:${crypto.randomUUID()}`;
  const childSessionId = `sub:${ctx.sessionId}:named:${sessionName}`;
  let authenticatedOrigin: AuthenticatedSurfaceOrigin | undefined;
  if (ctx.requestInitiator && ctx.requestInitiatorSessionId) {
    const protocol = getBuiltinSurfaceProtocol(ctx.requestInitiator.platform);
    authenticatedOrigin = createAuthenticatedSurfaceOrigin(
      protocol,
      ctx.requestInitiator.userId,
      ctx.requestInitiatorSessionId,
    );
  }
  return {
    mode: input.mode,
    profile,
    sessionName,
    stableNamedContinuation: true,
    task: input.task,
    title: input.title,
    idleTimeoutMs: input.idleTimeoutMs,
    depth: input.depth,
    parentRequestId: ctx.requestId,
    parentSessionId: ctx.sessionId,
    parentRequestClient: ctx.requestClient,
    parentToolCallId: toolCallId,
    childRequestId,
    childSessionId,
    parentHeaders: {
      request_id: ctx.requestId,
      session_id: ctx.sessionId,
      request_client: toAdapterPlatform(ctx.requestClient),
    },
    childHeaders: {
      request_id: childRequestId,
      session_id: childSessionId,
      request_client: "unknown",
      parent_request_id: ctx.requestId,
      parent_tool_call_id: toolCallId,
      subagent_profile: profile,
      subagent_depth: String(input.depth),
    },
    initialMessages: [buildDelegatedTaskPrompt(input.task)],
    ...(authenticatedOrigin ? { authenticatedOrigin } : {}),
    modelOverride: input.modelOverride,
    reasoningOverride: input.reasoningOverride,
  };
}

export type TrustedSubagentDelegationRegistration = SubagentDelegationRegistration & {
  projectRoot: string;
  // Heartbeat has no surface principal; null preserves its authority through workflow recovery.
  fallbackSurface: {
    platform: SurfacePrincipal["platform"];
    sessionId: string;
    userId: string;
  } | null;
};

export type SubagentDelegationOutcome = {
  status: SubagentTerminalStatus;
  finalText: string;
  detail?: string;
};

export type SubagentDelegationHandle = {
  runId: string;
  completion: Promise<SubagentDelegationOutcome>;
  cancel(detail: string): Promise<void>;
};

export function subagentTools(params: {
  idleTimeoutMs: number;
  maxDepth: number;
  /** "primary" or the delegating run's permission profile name. */
  runProfile: string;
  config: CoreConfig;
  modelPresets?: Readonly<Record<string, AgentSelectableModelPreset>>;
  delegatePromptOverlay?: string;
  /** The run also has the orchestrate tool for reading, messaging, and stopping children. */
  orchestrateAvailable?: boolean;
  onDelegate?: (registration: SubagentDelegationRegistration) => Promise<SubagentDelegationHandle>;
}) {
  const selectableModels = Object.entries(params.modelPresets ?? {}).filter(
    isSelectableModelPreset,
  );
  const selectableModelAliases = new Set(selectableModels.map(([alias]) => alias));
  const permissionProfiles = delegablePermissionProfiles(params.config, params.runProfile);
  const delegableProfileNames = new Set(permissionProfiles.map((profile) => profile.name));
  // The version-owned default applies whenever this run may grant it; a
  // narrower run falls back to its own profile.
  const versionDefault = params.config.agent.subagents.defaultPermissions;
  const defaultPermissionProfile = delegableProfileNames.has(versionDefault)
    ? versionDefault
    : resolveSubagentPermissionProfile(params.config, params.runProfile).name;
  const inputSchema = createSubagentDelegateInputSchema({
    selectableModels,
    permissionProfiles,
    defaultPermissionProfile,
    catalogSelection: params.config.configVersion === 3,
  });
  const description = [
    "Delegate a task to a subagent. Pick a model alias and, optionally, a permission profile.",
    "The subagent does not see this conversation or the user's persona files. Write the task with the context it needs.",
    "Use deferred mode by default.",
    "Use sync mode only when you need the result before the next useful action.",
    "Deferred acceptance means that the subagent started. It does not mean that the task is complete.",
    "After a deferred launch, do all work that does not need the subagent result.",
    "When no such work remains, reply with exactly NO_REPLY and end the turn.",
    ...(params.orchestrateAvailable
      ? [
          "The result's workflowRunId identifies this assignment. Pass it to orchestrate to read the subagent's progress, send it a message, or interrupt it.",
          "To continue a finished subagent's conversation, use orchestrate send with that id; this tool always starts a new subagent.",
        ]
      : ["Do not call tools only to wait or check the subagent status."]),
    "The runtime keeps the request open. It resumes you when a subagent_result arrives.",
    "Wait for all deferred results before you send the final response to the user.",
    "Use all relevant subagent results in the final response.",
    params.delegatePromptOverlay?.trim(),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const logger = createLogger({
    module: "tool:subagent_delegate",
  });

  return {
    subagent_delegate: tool({
      description,
      inputSchema,
      outputSchema: subagentDelegateOutputSchema,
      execute: async (input: SubagentDelegateInput, { abortSignal, context, toolCallId }) => {
        const requestedModel = input.model;
        if (
          params.config.configVersion !== 3 &&
          requestedModel !== undefined &&
          !selectableModelAliases.has(requestedModel)
        ) {
          signalSubagentFailure(
            "validate_input",
            `Model alias '${requestedModel}' is not available for agent selection`,
          );
        }
        if (
          params.config.configVersion === 3 &&
          (requestedModel !== undefined || input.reasoning !== undefined)
        ) {
          const selected = projectModelCatalog(params.config).find(
            (entry) => entry.id === (requestedModel ?? params.config.models.main.model),
          );
          if (
            !selected ||
            (input.reasoning !== undefined && !selected.reasoning.includes(input.reasoning))
          )
            signalSubagentFailure(
              "validate_input",
              "Model or reasoning setting is unavailable; use model_catalog",
            );
        }
        if (input.permissions !== undefined && !delegableProfileNames.has(input.permissions)) {
          signalSubagentFailure(
            "authorize_delegation",
            `Permission profile '${input.permissions}' is not within this run's authority`,
          );
        }
        if (
          params.config.configVersion !== 3 &&
          input.reasoning !== undefined &&
          selectableModels.length === 0
        ) {
          signalSubagentFailure(
            "validate_input",
            "Reasoning override requires an agent-selectable model alias",
          );
        }
        const decodedInput = inputSchema.safeParse(input);
        if (!decodedInput.success) {
          signalSubagentFailure("decode_input", decodedInput.error.message);
        }
        const parsed = decodedInput.data;
        const decodedContext = decodeRequestContext(context);
        const ctx = adaptToolResultToHost(decodedContext);
        const profile = parsed.permissions ?? defaultPermissionProfile;
        const mode = parsed.mode;
        const depth = parseSubagentDepth(ctx);

        if (!delegableProfileNames.has(profile)) {
          signalSubagentFailure(
            "authorize_delegation",
            `Permission profile '${profile}' is not within this run's authority`,
          );
        }

        if (depth >= params.maxDepth) {
          signalSubagentFailure(
            "authorize_delegation",
            "subagent_delegate is disabled in subagent runs (depth limit reached)",
          );
        }

        const idleTimeoutMs = params.idleTimeoutMs;
        const registration = buildSubagentDelegationRegistration({
          ctx,
          toolCallId,
          mode,
          profile,
          sessionName: generateSessionName(profile),
          task: parsed.task,
          title: parsed.title,
          idleTimeoutMs,
          depth: depth + 1,
          modelOverride: parsed.model,
          reasoningOverride: parsed.reasoning,
        });
        const { sessionName, childRequestId, childSessionId } = registration;
        logger.info("subagent delegate start", {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          parentToolCallId: toolCallId,
          mode,
          profile,
          parentDepth: depth,
          childDepth: depth + 1,
          sessionName,
          stableNamedContinuation: registration.stableNamedContinuation,
          idleTimeoutMs,
          task: truncateEnd(parsed.task.replace(/\s+/g, " ").trim(), 240),
          modelOverride: parsed.model,
          reasoningOverride: parsed.reasoning,
        });

        const onDelegate = params.onDelegate;
        if (!onDelegate) {
          signalSubagentFailure(
            "start_delegation",
            "subagent delegation is unavailable in this runtime",
          );
        }

        const started = await captureSubagentOperation({
          operation: "start_delegation",
          run: () => onDelegate(registration),
        });
        const handle = adaptToolResultToHost(started);

        if (mode === "deferred") {
          logger.info("subagent delegate accepted", {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            parentToolCallId: toolCallId,
            childRequestId,
            childSessionId,
            workflowRunId: handle.runId,
            profile,
            mode: "deferred",
            idleTimeoutMs,
          });

          return {
            ok: true,
            mode: "deferred",
            status: "accepted",
            workflowRunId: handle.runId,
            permissions: profile,
            sessionName,
          };
        }

        let abortListener: (() => void) | null = null;
        if (abortSignal) {
          const onAbort = () => {
            void captureSubagentOperation({
              operation: "cancel_delegation",
              run: () => handle.cancel("parent request aborted"),
            });
          };
          if (abortSignal.aborted) onAbort();
          else {
            abortSignal.addEventListener("abort", onAbort, { once: true });
            abortListener = () => {
              abortSignal.removeEventListener("abort", onAbort);
            };
          }
        }

        const completed = await captureSubagentOperation({
          operation: "await_completion",
          run: () => handle.completion,
        }).finally(() => {
          abortListener?.();
        });
        const complete = completed.match<() => SubagentDelegateOutput>({
          err: (error) => () => {
            logger.error("subagent delegate failed", {
              requestId: ctx.requestId,
              sessionId: ctx.sessionId,
              parentToolCallId: toolCallId,
              childRequestId,
              childSessionId,
              profile,
              idleTimeoutMs,
              ...formatTaggedErrorForLog(error),
            });
            return adaptToolResultToHost<never, SubagentDelegationError>(Result.err(error));
          },
          ok: (outcome) => () => {
            const status = outcome.status;
            const ok = status === "resolved";
            logger.info("subagent delegate done", {
              requestId: ctx.requestId,
              sessionId: ctx.sessionId,
              parentToolCallId: toolCallId,
              childRequestId,
              childSessionId,
              profile,
              status,
              ok,
              idleTimeoutMs,
              workflowRunId: handle.runId,
            });
            return {
              ok,
              mode: "sync",
              status,
              workflowRunId: handle.runId,
              permissions: profile,
              sessionName,
              finalText: outcome.finalText,
              detail: outcome.detail,
            };
          },
        });
        return complete();
      },
    }),
  };
}
