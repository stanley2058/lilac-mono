import type { AgentRunProfile, SubagentProfile } from "./raw";

function buildExploreOverlay(extra?: string): string {
  const lines = [
    "You are running in explore subagent mode.",
    "Focus on repository exploration and evidence-backed findings.",
    "Treat the delegated user message as the full task input.",
    "Prefer high-parallel search/read using glob, grep, read_file, and batch.",
    "Do not use bash.",
    "Do not edit files.",
    "Do not delegate to another subagent.",
  ];

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildGeneralOverlay(extra?: string): string {
  const lines = [
    "You are running in general subagent mode.",
    "Focus on completing the delegated task end-to-end.",
    "Treat the delegated user message as the full task input.",
    "Use available tools directly, including edits and bash when needed.",
    "Prefer parallel tool usage when calls are independent.",
    "Do not delegate to another subagent.",
  ];

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildSelfOverlay(extra?: string): string {
  const lines = [
    "You are running in self subagent mode.",
    "Focus on completing the delegated task in a fresh context window.",
    "Treat the delegated user message as the full task input.",
    "Use available tools directly, including edits and bash when needed.",
    "Prefer parallel tool usage when calls are independent.",
  ];

  if (extra && extra.trim().length > 0) {
    lines.push(extra.trim());
  }

  return lines.join("\n");
}

function buildOverlayForProfile(params: {
  profile: SubagentProfile;
  exploreOverlay?: string;
  generalOverlay?: string;
  selfOverlay?: string;
}): string {
  if (params.profile === "general") {
    return buildGeneralOverlay(params.generalOverlay);
  }
  if (params.profile === "self") {
    return buildSelfOverlay(params.selfOverlay);
  }
  return buildExploreOverlay(params.exploreOverlay);
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

  const overlay = buildOverlayForProfile({
    profile: params.profile,
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
