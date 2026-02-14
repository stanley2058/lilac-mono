import type { ModelMessage } from "ai";

import type { WorkflowDefinitionV3 } from "./types";

function formatTs(ms: number): string {
  return new Date(ms).toISOString();
}

export function buildScheduledJobMessages(params: {
  workflowId: string;
  taskId: string;
  runSeq: number;
  firedAtMs: number;
  definition: WorkflowDefinitionV3;
}): ModelMessage[] {
  const def = params.definition;

  const requireDone = def.job.requireDone ?? true;
  const doneToken = (def.job.doneToken ?? "DONE").trim() || "DONE";

  const lines: string[] = [];
  lines.push("You are running an automated scheduled job.");
  lines.push("");
  lines.push(`Workflow: ${params.workflowId}`);
  lines.push(`Task: ${params.taskId}`);
  lines.push(`Run: ${params.runSeq}`);
  lines.push(`FiredAt: ${formatTs(params.firedAtMs)}`);
  lines.push("");
  lines.push("Output policy:");
  lines.push("- Do not write normal assistant text intended for a user; it will be ignored.");
  lines.push("- To produce user-visible output, use the bash tool to run the `tools` CLI.");
  lines.push(
    '- Default (reply in the active session/channel): tools surface.messages.send --text="..."',
  );
  lines.push(
    "- If you need to post to a different session/channel, pass: --client=discord --session-id=<channelId>",
  );
  lines.push(
    "- Note: --session-id is a channel id (e.g. '1462714189553598555'), not a request id like 'req:<uuid>'.",
  );
  if (requireDone) {
    lines.push("");
    lines.push(`When you are finished, respond with exactly '${doneToken}' and nothing else.`);
  }

  if (def.job.systemPrompt && def.job.systemPrompt.trim().length > 0) {
    lines.push("");
    lines.push("Job system notes:");
    lines.push(def.job.systemPrompt.trim());
  }

  const userLines: string[] = [];
  userLines.push("Job:");
  userLines.push(def.job.summary.trim());
  userLines.push("");
  userLines.push(def.job.userPrompt.trim());

  return [
    { role: "system", content: lines.join("\n").trim() },
    { role: "user", content: userLines.join("\n").trim() },
  ];
}
