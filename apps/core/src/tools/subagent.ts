import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  lilacEventTypes,
  outReqTopic,
  type AdapterPlatform,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { resolveLogLevel } from "@stanley2058/lilac-utils";
import { Logger } from "@stanley2058/simple-module-logger";
import { requireRequestContext } from "../shared/req-context";

const subagentDelegateInputSchema = z.object({
  profile: z
    .literal("explore")
    .default("explore")
    .describe("Subagent profile to run. Explore is read-only codebase mapping."),
  task: z.string().min(1).describe("Objective for the subagent."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional timeout in ms. Hard-capped at 8 minutes."),
});

const subagentStatusSchema = z.enum([
  "resolved",
  "failed",
  "cancelled",
  "timeout",
]);

const subagentDelegateOutputSchema = z.object({
  ok: z.boolean(),
  status: subagentStatusSchema,
  profile: z.literal("explore"),
  childRequestId: z.string(),
  childSessionId: z.string(),
  timeoutMs: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  finalText: z.string(),
  detail: z.string().optional(),
});

type SubagentDelegateInput = z.infer<typeof subagentDelegateInputSchema>;
type SubagentDelegateOutput = z.infer<typeof subagentDelegateOutputSchema>;
type SubagentStatus = z.infer<typeof subagentStatusSchema>;

type ChildToolStatus = "running" | "done";

type ChildToolState = {
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
};

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

function clampTimeoutMs(input: number | undefined, defaults: {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}): number {
  const requested = input ?? defaults.defaultTimeoutMs;
  const normalized = Math.max(1_000, Math.trunc(requested));
  return Math.min(normalized, defaults.maxTimeoutMs);
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

function renderSubagentDisplay(params: {
  profile: "explore";
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

function buildExplorePrompt(task: string): ModelMessage {
  const text = [
    "You are an explore subagent.",
    "",
    "Mission:",
    task,
    "",
    "Rules:",
    "- Focus on codebase exploration and evidence-backed findings.",
    "- Prefer parallel read/search with read_file, glob, grep, and batch.",
    "- Do not edit files.",
    "- Do not run bash.",
    "- Do not delegate to other subagents.",
    "- Cite concrete file paths (and lines when helpful) in your answer.",
  ].join("\n");

  return {
    role: "user",
    content: text,
  };
}

export function subagentTools(params: {
  bus: LilacBus;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxDepth: number;
}) {
  const { bus } = params;
  const logger = new Logger({
    logLevel: resolveLogLevel(),
    module: "tool:subagent_delegate",
  });

  return {
    subagent_delegate: tool<SubagentDelegateInput, SubagentDelegateOutput>({
      description:
        "Delegate to a read-only explore subagent and return its final response.",
      inputSchema: subagentDelegateInputSchema,
      outputSchema: subagentDelegateOutputSchema,
      execute: async (input, { abortSignal, experimental_context, toolCallId }) => {
        const ctx = requireRequestContext(
          experimental_context,
          "subagent_delegate",
        ) as RequestContextLike;

        const depth = parseDepth(experimental_context);
        if (depth >= params.maxDepth) {
          throw new Error(
            "subagent_delegate is disabled in subagent runs (depth limit reached)",
          );
        }

        const timeoutMs = clampTimeoutMs(input.timeoutMs, {
          defaultTimeoutMs: params.defaultTimeoutMs,
          maxTimeoutMs: params.maxTimeoutMs,
        });

        const startedAt = Date.now();
        const childRequestId = `sub:${ctx.requestId}:${crypto.randomUUID()}`;
        const childSessionId = `sub:${ctx.sessionId}:${childRequestId}`;

        const childHeaders = {
          request_id: childRequestId,
          session_id: childSessionId,
          request_client: "unknown" as const,
          parent_request_id: ctx.requestId,
          parent_tool_call_id: toolCallId,
          subagent_profile: input.profile,
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
          profile: input.profile,
          parentDepth: depth,
          childDepth: depth + 1,
          timeoutMs,
          task: truncateEnd(input.task.replace(/\s+/g, " ").trim(), 240),
        });

        const subId = `${childRequestId}:${Math.random().toString(16).slice(2)}`;

        let lifecycleDetail: string | undefined;
        let finalText = "";
        const childTools = new Map<string, ChildToolState>();
        let childUpdateSeq = 0;

        const publishSubagentProgress = async () => {
          const display = renderSubagentDisplay({
            profile: input.profile,
            children: childTools,
          });

          await bus.publish(
            lilacEventTypes.EvtAgentOutputToolCall,
            {
              toolCallId,
              status: "start",
              display,
            },
            { headers: parentHeaders },
          );
        };

        let settleFn: ((value: {
          status: SubagentStatus;
          detail?: string;
        }) => void) | null = null;

        const settled = new Promise<{
          status: SubagentStatus;
          detail?: string;
        }>((resolve) => {
          settleFn = resolve;
        });

        let isSettled = false;
        const settle = (value: { status: SubagentStatus; detail?: string }) => {
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
                status:
                  msg.data.status === "end"
                    ? "done"
                    : "running",
                ok:
                  msg.data.status === "end"
                    ? msg.data.ok === true
                    : (existing?.ok ?? null),
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
                  profile: input.profile,
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
              messages: [buildExplorePrompt(input.task)],
              raw: {
                subagent: {
                  profile: input.profile,
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
            profile: input.profile,
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
            status,
            profile: input.profile,
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
              profile: input.profile,
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
