import { tool } from "ai";
import { z } from "zod";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { requireRequestContext } from "../../shared/req-context";

export function workflowTool(params: { bus: LilacBus }) {
  const { bus } = params;

  const workflowCreateInputSchema = z.object({
    summary: z
      .string()
      .min(1)
      .describe("Compact snapshot of what we were doing"),
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

  const workflowCreateOutputSchema = z.object({
    ok: z.literal(true),
    workflowId: z.string(),
    taskIds: z.array(z.string()),
  });

  return {
    workflow: tool({
      description: [
        "Create a workflow that will resume later.",
        "Each task waits for a strict Discord reply to the given messageId in sessionId.",
        "Use this after sending a message (e.g. DM) and you want to resume when they reply.",
      ].join("\n"),
      inputSchema: workflowCreateInputSchema,
      outputSchema: workflowCreateOutputSchema,
      execute: async (input, { experimental_context }) => {
        const ctx = requireRequestContext(experimental_context, "workflow");

        const workflowId = `wf:${crypto.randomUUID()}`;

        await bus.publish(
          lilacEventTypes.CmdWorkflowCreate,
          {
            workflowId,
            definition: {
              version: 2,
              origin: {
                request_id: ctx.requestId,
                session_id: ctx.sessionId,
                request_client: ctx.requestClient,
              },
              resumeTarget: {
                session_id: ctx.sessionId,
                request_client: ctx.requestClient,
              },
              summary: input.summary,
              completion: "all",
            },
          },
          {
            headers: {
              request_id: ctx.requestId,
              session_id: ctx.sessionId,
              request_client: ctx.requestClient,
            },
          },
        );

        const taskIds: string[] = [];

        for (let i = 0; i < input.tasks.length; i++) {
          const t = input.tasks[i]!;
          const taskId = `t:${i + 1}:${crypto.randomUUID()}`;
          taskIds.push(taskId);

          await bus.publish(
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
            {
              headers: {
                request_id: ctx.requestId,
                session_id: ctx.sessionId,
                request_client: ctx.requestClient,
              },
            },
          );
        }

        return { ok: true, workflowId, taskIds };
      },
    }),
  };
}
