import type {
  CoreConfig,
  RouterSessionConfig,
  RouterSessionConfigScope,
} from "./core-config/types";

/** Resolve per-property session overrides from broadest to most specific scope. */
export function resolveRouterSessionConfig(
  cfg: CoreConfig,
  scope: RouterSessionConfigScope,
): RouterSessionConfig {
  const resolved: RouterSessionConfig = {};

  for (const candidate of [scope.guildId, scope.parentChannelId, scope.sessionId]) {
    const configId = candidate?.trim();
    if (!configId) continue;

    Object.assign(resolved, cfg.surface.router.sessionModes[configId]);
  }

  return resolved;
}
