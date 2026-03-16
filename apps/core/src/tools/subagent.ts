import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  lilacEventTypes,
  outReqTopic,
  type AdapterPlatform,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { requireRequestContext } from "../shared/req-context";

const subagentProfileSchema = z.enum(["explore", "general", "self"]);
const subagentModeSchema = z.enum(["deferred", "sync"]);

const subagentDelegateInputSchema = z
  .object({
    profile: subagentProfileSchema
      .default("explore")
      .describe("Subagent profile to run (explore, general, self)."),
    task: z.string().min(1).describe("Objective for the subagent."),
    mode: subagentModeSchema
      .default("deferred")
      .describe(
        "Delegation mode. Use deferred by default for parallelizable work; use sync only when the child result is immediately required before any meaningful next step.",
      ),
    blockingReason: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Required when mode is "sync". Explain why the child result is immediately required before continuing.',
      ),
    sessionId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional existing subagent session id to continue. Must belong to the current parent session.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional timeout in ms. Clamped to agent.subagents.maxTimeoutMs (defaults to 8 minutes if unset).",
      ),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "sync" && !value.blockingReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blockingReason"],
        message: 'blockingReason is required when mode is "sync"',
      });
    }
  });

const subagentTerminalStatusSchema = z.enum(["resolved", "failed", "cancelled", "timeout"]);

const subagentDelegateDeferredOutputSchema = z.object({
  ok: z.literal(true),
  mode: z.literal("deferred"),
  status: z.literal("accepted"),
  profile: subagentProfileSchema,
  childRequestId: z.string(),
  childSessionId: z.string(),
  timeoutMs: z.number().int().positive(),
});

const subagentDelegateSyncOutputSchema = z.object({
  ok: z.boolean(),
  mode: z.literal("sync"),
  status: subagentTerminalStatusSchema,
  profile: subagentProfileSchema,
  childRequestId: z.string(),
  childSessionId: z.string(),
  timeoutMs: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  finalText: z.string(),
  detail: z.string().optional(),
});

const subagentDelegateOutputSchema = z.discriminatedUnion("mode", [
  subagentDelegateDeferredOutputSchema,
  subagentDelegateSyncOutputSchema,
]);

type SubagentDelegateInput = z.input<typeof subagentDelegateInputSchema>;
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

function clampTimeoutMs(
  input: number | undefined,
  defaults: {
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
  },
): number {
  const requested = input ?? defaults.defaultTimeoutMs;
  const normalized = Math.max(1_000, Math.trunc(requested));
  return Math.min(normalized, defaults.maxTimeoutMs);
}

function normalizeSessionId(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

export type DeferredSubagentRegistration = {
  profile: SubagentProfile;
  task: string;
  timeoutMs: number;
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
};

export function subagentTools(params: {
  bus: LilacBus;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxDepth: number;
  onDeferredDelegate?: (registration: DeferredSubagentRegistration) => Promise<void>;
}) {
  const { bus } = params;
  const logger = createLogger({
    module: "tool:subagent_delegate",
  });

  return {
    subagent_delegate: tool<SubagentDelegateInput, SubagentDelegateOutput>({
      description: [
        "Delegate work to a subagent profile (explore, general, self).",
        "Deferred is the default and should be used for parallelizable work. In deferred mode the child starts immediately, this tool returns an accepted handle, the parent keeps working, and the child result is automatically inserted later as a synthetic tool result. Do not poll or manually join deferred children.",
        'Use sync only when the child result is immediately required before any meaningful next step. When mode is "sync", blockingReason is required.',
        "Prefer deferred for: repository exploration, independent evidence gathering, parallel investigations, or work whose result can be incorporated later.",
        "Prefer sync for: child answers that determine the next edit or decision, child results needed before responding, or the one blocking computation.",
      ].join("\n"),
      inputSchema: subagentDelegateInputSchema,
      outputSchema: subagentDelegateOutputSchema,
      execute: async (input, { abortSignal, experimental_context, toolCallId }) => {
        const ctx = requireRequestContext(
          experimental_context,
          "subagent_delegate",
        ) as RequestContextLike;
        const profile = input.profile ?? "explore";
        const mode = input.mode ?? "deferred";
        const blockingReason = input.blockingReason?.trim() || undefined;

        if (mode === "sync" && !blockingReason) {
          throw new Error('blockingReason is required when mode is "sync"');
        }

        const depth = parseDepth(experimental_context);

        const currentRunProfile = parseCurrentRunProfile(experimental_context);
        if (currentRunProfile === "explore" || currentRunProfile === "general") {
          throw new Error(`subagent_delegate is disabled in ${currentRunProfile} subagent runs`);
        }

        if (currentRunProfile === "self" && profile === "self") {
          throw new Error("self subagent cannot delegate to self profile");
        }

        if (depth >= params.maxDepth) {
          throw new Error("subagent_delegate is disabled in subagent runs (depth limit reached)");
        }

        const timeoutMs = clampTimeoutMs(input.timeoutMs, {
          defaultTimeoutMs: params.defaultTimeoutMs,
          maxTimeoutMs: params.maxTimeoutMs,
        });

        const continuedSessionId = normalizeSessionId(input.sessionId);
        if (continuedSessionId && !continuedSessionId.startsWith(`sub:${ctx.sessionId}:`)) {
          throw new Error(
            "subagent sessionId must belong to the current parent session (expected prefix sub:<parent-session-id>:)",
          );
        }

        const startedAt = Date.now();
        const childRequestId = `sub:${ctx.requestId}:${crypto.randomUUID()}`;
        const childSessionId = continuedSessionId ?? `sub:${ctx.sessionId}:${childRequestId}`;

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
          continuedSessionId: continuedSessionId ?? null,
          timeoutMs,
          blockingReason: mode === "sync" ? blockingReason : undefined,
          task: truncateEnd(input.task.replace(/\s+/g, " ").trim(), 240),
        });

        const subId = `${childRequestId}:${Math.random().toString(16).slice(2)}`;

        if (mode === "deferred") {
          if (!params.onDeferredDelegate) {
            throw new Error("subagent deferred delegation is unavailable in this runtime");
          }

          await params.onDeferredDelegate({
            profile,
            task: input.task,
            timeoutMs,
            depth: depth + 1,
            parentRequestId: ctx.requestId,
            parentSessionId: ctx.sessionId,
            parentRequestClient: ctx.requestClient,
            parentToolCallId: toolCallId,
            childRequestId,
            childSessionId,
            parentHeaders,
            childHeaders,
            initialMessages: [buildDelegatedTaskPrompt(input.task)],
          });

          logger.info("subagent delegate accepted", {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            parentToolCallId: toolCallId,
            childRequestId,
            childSessionId,
            profile: input.profile,
            mode: "deferred",
            timeoutMs,
          });

          return {
            ok: true,
            mode: "deferred",
            status: "accepted",
            profile,
            childRequestId,
            childSessionId,
            timeoutMs,
          };
        }

        let lifecycleDetail: string | undefined;
        let finalText = "";
        const childTools = new Map<string, ChildToolState>();
        let childUpdateSeq = 0;

        const publishSubagentProgress = async () => {
          const display = renderSubagentDisplay({
            profile,
            children: childTools,
          });

          await bus.publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId,
              status: "update",
              display,
            },
            { headers: parentHeaders },
          );
        };

        let settleFn:
          | ((value: { status: SubagentTerminalStatus; detail?: string }) => void)
          | null = null;

        const settled = new Promise<{
          status: SubagentTerminalStatus;
          detail?: string;
        }>((resolve) => {
          settleFn = resolve;
        });

        let isSettled = false;
        const settle = (value: { status: SubagentTerminalStatus; detail?: string }) => {
          if (isSettled) return;
          isSettled = true;
          settleFn?.(value);
        };

        const outSub = await bus.subscribeTopic(
          outReqTopic(childRequestId),
          {
            mode: "fanout",
            subscriptionId: `subagent:out:${subId}`,
            consumerId: `subagent:out:${subId}`,
            offset: { type: "begin" },
            batch: { maxWaitMs: 250 },
          },
          async (msg, subCtx) => {
            if (msg.headers?.request_id !== childRequestId) {
              await subCtx.commit();
              return;
            }

            if (msg.type === lilacEventTypes.EvtAgentOutputDeltaText) {
              finalText += msg.data.delta;
            }

            if (msg.type === lilacEventTypes.EvtAgentOutputToolCall) {
              const existing = childTools.get(msg.data.toolCallId);
              const next: ChildToolState = {
                toolCallId: msg.data.toolCallId,
                status: msg.data.status === "end" ? "done" : "running",
                ok: msg.data.status === "end" ? msg.data.ok === true : (existing?.ok ?? null),
                display: msg.data.display,
                updatedSeq: ++childUpdateSeq,
              };

              childTools.set(next.toolCallId, next);

              logger.debug("subagent child tool", {
                requestId: ctx.requestId,
                sessionId: ctx.sessionId,
                parentToolCallId: toolCallId,
                childRequestId,
                childToolCallId: msg.data.toolCallId,
                childStatus: msg.data.status,
                childOk: msg.data.ok,
                display: truncateEnd(normalizeToolDisplay(msg.data.display), 160),
              });

              await publishSubagentProgress().catch((e: unknown) => {
                logger.warn(
                  "subagent progress publish failed",
                  {
                    requestId: ctx.requestId,
                    sessionId: ctx.sessionId,
                    parentToolCallId: toolCallId,
                    childRequestId,
                  },
                  e,
                );
              });
            }

            if (msg.type === lilacEventTypes.EvtAgentOutputResponseText) {
              finalText = msg.data.finalText;
              settle({ status: "resolved" });
            }

            await subCtx.commit();
          },
        );

        const evtSub = await bus.subscribeTopic(
          "evt.request",
          {
            mode: "fanout",
            subscriptionId: `subagent:evt:${subId}`,
            consumerId: `subagent:evt:${subId}`,
            offset: { type: "now" },
            batch: { maxWaitMs: 250 },
          },
          async (msg, subCtx) => {
            if (msg.headers?.request_id !== childRequestId) {
              await subCtx.commit();
              return;
            }

            if (msg.type === lilacEventTypes.EvtRequestLifecycleChanged) {
              lifecycleDetail = msg.data.detail;
              logger.debug("subagent lifecycle", {
                requestId: ctx.requestId,
                sessionId: ctx.sessionId,
                parentToolCallId: toolCallId,
                childRequestId,
                state: msg.data.state,
                detail: msg.data.detail,
              });
              if (msg.data.state === "failed") {
                settle({ status: "failed", detail: msg.data.detail });
              }
              if (msg.data.state === "cancelled") {
                settle({ status: "cancelled", detail: msg.data.detail });
              }
              if (msg.data.state === "resolved") {
                settle({ status: "resolved", detail: msg.data.detail });
              }
            }

            await subCtx.commit();
          },
        );

        const timeout = setTimeout(() => {
          settle({ status: "timeout", detail: `timed out after ${timeoutMs}ms` });
        }, timeoutMs);

        const stopAll = async () => {
          clearTimeout(timeout);
          await Promise.all([outSub.stop(), evtSub.stop()]);
        };

        const cancelChild = async (detail: string) => {
          logger.warn("subagent child cancel requested", {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            parentToolCallId: toolCallId,
            childRequestId,
            detail,
          });

          await bus.publish(
            lilacEventTypes.CmdRequestMessage,
            {
              queue: "interrupt",
              messages: [],
              raw: {
                cancel: true,
                requiresActive: true,
                subagent: {
                  profile,
                  depth: depth + 1,
                  parentRequestId: ctx.requestId,
                  parentToolCallId: toolCallId,
                },
              },
            },
            { headers: childHeaders },
          );
          settle({ status: "cancelled", detail });
        };

        let abortListener: (() => void) | null = null;
        if (abortSignal) {
          const onAbort = () => {
            void cancelChild("parent request aborted");
          };
          abortSignal.addEventListener("abort", onAbort, { once: true });
          abortListener = () => {
            abortSignal.removeEventListener("abort", onAbort);
          };
        }

        try {
          await bus.publish(
            lilacEventTypes.CmdRequestMessage,
            {
              queue: "prompt",
              messages: [buildDelegatedTaskPrompt(input.task)],
              raw: {
                subagent: {
                  profile,
                  depth: depth + 1,
                  parentRequestId: ctx.requestId,
                  parentToolCallId: toolCallId,
                },
              },
            },
            { headers: childHeaders },
          );

          const outcome = await settled;

          if (outcome.status === "timeout") {
            await cancelChild(outcome.detail ?? "subagent timeout").catch(() => {
              // Best effort: timeout result should still be returned.
            });
          }

          const durationMs = Date.now() - startedAt;
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
            durationMs,
            timeoutMs,
            childToolsTotal: childTools.size,
            childToolsDone: Array.from(childTools.values()).filter((c) => c.status === "done")
              .length,
          });

          return {
            ok,
            mode: "sync",
            status,
            profile,
            childRequestId,
            childSessionId,
            timeoutMs,
            durationMs,
            finalText,
            detail: outcome.detail ?? lifecycleDetail,
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
              timeoutMs,
            },
            e,
          );
          throw e;
        } finally {
          abortListener?.();
          await stopAll();
        }
      },
    }),
  };
}
