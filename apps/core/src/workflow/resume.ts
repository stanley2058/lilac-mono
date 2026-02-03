import type { ModelMessage } from "ai";

import type {
  ResumeContext,
  ResumeRequest,
  WorkflowDefinitionV2,
  WorkflowRecord,
  WorkflowTaskRecord,
} from "./types";

function formatMention(requestClient: string, userId: string): string {
  if (requestClient === "discord") {
    return `<@${userId}>`;
  }
  return `@${userId}`;
}

function toResumeContext(
  w: WorkflowRecord & { definition: WorkflowDefinitionV2 },
  tasks: WorkflowTaskRecord[],
): ResumeContext {
  return {
    workflow: {
      workflowId: w.workflowId,
      summary: w.definition.summary,
      origin: w.definition.origin,
      resumeTarget: w.definition.resumeTarget,
      completion: w.definition.completion,
    },
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      kind: t.kind,
      description: t.description,
      state: t.state,
      input: t.input,
      result: t.result,
      resolvedAt: t.resolvedAt,
    })),
  };
}

function formatContextForSystemMessage(ctx: ResumeContext): string {
  const lines: string[] = [];

  lines.push("You are resuming work from a saved workflow.");
  lines.push("");
  lines.push(`Workflow: ${ctx.workflow.workflowId}`);
  lines.push("Summary:");
  lines.push(ctx.workflow.summary.trim());
  lines.push("");

  lines.push("Tasks:");
  for (const t of ctx.tasks) {
    lines.push(`- [${t.state}] ${t.taskId} (${t.kind})`);
    lines.push(`  description: ${t.description}`);
    if (t.result !== undefined) {
      // Keep JSON compact; this ends up in model context.
      try {
        lines.push(`  result: ${JSON.stringify(t.result)}`);
      } catch {
        lines.push("  result: <unserializable>");
      }
    }
  }

  lines.push("");

  const mentionUserId = ctx.workflow.resumeTarget.mention_user_id;
  if (mentionUserId) {
    const mention = formatMention(ctx.workflow.resumeTarget.request_client, mentionUserId);
    lines.push(
      `When you respond, post to the resume target session and mention ${mention}.`,
    );
  } else {
    lines.push("When you respond, post to the resume target session.");
  }

  lines.push("Do not assume prior chat history is available.");

  return lines.join("\n");
}

export function buildResumeRequest(params: {
  workflow: WorkflowRecord & { definition: WorkflowDefinitionV2 };
  tasks: WorkflowTaskRecord[];
  triggerUserText: string;
  triggerMeta: {
    platform: string;
    channelId: string;
    messageId: string;
    userId: string;
    userName?: string;
    ts: number;
  };
  requestId: string;
}): ResumeRequest {
  const ctx = toResumeContext(params.workflow, params.tasks);

  const systemText = formatContextForSystemMessage(ctx);

  const userTextLines: string[] = [];
  userTextLines.push("Workflow trigger:");
  userTextLines.push(
    `[${params.triggerMeta.platform} channel_id=${params.triggerMeta.channelId} message_id=${params.triggerMeta.messageId} user_id=${params.triggerMeta.userId}]`,
  );
  if (params.triggerMeta.userName) {
    userTextLines.push(`user_name=${params.triggerMeta.userName}`);
  }
  userTextLines.push("");
  userTextLines.push(params.triggerUserText);

  const messages: ModelMessage[] = [
    { role: "system", content: systemText },
    { role: "user", content: userTextLines.join("\n").trim() },
  ];

  return {
    requestId: params.requestId,
    sessionId: params.workflow.definition.resumeTarget.session_id,
    requestClient: params.workflow.definition.resumeTarget.request_client,
    queue: "prompt",
    messages,
    raw: {
      workflow: ctx.workflow,
      tasks: ctx.tasks,
      trigger: params.triggerMeta,
    },
  };
}
