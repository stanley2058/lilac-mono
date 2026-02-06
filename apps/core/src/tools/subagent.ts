import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  lilacEventTypes,
  outReqTopic,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
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

function clampTimeoutMs(input: number | undefined, defaults: {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}): number {
  const requested = input ?? defaults.defaultTimeoutMs;
  const normalized = Math.max(1_000, Math.trunc(requested));
  return Math.min(normalized, defaults.maxTimeoutMs);
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

        const subId = `${childRequestId}:${Math.random().toString(16).slice(2)}`;

        let lifecycleDetail: string | undefined;
        let finalText = "";

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
        } finally {
          abortListener?.();
          await stopAll();
        }
      },
    }),
  };
}
