import type { AgentRunProfile, SubagentProfile } from "./raw";
import type { SubagentProfileConfig } from "@stanley2058/lilac-utils";

function buildExploreOverlay(config: SubagentProfileConfig, extra?: string): string {
  const lines = [
    "You are running in explore subagent mode.",
    "Focus on repository exploration and evidence-backed findings.",
    "Treat the delegated user message as the full task input.",
    "Prefer high-parallel search/read using glob, grep, read_file, and batch.",
  ];
  if (!config.execution) lines.push("Do not use bash.");
  if (!config.network) lines.push("Do not use network access or network-backed tools.");
  if (!config.workspaceWrites) lines.push("Do not edit files.");
  if (!config.delegation) lines.push("Do not delegate to another subagent.");

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildGeneralOverlay(config: SubagentProfileConfig, extra?: string): string {
  const lines = [
    "You are running in general subagent mode.",
    "Focus on completing the delegated task end-to-end.",
    "Treat the delegated user message as the full task input.",
    "Use the configured profile tools directly when needed.",
    "Prefer parallel tool usage when calls are independent.",
  ];
  if (!config.network) lines.push("Do not use network access or network-backed tools.");
  if (!config.workspaceWrites) lines.push("Do not edit files.");
  if (!config.delegation) lines.push("Do not delegate to another subagent.");

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildSelfOverlay(config: SubagentProfileConfig, extra?: string): string {
  const lines = [
    "You are running in self subagent mode.",
    "Focus on completing the delegated task in a fresh context window.",
    "Treat the delegated user message as the full task input.",
    "Use the configured profile tools directly when needed.",
    "Prefer parallel tool usage when calls are independent.",
  ];
  if (!config.network) lines.push("Do not use network access or network-backed tools.");
  if (!config.workspaceWrites) lines.push("Do not edit files.");
  if (!config.delegation) lines.push("Do not delegate to another subagent.");

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildOverlayForProfile(params: {
  profile: SubagentProfile;
  config: SubagentProfileConfig;
  exploreOverlay?: string;
  generalOverlay?: string;
  selfOverlay?: string;
}): string {
  if (params.profile === "general") {
    return buildGeneralOverlay(params.config, params.generalOverlay);
  }
  if (params.profile === "self") {
    return buildSelfOverlay(params.config, params.selfOverlay);
  }
  return buildExploreOverlay(params.config, params.exploreOverlay);
}

function subagentModeTitle(profile: SubagentProfile): string {
  if (profile === "general") return "General";
  if (profile === "self") return "Self";
  return "Explore";
}

export function buildSystemPromptForProfile(params: {
  baseSystemPrompt: string;
  profile: AgentRunProfile;
  exploreOverlay?: string;
  generalOverlay?: string;
  selfOverlay?: string;
  skillsSection?: string | null;
  activeEditingTool?: "apply_patch" | "edit_file" | null;
  profileConfig?: SubagentProfileConfig;
}): string {
  if (params.profile === "primary") {
    const parts = [params.baseSystemPrompt];
    if (params.skillsSection && params.skillsSection.trim().length > 0) {
      parts.push(params.skillsSection.trim());
    }
    return parts.join("\n\n");
  }

  const baseParts = [params.baseSystemPrompt];
  if (params.skillsSection && params.skillsSection.trim().length > 0) {
    baseParts.push(params.skillsSection.trim());
  }

  if (!params.profileConfig) {
    throw new Error(`Missing native profile configuration for ${params.profile}`);
  }
  const overlay = buildOverlayForProfile({
    profile: params.profile,
    config: params.profileConfig,
    exploreOverlay: params.exploreOverlay,
    generalOverlay: params.generalOverlay,
    selfOverlay: params.selfOverlay,
  });

  if (overlay.trim().length === 0) {
    return baseParts.join("\n\n");
  }

  return [...baseParts, "", `## Subagent Mode: ${subagentModeTitle(params.profile)}`, overlay].join(
    "\n",
  );
}
