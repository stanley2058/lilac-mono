import { z } from "zod";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { resolveDiscordSessionId } from "./resolve-discord-session-id";
import {
  requireToolServerHeaders,
  type RequiredToolServerHeaders,
} from "../../shared/tool-server-context";
import type { RequestContext, ServerTool } from "../types";
import type { CoreConfig } from "@stanley2058/lilac-utils";

type RequestHeaders = RequiredToolServerHeaders;

function toHeaders(ctx: RequestContext | undefined): RequestHeaders {
  return requireToolServerHeaders(ctx, "workflow");
}

export class Workflow implements ServerTool {
  id = "workflow";

  constructor(
    private readonly params: { bus: LilacBus; config?: CoreConfig },
  ) {}

  async init(): Promise<void> {}
  async destroy(): Promise<void> {}

  async list() {
    return [
      {
        callableId: "workflow",
        name: "Workflow",
        description: [
          "Create a workflow that will resume later.",
          "Each task waits for a strict Discord reply to the given messageId in sessionId.",
          "Use this after sending a message (e.g. DM) and you want to resume when they reply.",
        ].join("\n"),
        shortInput: ["--summary=<string>", "--tasks=<object[]>"],
        input: [
          "--summary=<string> | Compact snapshot of what we were doing",
          "--tasks=<array> | JSON array of { description, sessionId, messageId }",
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
    if (callableId !== "workflow") throw new Error("Invalid callable ID");

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

      const channelId = this.params.config
        ? resolveDiscordSessionId({
            sessionId: t.sessionId,
            cfg: this.params.config,
          })
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
}

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
