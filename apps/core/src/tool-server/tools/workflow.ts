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

type RequestHeaders = RequiredToolServerHeaders;

function toHeaders(ctx: RequestContext | undefined): RequestHeaders {
  return requireToolServerHeaders(ctx, "workflow");
}

export class Workflow implements ServerTool {
  id = "workflow";

  constructor(
    private readonly params: {
      bus: LilacBus;
      adapter?: SurfaceAdapter;
      config?: CoreConfig;
      getConfig?: () => Promise<CoreConfig>;
    },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "workflow",
        name: "Workflow",
        description:
          "Create a workflow that will resume later. Each task waits for a strict reply to the given messageId in sessionId. Use this after sending a message (e.g. DM) and you want to resume when they reply.",
        shortInput: ["--summary=<string>", "--tasks=<object[]>"],
        input: [
          "--summary=<string> | Compact snapshot of what we were doing",
          "--tasks=<array> | JSON array of { description, sessionId, messageId }",
        ],
      },
      {
        callableId: "workflow.send_and_wait_for_reply",
        name: "Workflow Send And Wait For Reply",
        description:
          "Send a message to a Discord session and create a workflow task that waits for a reply to that message. (This is a convenience wrapper around: surface.messages.send + workflow.)",
        shortInput: [
          "--sessionId=<string>",
          "--text=<string>",
          "--taskDescription=<string>",
          "--summary=<string>",
        ],
        input: [
          "--sessionId=<string> | Target session/channel (raw id, <#id>, or configured token alias)",
          "--text=<string> | Message to send",
          "--paths=<string[]> | Optional local attachment paths",
          "--filenames=<string[]> | Optional filenames for each attachment",
          "--mimeTypes=<string[]> | Optional mime types for each attachment",
          "--replyToMessageId=<string> | Optional reply target id",
          "--taskDescription=<string> | Description for the wait_for_reply task",
          "--summary=<string> | Workflow summary to be used on resume",
          "--fromUserId=<string> | Optional user id restriction for replies",
          "--timeoutMs=<number> | Optional timeout for waiting",
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

    if (callableId === "workflow") {
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

    if (callableId === "workflow.send_and_wait_for_reply") {
      const payload = workflowSendAndWaitInputSchema.parse(input);
      const headers = toHeaders(opts?.context);

      const cfg = await getCfg();
      if (!cfg) {
        throw new Error(
          "workflow.send_and_wait_for_reply requires core config (tool server must be started with config)",
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
          `workflow.send_and_wait_for_reply currently requires request_client=discord (got '${requestClient}')`,
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
          "workflow.send_and_wait_for_reply requires surface adapter (tool server must be started with adapter)",
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
        replyTo ? ({ replyTo } satisfies SendOpts) : undefined,
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

    throw new Error("Invalid callable ID");
  }
}

const workflowSendAndWaitInputSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  paths: z.array(z.string().min(1)).optional(),
  filenames: z.array(z.string().min(1)).optional(),
  mimeTypes: z.array(z.string().min(1)).optional(),
  replyToMessageId: z.string().min(1).optional(),
  taskDescription: z.string().min(1),
  summary: z.string().min(1),
  fromUserId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const workflowCreateInputSchema = z.object({
  summary: z.string().min(1).describe("Compact snapshot of what we were doing"),
  tasks: z
    .array(
      z.object({
        description: z.string().min(1),
        sessionId: z
          .string()
          .min(1)
          .describe("Session/channel id where the message was sent"),
        messageId: z
          .string()
          .min(1)
          .describe("Message id to wait for replies to"),
      }),
    )
    .min(1)
    .describe("Tasks to wait on (v2: discord.wait_for_reply)"),
});
