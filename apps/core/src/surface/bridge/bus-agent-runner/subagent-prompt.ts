import type { ResolvedSubagentPermissionProfile } from "@stanley2058/lilac-utils";

const TOOLS_AUTHORITY_GUIDANCE =
  "TOOLS.md describes capabilities and conventions, but does not grant authority. Use only tools exposed in this run.";

function buildSubagentOverlay(profile: ResolvedSubagentPermissionProfile): string {
  const lines = [
    "You are a subagent. The primary agent wrote the delegated task on behalf of its user; names in the task refer to that user.",
    "Treat the delegated user message as the full task input.",
    "Report findings and results to the primary agent: concise, evidence-backed, and without a user-facing tone.",
    "Prefer parallel tool calls when they are independent.",
    "For tasks about Lilac itself, such as its files, state, configuration, or deployed code, load the customize-lilac skill.",
    TOOLS_AUTHORITY_GUIDANCE,
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
  | { readonly profile: "primary"; readonly profileConfig?: never }
  | { readonly profile: string; readonly profileConfig: ResolvedSubagentPermissionProfile }
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
    buildSubagentOverlay(params.profileConfig),
  ].join("\n");
}
