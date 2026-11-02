import {
  applyBasePromptForProvider,
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
import { buildSystemPromptForProfile, selectWorkspaceSystemPrompt } from "./subagent-prompt";

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
  heartbeatOverlay?: string | null;
}): string {
  const workspaceSystemPrompt = selectWorkspaceSystemPrompt({
    profile: params.runProfile,
    primarySystemPrompt: params.cfg.agent.systemPrompt,
    workerSystemPrompt: params.cfg.agent.workerSystemPrompt,
  });
  const providerSystemPrompt = applyBasePromptForProvider({
    systemPrompt: workspaceSystemPrompt,
    basePrompt: params.cfg.basePrompt,
    provider: params.resolved.provider,
  });
  const profileConfig =
    params.runProfile === "primary"
      ? null
      : resolveSubagentPermissionProfile(params.cfg, params.runProfile);
  const profilePrompt = {
    baseSystemPrompt: providerSystemPrompt,
    activeEditingTool: profileConfig?.workspaceWrites === false ? null : params.editingToolMode,
    skillsSection: params.skillsSection,
  };
  const baseSystemPrompt = profileConfig
    ? buildSystemPromptForProfile({ ...profilePrompt, profile: profileConfig.name, profileConfig })
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
    params.heartbeatOverlay,
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
