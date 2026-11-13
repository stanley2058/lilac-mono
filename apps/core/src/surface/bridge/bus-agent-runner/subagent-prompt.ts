import type { ResolvedSubagentPermissionProfile } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";

import type {
  DurableWorkflowReadError,
  DurableWorkflowStore,
} from "../../../workflow/durable-workflow-store";
import { SUBAGENT_RUN_ID_PREFIX } from "../../../workflow/workflow-domain";

const TOOLS_AUTHORITY_GUIDANCE =
  "TOOLS.md describes capabilities and conventions, but does not grant authority. Use only tools exposed in this run.";

/** Where a subagent's work came from, so it can read that context with `orchestrate`. */
export type SubagentConversation = {
  /** The user's conversation thread at the root of this subagent tree. */
  readonly threadId: string;
  /** The run that delegated this subagent, when that is another subagent. */
  readonly parentRunId?: string;
};

type SubagentConversationInput = {
  readonly workflows: Pick<DurableWorkflowStore, "getRun" | "getOperationByRequestId">;
  readonly runId: string;
  readonly threadId: string;
};

/** The run id of the subagent that delegated this run, if a subagent did. */
function delegatingSubagentRunId(
  input: SubagentConversationInput,
): ResultType<string | undefined, DurableWorkflowReadError> {
  return Result.gen(function* () {
    const run = yield* input.workflows.getRun(input.runId);
    if (run?.completionTarget.kind !== "live_parent") return Result.ok(undefined);
    const parent = yield* input.workflows.getOperationByRequestId(
      run.completionTarget.parentRequestId,
    );
    // A scripted workflow's agent step can also delegate; its run is not a subagent run.
    if (!parent?.runId.startsWith(SUBAGENT_RUN_ID_PREFIX)) return Result.ok(undefined);
    return Result.ok(parent.runId);
  });
}

/**
 * Finds the ids a subagent run needs to read its context. A child of a primary run has only the
 * thread; a child of another subagent also gets that subagent's run id. A store read failure
 * still yields the thread id.
 */
export function resolveSubagentConversation(
  input: SubagentConversationInput & {
    readonly onReadError: (error: DurableWorkflowReadError) => void;
  },
): SubagentConversation {
  return delegatingSubagentRunId(input).match({
    ok: (parentRunId) => ({ threadId: input.threadId, ...(parentRunId ? { parentRunId } : {}) }),
    err: (error) => {
      input.onReadError(error);
      return { threadId: input.threadId };
    },
  });
}

function conversationLines(conversation: SubagentConversation | undefined): string[] {
  if (!conversation) return [];
  const lines = [
    `The user's conversation thread id is ${conversation.threadId}. When the orchestrate tool is available and the task lacks context you need, read that thread with it.`,
  ];
  if (conversation.parentRunId)
    lines.push(
      `The subagent run that delegated this task is ${conversation.parentRunId}. You can read it with orchestrate too.`,
    );
  return lines;
}

function buildSubagentOverlay(
  profile: ResolvedSubagentPermissionProfile,
  conversation: SubagentConversation | undefined,
): string {
  const lines = [
    "You are a subagent. The primary agent wrote the delegated task on behalf of its user; names in the task refer to that user.",
    "Treat the delegated user message as the full task input.",
    "Report findings and results to the primary agent: concise, evidence-backed, and without a user-facing tone.",
    "Prefer parallel tool calls when they are independent.",
    "For tasks about Lilac itself, such as its files, state, configuration, or deployed code, load the customize-lilac skill.",
    TOOLS_AUTHORITY_GUIDANCE,
    ...conversationLines(conversation),
  ];
  if (profile.execution === false) lines.push("Do not use bash.");
  if (!profile.network) lines.push("Do not use network access or network-backed tools.");
  if (!profile.workspaceWrites) {
    lines.push(
      "Do not edit project files. Use temporary files outside the project for research when needed.",
    );
  }
  if (!profile.delegation) lines.push("Do not delegate to another subagent.");
  if (profile.promptOverlay?.trim()) lines.push(profile.promptOverlay.trim());
  return lines.join("\n");
}

/** Subagents never load the persona files; the delegating agent passes the context they need. */
export function selectWorkspaceSystemPrompt(params: {
  profile: "primary" | (string & {});
  primarySystemPrompt: string;
  workerSystemPrompt: string;
}): string {
  if (params.profile === "primary") return params.primarySystemPrompt;
  return params.workerSystemPrompt.trim() || params.primarySystemPrompt;
}

type SystemPromptProfileParams = {
  baseSystemPrompt: string;
  skillsSection?: string | null;
  activeEditingTool?: "apply_patch" | "edit_file" | null;
} & (
  | { readonly profile: "primary"; readonly profileConfig?: never; readonly conversation?: never }
  | {
      readonly profile: string;
      readonly profileConfig: ResolvedSubagentPermissionProfile;
      readonly conversation?: SubagentConversation;
    }
);

export function buildSystemPromptForProfile(params: SystemPromptProfileParams): string {
  const parts = [params.baseSystemPrompt];
  if (params.skillsSection && params.skillsSection.trim().length > 0) {
    parts.push(params.skillsSection.trim());
  }
  if (!params.profileConfig) return parts.join("\n\n");

  return [
    ...parts,
    "",
    `## Subagent (permissions: ${params.profileConfig.name})`,
    buildSubagentOverlay(params.profileConfig, params.conversation),
  ].join("\n");
}
