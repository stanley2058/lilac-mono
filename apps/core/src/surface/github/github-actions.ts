import type { SurfaceAction } from "../types";

const ACTION_REPLY_PATTERN = /^lilac-workflow-action ([1-9][0-9]*) ([A-Za-z0-9_-]{16,200})$/u;

export function parseGithubWorkflowActionReply(
  body: string,
): { messageId: string; actionId: string } | null {
  const match = ACTION_REPLY_PATTERN.exec(body);
  if (!match) return null;
  return { messageId: match[1]!, actionId: match[2]! };
}

export function renderGithubActionInstructions(
  messageId: string,
  actions: readonly SurfaceAction[],
): string {
  if (actions.length === 0) return "";
  return [
    "### Actions",
    "Reply with exactly one command (no code fence or additional text):",
    ...actions.map(
      (action) => `- ${action.label}: \`lilac-workflow-action ${messageId} ${action.actionId}\``,
    ),
  ].join("\n");
}

export function renderGithubActionContent(input: {
  text: string;
  messageId: string;
  actions: readonly SurfaceAction[];
}): string {
  const instructions = renderGithubActionInstructions(input.messageId, input.actions);
  return [input.text.trim(), instructions].filter((part) => part.length > 0).join("\n\n");
}
