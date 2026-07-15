import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { type AdapterPlatform, type LilacBus } from "@stanley2058/lilac-event-bus";
import {
  createLogger,
  MODEL_REASONING_EFFORTS,
  type ModelReasoningEffort,
} from "@stanley2058/lilac-utils";
import { requireRequestContext } from "../shared/req-context";

const subagentProfileSchema = z.enum(["explore", "general", "self"]);
const subagentModeSchema = z.enum(["deferred", "sync"]);
const subagentSessionNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "sessionName must be a short slug");

const modelReasoningEffortSchema = z.enum(MODEL_REASONING_EFFORTS);

const subagentDelegateBaseInputSchema = z.object({
  profile: subagentProfileSchema
    .default("explore")
    .describe("Subagent profile to run (explore, general, self)."),
  task: z.string().min(1).describe("Objective for the subagent."),
  mode: subagentModeSchema
    .default("deferred")
    .describe(
      "Delegation mode. Use deferred by default for parallelizable work; use sync only when the child result is immediately required before any meaningful next step.",
    ),
  sessionName: subagentSessionNameSchema
    .optional()
    .describe(
      "Optional stable short slug for continuing a subagent session within this parent session/channel. When omitted, a reusable short name is generated and returned.",
    ),
});

type AgentSelectableModelPreset = {
  model: string;
  reasoning?: ModelReasoningEffort;
  comment?: string;
  agentCanSelect?: boolean;
};

type SubagentDelegateInput = z.input<typeof subagentDelegateBaseInputSchema> & {
  model?: string;
  reasoning?: ModelReasoningEffort;
};

type ParsedSubagentDelegateInput = z.output<typeof subagentDelegateBaseInputSchema> & {
  model?: string;
  reasoning?: ModelReasoningEffort;
};

function isSelectableModelPreset(entry: readonly [string, AgentSelectableModelPreset]): boolean {
  const [alias, preset] = entry;
  return preset.agentCanSelect === true && !alias.includes("/") && /^[^/]+\/.+/u.test(preset.model);
}

function createSubagentDelegateInputSchema(
  selectableModels: ReadonlyArray<readonly [string, AgentSelectableModelPreset]>,
): z.ZodType<ParsedSubagentDelegateInput> {
  const documentedModels = selectableModels.slice(0, 5).map(([alias, preset]) => {
    const detail = preset.comment?.trim()
      ? truncateEnd(normalizeToolDisplay(preset.comment), 240)
      : `${preset.model}${preset.reasoning ? `; default reasoning: ${preset.reasoning}` : ""}`;
    return `- ${alias}: ${detail}`;
  });
  const modelDescription = [
    "Optional agent-selectable alias from models.def. Direct provider/model values are not accepted.",
    selectableModels.length > 0
      ? `Configured aliases${selectableModels.length > 5 ? " (first 5 documented; all aliases are in the enum)" : ""}:\n${documentedModels.join("\n")}`
      : "No agent-selectable model aliases are configured; omit this field.",
  ].join("\n");

  if (selectableModels.length === 0) {
    return subagentDelegateBaseInputSchema;
  }

  const [firstAlias, ...remainingAliases] = selectableModels.map(([alias]) => alias);
  return subagentDelegateBaseInputSchema.extend({
    model: z
      .enum([firstAlias!, ...remainingAliases])
      .optional()
      .describe(modelDescription),
    reasoning: modelReasoningEffortSchema
      .optional()
      .describe(
        "Optional reasoning-effort override for this child run. When omitted, the selected alias or profile default applies.",
      ),
  });
}

const subagentTerminalStatusSchema = z.enum(["resolved", "failed", "cancelled", "timeout"]);

const subagentDelegateDeferredOutputSchema = z.object({
  ok: z.literal(true),
  mode: z.literal("deferred"),
  status: z.literal("accepted"),
  profile: subagentProfileSchema,
  sessionName: subagentSessionNameSchema,
});

const subagentDelegateSyncOutputSchema = z.object({
  ok: z.boolean(),
  mode: z.literal("sync"),
  status: subagentTerminalStatusSchema,
  profile: subagentProfileSchema,
  sessionName: subagentSessionNameSchema,
  finalText: z.string(),
  detail: z.string().optional(),
});

const subagentDelegateOutputSchema = z.discriminatedUnion("mode", [
  subagentDelegateDeferredOutputSchema,
  subagentDelegateSyncOutputSchema,
]);

export type SubagentDelegateOutput = z.output<typeof subagentDelegateOutputSchema>;
type SubagentTerminalStatus = z.infer<typeof subagentTerminalStatusSchema>;
export type SubagentProfile = z.infer<typeof subagentProfileSchema>;
export type SubagentMode = z.infer<typeof subagentModeSchema>;

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
  subagentDepth?: number;
  subagentProfile?: string;
};

type CurrentRunProfile = SubagentProfile | "primary";

function parseDepth(ctx: unknown): number {
  if (!ctx || typeof ctx !== "object") return 0;
  const raw = (ctx as Record<string, unknown>)["subagentDepth"];
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

function parseCurrentRunProfile(ctx: unknown): CurrentRunProfile {
  if (!ctx || typeof ctx !== "object") return "primary";
  const raw = (ctx as Record<string, unknown>)["subagentProfile"];
  if (raw === "primary") return "primary";
  if (raw === "explore" || raw === "general" || raw === "self") return raw;
  return "primary";
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
}): string {
  const children = Array.from(params.children.values());
  const total = children.length;
  const done = children.filter((c) => c.status === "done").length;
  const header = `subagent (${params.profile}; ${done}/${total} done)`;

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

export function buildDelegatedTaskPrompt(task: string): ModelMessage {
  return {
    role: "user",
    content: task,
  };
}

export type SubagentDelegationRegistration = {
  mode: SubagentMode;
  profile: SubagentProfile;
  sessionName: string;
  task: string;
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
  bus: LilacBus;
  idleTimeoutMs: number;
  maxDepth: number;
  modelPresets?: Readonly<Record<string, AgentSelectableModelPreset>>;
  delegatePromptOverlay?: string;
  onDelegate?: (registration: SubagentDelegationRegistration) => Promise<SubagentDelegationHandle>;
  onActivity?: () => void;
}) {
  const selectableModels = Object.entries(params.modelPresets ?? {}).filter(
    isSelectableModelPreset,
  );
  const selectableModelAliases = new Set(selectableModels.map(([alias]) => alias));
  const inputSchema = createSubagentDelegateInputSchema(selectableModels);
  const description = [
    "Delegate work to a subagent profile (explore, general, self).",
    "Deferred is the default and should be used for parallelizable work. In deferred mode the child starts immediately, this tool returns an accepted handle, the parent keeps working, and the child result is automatically inserted later as a synthetic tool result. Do not poll or manually join deferred children.",
    "Use sync only when the child result is immediately required before any meaningful next step.",
    "Prefer deferred for: repository exploration, independent evidence gathering, parallel investigations, or work whose result can be incorporated later.",
    "Prefer sync for: child answers that determine the next edit or decision, child results needed before responding, or the one blocking computation.",
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
        if (requestedModel !== undefined && !selectableModelAliases.has(requestedModel)) {
          throw new Error(`Model alias '${requestedModel}' is not available for agent selection`);
        }
        if (input.reasoning !== undefined && selectableModels.length === 0) {
          throw new Error("Reasoning override requires an agent-selectable model alias");
        }
        const parsed = inputSchema.parse(input);
        const ctx = requireRequestContext(context, "subagent_delegate") as RequestContextLike;
        const profile = parsed.profile;
        const mode = parsed.mode;
        const depth = parseDepth(context);

        const currentRunProfile = parseCurrentRunProfile(context);
        if (currentRunProfile === "explore" || currentRunProfile === "general") {
          throw new Error(`subagent_delegate is disabled in ${currentRunProfile} subagent runs`);
        }

        if (currentRunProfile === "self" && profile === "self") {
          throw new Error("self subagent cannot delegate to self profile");
        }

        if (depth >= params.maxDepth) {
          throw new Error("subagent_delegate is disabled in subagent runs (depth limit reached)");
        }

        const idleTimeoutMs = params.idleTimeoutMs;
        const sessionName = parsed.sessionName ?? generateSessionName(profile);
        const childRequestId = `sub:${ctx.requestId}:${crypto.randomUUID()}`;
        const childSessionId = `sub:${ctx.sessionId}:named:${sessionName}`;

        const childHeaders = {
          request_id: childRequestId,
          session_id: childSessionId,
          request_client: "unknown" as const,
          parent_request_id: ctx.requestId,
          parent_tool_call_id: toolCallId,
          subagent_profile: profile,
          subagent_depth: String(depth + 1),
        };

        const parentHeaders = {
          request_id: ctx.requestId,
          session_id: ctx.sessionId,
          request_client: toAdapterPlatform(ctx.requestClient),
        };
        logger.info("subagent delegate start", {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          parentToolCallId: toolCallId,
          mode,
          profile,
          parentDepth: depth,
          childDepth: depth + 1,
          sessionName,
          idleTimeoutMs,
          task: truncateEnd(parsed.task.replace(/\s+/g, " ").trim(), 240),
          modelOverride: parsed.model,
          reasoningOverride: parsed.reasoning,
        });

        if (!params.onDelegate) {
          throw new Error("subagent delegation is unavailable in this runtime");
        }

        const handle = await params.onDelegate({
          mode,
          profile,
          sessionName,
          task: parsed.task,
          idleTimeoutMs,
          depth: depth + 1,
          parentRequestId: ctx.requestId,
          parentSessionId: ctx.sessionId,
          parentRequestClient: ctx.requestClient,
          parentToolCallId: toolCallId,
          childRequestId,
          childSessionId,
          parentHeaders,
          childHeaders,
          initialMessages: [buildDelegatedTaskPrompt(parsed.task)],
          modelOverride: parsed.model,
          reasoningOverride: parsed.reasoning,
        });

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
            profile,
            sessionName,
          };
        }

        let abortListener: (() => void) | null = null;
        if (abortSignal) {
          const onAbort = () => {
            void handle.cancel("parent request aborted");
          };
          abortSignal.addEventListener("abort", onAbort, { once: true });
          abortListener = () => {
            abortSignal.removeEventListener("abort", onAbort);
          };
        }

        try {
          const outcome = await handle.completion;
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
            profile,
            sessionName,
            finalText: outcome.finalText,
            detail: outcome.detail,
          };
        } catch (e: unknown) {
          logger.error(
            "subagent delegate failed",
            {
              requestId: ctx.requestId,
              sessionId: ctx.sessionId,
              parentToolCallId: toolCallId,
              childRequestId,
              childSessionId,
              profile,
              idleTimeoutMs,
            },
            e,
          );
          throw e;
        } finally {
          abortListener?.();
        }
      },
    }),
  };
}
