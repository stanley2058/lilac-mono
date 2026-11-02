import {
  isPermissionProfileWithin,
  profileIncludes,
  resolveSubagentPermissionProfile,
  type CoreConfig,
} from "@stanley2058/lilac-utils";

// Workflow runs and triggers dispatch agent() children by profile name without
// recording who started them, so only a run that already holds every
// configured profile's authority may start or resume one.
const WORKFLOW_LAUNCH_CALLABLES = new Set([
  "workflow.run.trigger",
  "workflow.run.resume",
  "workflow.trigger.create",
]);

function profileHoldsEveryConfiguredProfile(
  config: CoreConfig,
  profile: ReturnType<typeof resolveSubagentPermissionProfile>,
): boolean {
  if (!profile.delegation) return false;
  return Object.values(config.agent.subagents.permissions).every((candidate) =>
    isPermissionProfileWithin(candidate, profile),
  );
}

function profileAllowsLevel2Contribution(
  profile: ReturnType<typeof resolveSubagentPermissionProfile>,
  params: { readonly pluginId: string; readonly callableId: string },
): boolean {
  return (
    profileIncludes(profile.level2.plugins, params.pluginId) &&
    profileIncludes(profile.level2.callables, params.callableId)
  );
}

export function isLevel2ContributionAllowedForNativeProfile(params: {
  readonly config: CoreConfig;
  readonly profileName: string;
  readonly pluginId: string;
  readonly callableId: string;
}): boolean {
  const profile = resolveSubagentPermissionProfile(params.config, params.profileName);
  if (!profileAllowsLevel2Contribution(profile, params)) return false;
  if (!WORKFLOW_LAUNCH_CALLABLES.has(params.callableId)) return true;
  return profileHoldsEveryConfiguredProfile(params.config, profile);
}

export function isWebFetchAllowedForNativeProfile(params: {
  readonly config: CoreConfig;
  readonly profileName: string;
}): boolean {
  const profile = resolveSubagentPermissionProfile(params.config, params.profileName);
  if (!profile.network) return false;
  return profileAllowsLevel2Contribution(profile, { pluginId: "web", callableId: "fetch" });
}
