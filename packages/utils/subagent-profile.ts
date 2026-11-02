import type {
  CoreConfig,
  SubagentExecution,
  SubagentPermissionProfileConfig,
} from "./core-config/types";

const PERMISSION_PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

/** Profile names are short lowercase slugs; "primary" names the top-level run. */
export function isPermissionProfileName(name: string): boolean {
  return PERMISSION_PROFILE_NAME_PATTERN.test(name) && name !== "primary";
}

export type ResolvedSubagentPermissionProfile = Readonly<SubagentPermissionProfileConfig> & {
  name: string;
};

// Runs, checkpoints, and workflow sources persisted before permission profiles
// carry the retired role names. A configured profile with the same name wins.
const LEGACY_ROLE_PERMISSION_PROFILES: Readonly<Record<string, string>> = {
  explore: "restricted",
  general: "full",
  self: "full",
};

const DENY_ALL_PERMISSIONS: SubagentPermissionProfileConfig = {
  level1: { tools: [], plugins: [] },
  level2: { callables: [], plugins: [] },
  network: false,
  workspaceWrites: false,
  execution: false,
  delegation: false,
};

function configuredPermissionProfile(
  config: CoreConfig,
  name: string,
): SubagentPermissionProfileConfig | undefined {
  const profiles = config.agent.subagents.permissions;
  return Object.hasOwn(profiles, name) ? profiles[name] : undefined;
}

/** Resolves the configured profile name, mapping legacy role names when no profile has that name. */
export function resolveSubagentPermissionProfileName(
  config: CoreConfig,
  name: string,
): string | undefined {
  if (configuredPermissionProfile(config, name)) return name;
  if (!Object.hasOwn(LEGACY_ROLE_PERMISSION_PROFILES, name)) return undefined;
  const mapped = LEGACY_ROLE_PERMISSION_PROFILES[name]!;
  return configuredPermissionProfile(config, mapped) ? mapped : undefined;
}

/**
 * Resolves a run's permission profile. A name that no longer exists in config
 * resolves to an empty authority so a stale run cannot gain tools.
 */
export function resolveSubagentPermissionProfile(
  config: CoreConfig,
  name: string,
): ResolvedSubagentPermissionProfile {
  const resolvedName = resolveSubagentPermissionProfileName(config, name);
  const profile =
    resolvedName === undefined ? undefined : configuredPermissionProfile(config, resolvedName);
  return { name: resolvedName ?? name, ...(profile ?? DENY_ALL_PERMISSIONS) };
}

export function profileIncludes(values: readonly string[], value: string): boolean {
  return values.includes("*") || values.includes(value);
}

function profileListWithin(child: readonly string[], parent: readonly string[]): boolean {
  if (parent.includes("*")) return true;
  if (child.includes("*")) return false;
  return child.every((value) => parent.includes(value));
}

const EXECUTION_RANK: Readonly<Record<string, number>> = {
  false: 0,
  restricted: 1,
  native: 2,
};

function executionRank(execution: SubagentExecution): number {
  return EXECUTION_RANK[String(execution)] ?? 0;
}

/** True when every authority granted by `child` is also granted by `parent`. */
export function isPermissionProfileWithin(
  child: Readonly<SubagentPermissionProfileConfig>,
  parent: Readonly<SubagentPermissionProfileConfig>,
): boolean {
  return (
    profileListWithin(child.level1.tools, parent.level1.tools) &&
    profileListWithin(child.level1.plugins, parent.level1.plugins) &&
    profileListWithin(child.level2.callables, parent.level2.callables) &&
    profileListWithin(child.level2.plugins, parent.level2.plugins) &&
    (!child.network || parent.network) &&
    (!child.workspaceWrites || parent.workspaceWrites) &&
    (!child.delegation || parent.delegation) &&
    executionRank(child.execution) <= executionRank(parent.execution)
  );
}
