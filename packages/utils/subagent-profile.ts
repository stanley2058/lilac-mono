import type { CoreConfig, SubagentProfileConfig } from "./core-config/types";

export const SUBAGENT_PROFILE_NAMES = ["explore", "general", "self"] as const;

export type NativeSubagentProfile = (typeof SUBAGENT_PROFILE_NAMES)[number];

export type ResolvedNativeSubagentProfile = Readonly<SubagentProfileConfig> & {
  name: NativeSubagentProfile;
};

export function isNativeSubagentProfile(value: unknown): value is NativeSubagentProfile {
  return (
    typeof value === "string" &&
    (SUBAGENT_PROFILE_NAMES as readonly string[]).includes(value)
  );
}

export function resolveNativeSubagentProfile(
  config: CoreConfig,
  profile: NativeSubagentProfile,
): ResolvedNativeSubagentProfile {
  return { name: profile, ...config.agent.subagents.profiles[profile] };
}

export function profileIncludes(values: readonly string[], value: string): boolean {
  return values.includes("*") || values.includes(value);
}
