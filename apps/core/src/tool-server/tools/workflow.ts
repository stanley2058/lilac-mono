import { z } from "zod";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { resolveDiscordSessionId } from "./resolve-discord-session-id";
import {
  requireToolServerHeaders,
  type RequiredToolServerHeaders,
} from "../../shared/tool-server-context";
import type { RequestContext, ServerTool } from "../types";
import type { CoreConfig } from "@stanley2058/lilac-utils";
import type { SurfaceAdapter } from "../../surface/adapter";
import type { SendOpts } from "../../surface";
import type { WorkflowStore } from "../../workflow/workflow-store";
import { isAdapterPlatform } from "../../shared/is-adapter-platform";
import type { WorkflowDefinitionV3 } from "../../workflow/types";

type RequestHeaders = RequiredToolServerHeaders;

function toHeaders(ctx: RequestContext | undefined): RequestHeaders {
  return requireToolServerHeaders(ctx, "workflow");
}

function tryHeaders(ctx: RequestContext | undefined): RequestHeaders | undefined {
  const requestId = ctx?.requestId;
  const sessionId = ctx?.sessionId;
  const requestClient = ctx?.requestClient;
  if (!requestId || !sessionId || !requestClient) return undefined;
  if (!isAdapterPlatform(requestClient)) return undefined;
  return {
    request_id: requestId,
    session_id: sessionId,
    request_client: requestClient,
  };
}

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

export class Workflow implements ServerTool {
  id = "workflow";

  constructor(
    private readonly params: {
      bus: LilacBus;
      adapter?: SurfaceAdapter;
      config?: CoreConfig;
      getConfig?: () => Promise<CoreConfig>;
      workflowStore?: WorkflowStore;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "workflow.wait_for_reply.create",
        name: "Workflow Wait For Reply Create",
        description:
          "Create a wait_for_reply workflow that will resume later. Each task waits for a strict reply to the given messageId in sessionId.",
        shortInput: [
          "--summary=<string>",
          "--tasks=<object[]> | (Use --help to see the full interface)",
        ],
        input: [
          "--summary=<string> | Compact snapshot of what we were doing",
          "--tasks=<{ description: string, sessionId: string, messageId: string }[]>",
        ],
      },
      {
        callableId: "workflow.wait_for_reply.send_and_wait",
        name: "Workflow Wait For Reply Send And Wait",
        description:
          "Send a message to a Discord session and create a wait_for_reply workflow task waiting for a reply to that message.",
        shortInput: [
          "--session-id=<string>",
          "--text=<string>",
          "--task-description=<string>",
          "--summary=<string>",
        ],
        input: [
          "--session-id=<string> | Target session/channel (raw id, <#id>, or configured token alias)",
          "--text=<string> | Message to send",
          "--silent=<boolean> | Disable all notifications for this message (mentions + reply ping)",
          "--paths=<string | string[]> | Optional local attachment paths",
          "--filenames=<string | string[]> | Optional filenames for each attachment",
          "--mime-types=<string | string[]> | Optional mime types for each attachment",
          "--reply-to-message-id=<string> | Optional reply target id",
          "--task-description=<string> | Description for the wait_for_reply task",
          "--summary=<string> | Workflow summary to be used on resume",
          "--from-user-id=<string> | Optional user id restriction for replies",
          "--timeout-ms=<number> | Optional timeout for waiting",
        ],
      },
      {
        callableId: "workflow.schedule",
        name: "Workflow Schedule",
        description:
          "Create a scheduled workflow trigger. Supports wait_until, wait_for, and cron (5-field minute precision).",
        shortInput: [
          "--mode=<wait_until|wait_for|cron>",
          "--summary=<string>",
          "--user-prompt=<string>",
        ],
        input: [
          "--mode=<wait_until|wait_for|cron>",
          "--summary=<string> | Job summary",
          "--user-prompt=<string> | Job instructions",
          "--system-prompt=<string> | Optional additional system prompt for the job",
          "--require-done=<boolean> | Require a final DONE token (default: true)",
          "--done-token=<string> | DONE token text (default: DONE)",
          "--run-at-ms=<number> | (wait_until) absolute timestamp in ms",
          "--run-at-iso=<string> | (wait_until) ISO timestamp",
          "--delay-ms=<number> | (wait_for) delay in ms",
          "--expr=<string> | (cron) 5-field cron expression",
          "--tz=<string> | (cron) timezone (default: UTC)",
          "--start-at-ms=<number> | (cron) optional start timestamp",
          "--skip-missed=<boolean> | (cron) skip missed ticks (default: true)",
        ],
      },
      {
        callableId: "workflow.cancel",
        name: "Workflow Cancel",
        description: "Cancel a workflow and its pending tasks.",
        shortInput: ["--workflow-id=<string>"],
        input: ["--workflow-id=<string>", "--reason=<string> | Optional cancellation reason"],
      },
      {
        callableId: "workflow.list",
        name: "Workflow List",
        description: "List workflows from the local workflow store (scheduled only).",
        shortInput: ["--state=<string>", "--limit=<number>"],
        input: [
          "--state=<queued|running|blocked|resolved|failed|cancelled> | Optional state filter",
          "--limit=<number> | Max rows (default: 100)",
          "--offset=<number> | Offset (default: 0)",
          "--include-tasks=<boolean> | Include tasks (default: false)",
        ],
      },
    ];
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: {
      signal?: AbortSignal;
      context?: RequestContext;
      messages?: readonly unknown[];
    },
  ): Promise<unknown> {
    const getCfg = async (): Promise<CoreConfig | undefined> => {
      if (this.params.config) return this.params.config;
      if (this.params.getConfig) return this.params.getConfig();
      return undefined;
    };

    if (callableId === "workflow.wait_for_reply.create") {
      const payload = workflowCreateInputSchema.parse(input);
      const headers = toHeaders(opts?.context);

      const workflowId = `wf:${crypto.randomUUID()}`;

      await this.params.bus.publish(
        lilacEventTypes.CmdWorkflowCreate,
        {
          workflowId,
          definition: {
            version: 2,
            origin: {
              request_id: headers.request_id,
              session_id: headers.session_id,
              request_client: headers.request_client,
            },
            resumeTarget: {
              session_id: headers.session_id,
              request_client: headers.request_client,
            },
            summary: payload.summary,
            completion: "all",
          },
        },
        { headers },
      );

      const taskIds: string[] = [];

      for (let i = 0; i < payload.tasks.length; i++) {
        const t = payload.tasks[i]!;
        const taskId = `t:${i + 1}:${crypto.randomUUID()}`;
        taskIds.push(taskId);

        const cfg = await getCfg();
        const channelId = cfg
          ? resolveDiscordSessionId({ sessionId: t.sessionId, cfg })
          : t.sessionId;

        await this.params.bus.publish(
          lilacEventTypes.CmdWorkflowTaskCreate,
          {
            workflowId,
            taskId,
            kind: "discord.wait_for_reply",
            description: t.description,
            input: {
              channelId,
              messageId: t.messageId,
            },
          },
          { headers },
        );
      }

      return { ok: true as const, workflowId, taskIds };
    }

    if (callableId === "workflow.wait_for_reply.send_and_wait") {
      const payload = workflowSendAndWaitInputSchema.parse(input);
      const headers = toHeaders(opts?.context);

      const cfg = await getCfg();
      if (!cfg) {
        throw new Error(
          "workflow.wait_for_reply.send_and_wait requires core config (tool server must be started with config)",
        );
      }

      const resolvedChannelId = resolveDiscordSessionId({
        sessionId: payload.sessionId,
        cfg,
      });

      if (!payload.text.trim()) {
        throw new Error("text is empty");
      }

      const requestClient = headers.request_client;
      if (requestClient !== "discord") {
        throw new Error(
          `workflow.wait_for_reply.send_and_wait currently requires request_client=discord (got '${requestClient}')`,
        );
      }

      const workflowId = `wf:${crypto.randomUUID()}`;
      const taskId = `t:1:${crypto.randomUUID()}`;

      // Publish workflow create first (so a task referring to it is never orphaned).
      await this.params.bus.publish(
        lilacEventTypes.CmdWorkflowCreate,
        {
          workflowId,
          definition: {
            version: 2,
            origin: {
              request_id: headers.request_id,
              session_id: headers.session_id,
              request_client: headers.request_client,
            },
            resumeTarget: {
              session_id: headers.session_id,
              request_client: headers.request_client,
            },
            summary: payload.summary,
            completion: "all",
          },
        },
        { headers },
      );

      if (!this.params.adapter) {
        throw new Error(
          "workflow.wait_for_reply.send_and_wait requires surface adapter (tool server must be started with adapter)",
        );
      }

      const sessionRef = {
        platform: "discord",
        channelId: resolvedChannelId,
      } as const;

      const replyTo:
        | {
            platform: "discord";
            channelId: string;
            messageId: string;
          }
        | undefined = payload.replyToMessageId
        ? {
            platform: "discord",
            channelId: resolvedChannelId,
            messageId: payload.replyToMessageId,
          }
        : undefined;

      // NOTE: attachments support is implemented by the surface tool.
      // For this workflow helper, we support attachments the same way.
      const paths = payload.paths ?? [];
      if (paths.length > 0) {
        if (paths.length > 10) {
          throw new Error(`Too many attachments (${paths.length}). Max is 10.`);
        }
      }

      const attachments =
        paths.length > 0
          ? await (
              await import("./surface")
            ).loadLocalAttachments({
              cwd: opts?.context?.cwd ?? process.cwd(),
              paths,
              filenames: payload.filenames,
              mimeTypes: payload.mimeTypes,
            })
          : [];

      const sentRef = await this.params.adapter.sendMsg(
        sessionRef,
        { text: payload.text, attachments },
        replyTo || payload.silent === true
          ? ({
              ...(replyTo ? { replyTo } : {}),
              ...(payload.silent === true ? { silent: true } : {}),
            } satisfies SendOpts)
          : undefined,
      );

      const sentMessageId = sentRef.messageId;

      await this.params.bus.publish(
        lilacEventTypes.CmdWorkflowTaskCreate,
        {
          workflowId,
          taskId,
          kind: "discord.wait_for_reply",
          description: payload.taskDescription,
          input: {
            channelId: resolvedChannelId,
            messageId: sentMessageId,
            fromUserId: payload.fromUserId,
            timeoutMs: payload.timeoutMs,
          },
        },
        { headers },
      );

      return {
        ok: true as const,
        workflowId,
        taskId,
        channelId: resolvedChannelId,
        messageId: sentMessageId,
      };
    }

    if (callableId === "workflow.schedule") {
      const payload = workflowScheduleInputSchema.parse(input);
      const headers = tryHeaders(opts?.context);
      const nowMs = Date.now();

      const workflowId = `wf:${crypto.randomUUID()}`;
      const taskId = `t:1:${crypto.randomUUID()}`;

      const origin = headers
        ? {
            request_id: headers.request_id,
            session_id: headers.session_id,
            request_client: headers.request_client,
          }
        : undefined;

      const requireDone = payload.requireDone ?? true;
      const doneToken = (payload.doneToken ?? "DONE").trim() || "DONE";

      let schedule: WorkflowDefinitionV3["schedule"];
      let taskKind: string;
      let taskInput: unknown;
      let taskDesc: string;

      if (payload.mode === "wait_until") {
        const runAtMs =
          payload.runAtMs ?? (payload.runAtIso ? new Date(payload.runAtIso).getTime() : NaN);
        if (!Number.isFinite(runAtMs)) {
          throw new Error("workflow.schedule wait_until requires a valid runAtMs or runAtIso");
        }
        const runAt = Math.trunc(runAtMs);
        schedule = { mode: "wait_until", runAtMs: runAt };
        taskKind = "time.wait_until";
        taskInput = { runAtMs: runAt };
        taskDesc = `wait_until @ ${new Date(runAt).toISOString()}`;
      } else if (payload.mode === "wait_for") {
        const delayMs = Math.trunc(payload.delayMs);
        if (!Number.isFinite(delayMs) || delayMs <= 0) {
          throw new Error("workflow.schedule wait_for requires delayMs > 0");
        }
        const runAtMs = nowMs + delayMs;
        schedule = {
          mode: "wait_for",
          delayMs,
          createdAtMs: nowMs,
          runAtMs,
        };
        taskKind = "time.wait_until";
        taskInput = { runAtMs };
        taskDesc = `wait_for ${delayMs}ms @ ${new Date(runAtMs).toISOString()}`;
      } else {
        const tz = payload.tz ?? "UTC";
        const skipMissed = payload.skipMissed ?? true;
        const startAtMs =
          typeof payload.startAtMs === "number" && Number.isFinite(payload.startAtMs)
            ? Math.trunc(payload.startAtMs)
            : undefined;

        schedule = {
          mode: "cron",
          expr: payload.expr,
          tz,
          startAtMs,
          skipMissed,
        };

        taskKind = "time.cron";
        taskInput = {
          expr: payload.expr,
          tz,
          startAtMs,
          skipMissed,
        };
        taskDesc = `cron '${payload.expr}' tz=${tz}`;
      }

      const def: WorkflowDefinitionV3 = {
        version: 3,
        kind: "scheduled",
        origin,
        schedule,
        job: {
          summary: payload.summary,
          systemPrompt: payload.systemPrompt,
          userPrompt: payload.userPrompt,
          requireDone,
          doneToken,
        },
      };

      await this.params.bus.publish(
        lilacEventTypes.CmdWorkflowCreate,
        { workflowId, definition: def },
        headers ? { headers } : undefined,
      );

      await this.params.bus.publish(
        lilacEventTypes.CmdWorkflowTaskCreate,
        {
          workflowId,
          taskId,
          kind: taskKind,
          description: taskDesc,
          input: taskInput,
        },
        headers ? { headers } : undefined,
      );

      return { ok: true as const, workflowId, taskId };
    }

    if (callableId === "workflow.cancel") {
      const payload = workflowCancelInputSchema.parse(input);
      const headers = tryHeaders(opts?.context);
      await this.params.bus.publish(
        lilacEventTypes.CmdWorkflowCancel,
        { workflowId: payload.workflowId, reason: payload.reason },
        headers ? { headers } : undefined,
      );
      return { ok: true as const };
    }

    if (callableId === "workflow.list") {
      const payload = workflowListInputSchema.parse(input);
      const store = this.params.workflowStore;
      if (!store) {
        throw new Error(
          "workflow.list requires workflowStore (tool server must run inside core runtime)",
        );
      }

      const rows = store.listWorkflows({
        state: payload.state,
        limit: payload.limit,
        offset: payload.offset,
      });

      const workflows = rows.map((w) => {
        if (w.definition.version === 2) {
          return {
            workflowId: w.workflowId,
            kind: "interactive" as const,
            state: w.state,
            createdAt: w.createdAt,
            updatedAt: w.updatedAt,
            resolvedAt: w.resolvedAt,
            summary: w.definition.summary,
            ...(payload.includeTasks ? { tasks: store.listTasks(w.workflowId) } : {}),
          };
        }

        const tasks = store.listTasks(w.workflowId);
        const trigger = tasks.find((t) => t.kind === "time.wait_until" || t.kind === "time.cron");
        return {
          workflowId: w.workflowId,
          kind: "scheduled" as const,
          state: w.state,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          resolvedAt: w.resolvedAt,
          summary: w.definition.job.summary,
          schedule: w.definition.schedule,
          nextRunAt: trigger?.timeoutAt,
          ...(payload.includeTasks ? { tasks } : {}),
        };
      });

      return { ok: true as const, workflows };
    }

    throw new Error("Invalid callable ID");
  }
}

const workflowSendAndWaitInputSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  silent: z.coerce.boolean().optional(),
  paths: optionalNonEmptyStringListInputSchema,
  filenames: optionalNonEmptyStringListInputSchema,
  mimeTypes: optionalNonEmptyStringListInputSchema,
  replyToMessageId: z.string().min(1).optional(),
  taskDescription: z.string().min(1),
  summary: z.string().min(1),
  fromUserId: z.string().min(1).optional(),
  timeoutMs: z.coerce.number().int().positive().optional(),
});

const workflowCreateInputSchema = z.object({
  summary: z.string().min(1).describe("Compact snapshot of what we were doing"),
  tasks: z
    .array(
      z.object({
        description: z.string().min(1),
        sessionId: z.string().min(1).describe("Session/channel id where the message was sent"),
        messageId: z.string().min(1).describe("Message id to wait for replies to"),
      }),
    )
    .min(1)
    .describe("Tasks to wait on (v2: discord.wait_for_reply)"),
});

const workflowScheduleInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("wait_until"),
    summary: z.string().min(1),
    userPrompt: z.string().min(1),
    systemPrompt: z.string().min(1).optional(),
    requireDone: z.boolean().optional(),
    doneToken: z.string().min(1).optional(),
    runAtMs: z.coerce.number().int().optional(),
    runAtIso: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("wait_for"),
    summary: z.string().min(1),
    userPrompt: z.string().min(1),
    systemPrompt: z.string().min(1).optional(),
    requireDone: z.boolean().optional(),
    doneToken: z.string().min(1).optional(),
    delayMs: z.coerce.number().int().positive(),
  }),
  z.object({
    mode: z.literal("cron"),
    summary: z.string().min(1),
    userPrompt: z.string().min(1),
    systemPrompt: z.string().min(1).optional(),
    requireDone: z.boolean().optional(),
    doneToken: z.string().min(1).optional(),
    expr: z
      .string()
      .min(1)
      .refine(
        (s) => s.trim().split(/\s+/g).filter(Boolean).length === 5,
        "expr must be a 5-field cron expression",
      ),
    tz: z.string().min(1).optional(),
    startAtMs: z.coerce.number().int().optional(),
    skipMissed: z.boolean().optional(),
  }),
]);

const workflowCancelInputSchema = z.object({
  workflowId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

const workflowListInputSchema = z.object({
  state: z.enum(["queued", "running", "blocked", "resolved", "failed", "cancelled"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  includeTasks: z.boolean().optional().default(false),
});
