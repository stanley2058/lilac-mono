import {
  applyBasePrompt,
  resolveCoreConfigPath,
  resolveSubagentPermissionProfile,
  type CoreConfig,
  type EditingToolMode,
  type ResolvedModelRef,
} from "@stanley2058/lilac-utils";

import type { AgentRunProfile } from "./raw";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import type { SurfaceMetadataMessage } from "../surface-metadata";
import type { SessionSafetyMode } from "../../session-policy";
import {
  appendAdditionalSessionMemoBlock,
  appendConfiguredAliasPromptBlock,
  buildGeneratedMessageOverlay,
  buildRestrictedSessionOverlay,
  buildSurfaceMetadataOverlay,
  buildDiscordOutputOverlay,
  buildNativeOutputOverlay,
  maybeAppendResponseCommentaryPrompt,
} from "./prompt-overlays";
import {
  buildSystemPromptForProfile,
  selectWorkspaceSystemPrompt,
  type SubagentConversation,
} from "./subagent-prompt";

export function buildAgentRunSystemPrompt(params: {
  cfg: CoreConfig;
  runProfile: AgentRunProfile;
  requestClient: AdapterPlatform;
  resolved: ResolvedModelRef;
  editingToolMode: EditingToolMode;
  skillsSection: string | null;
  additionalSessionPrompts: readonly string[];
  messages: readonly SurfaceMetadataMessage[];
  safetyMode: SessionSafetyMode;
  sessionId: string;
  subagentConversation?: SubagentConversation;
}): string {
  const workspaceSystemPrompt = selectWorkspaceSystemPrompt({
    profile: params.runProfile,
    primarySystemPrompt: params.cfg.agent.systemPrompt,
    workerSystemPrompt: params.cfg.agent.workerSystemPrompt,
  });
  const systemPrompt = applyBasePrompt({
    systemPrompt: workspaceSystemPrompt,
    basePrompt: params.cfg.basePrompt,
  });
  const profileConfig =
    params.runProfile === "primary"
      ? null
      : resolveSubagentPermissionProfile(params.cfg, params.runProfile);
  const profilePrompt = {
    baseSystemPrompt: systemPrompt,
    activeEditingTool: profileConfig?.workspaceWrites === false ? null : params.editingToolMode,
    skillsSection: params.skillsSection,
  };
  const baseSystemPrompt = profileConfig
    ? buildSystemPromptForProfile({
        ...profilePrompt,
        profile: profileConfig.name,
        profileConfig,
        ...(params.subagentConversation ? { conversation: params.subagentConversation } : {}),
      })
    : buildSystemPromptForProfile({ ...profilePrompt, profile: "primary" });

  let prompt = appendConfiguredAliasPromptBlock({
    baseSystemPrompt,
    cfg: params.cfg,
    coreConfigPath: resolveCoreConfigPath(),
  });
  prompt = appendAdditionalSessionMemoBlock(prompt, params.additionalSessionPrompts);

  const surfaceMetadataOverlay = buildSurfaceMetadataOverlay(params.messages);
  const restrictedSessionOverlay =
    params.safetyMode === "restricted"
      ? buildRestrictedSessionOverlay({ sessionId: params.sessionId })
      : null;
  for (const overlay of [
    buildGeneratedMessageOverlay(),
    surfaceMetadataOverlay,
    params.requestClient === "discord" ? buildDiscordOutputOverlay() : null,
    params.requestClient === "native" ? buildNativeOutputOverlay() : null,
    restrictedSessionOverlay,
  ]) {
    if (overlay?.trim()) prompt = `${prompt}\n\n${overlay}`;
  }

  return maybeAppendResponseCommentaryPrompt({
    baseSystemPrompt: prompt,
    provider: params.resolved.provider,
    responseCommentary: params.resolved.responseCommentary,
  });
}
