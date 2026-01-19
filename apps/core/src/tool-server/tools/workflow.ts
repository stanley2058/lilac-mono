import { z } from "zod";

import {
  lilacEventTypes,
  type AdapterPlatform,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";

import type { RequestContext, ServerTool } from "../types";

type RequestHeaders = {
  request_id: string;
  session_id: string;
  request_client: AdapterPlatform;
};

function isAdapterPlatform(x: unknown): x is AdapterPlatform {
  return (
    x === "discord" ||
    x === "whatsapp" ||
    x === "slack" ||
    x === "telegram" ||
    x === "web" ||
    x === "unknown"
  );
}

function toHeaders(ctx: RequestContext | undefined): RequestHeaders {
  const requestId = ctx?.requestId;
  const sessionId = ctx?.sessionId;
  const requestClient = ctx?.requestClient;

  if (!requestId || !sessionId || !requestClient) {
    throw new Error(
      "workflow tool requires request context (requestId/sessionId/requestClient)",
    );
  }

  if (!isAdapterPlatform(requestClient)) {
    throw new Error(`Invalid requestClient '${requestClient}'`);
  }

  return {
    request_id: requestId,
    session_id: sessionId,
    request_client: requestClient,
  };
}

export class Workflow implements ServerTool {
  id = "workflow";

  constructor(private readonly params: { bus: LilacBus }) {}

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

      await this.params.bus.publish(
        lilacEventTypes.CmdWorkflowTaskCreate,
        {
          workflowId,
          taskId,
          kind: "discord.wait_for_reply",
          description: t.description,
          input: {
            channelId: t.sessionId,
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
        messageId: z.string().min(1).describe("Message id to wait for replies to"),
      }),
    )
    .min(1)
    .describe("Tasks to wait on (v2: discord.wait_for_reply)"),
});
