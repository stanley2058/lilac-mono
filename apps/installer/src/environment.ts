import type { ResolvedDeployment } from "./compose-inspection";
import { readEnvironment } from "./deployment";

export function readSetupEnvironment(existing?: ResolvedDeployment, source?: string) {
  if (!existing) return { secrets: readEnvironment(source ?? "") };
  const gateway = existing.services["computer-use-gateway"]?.environment;
  const values = { ...gateway, ...existing.services.lilac.environment };
  for (const key of [
    "MCP_BEARER_SECRET",
    "BIND_ADDR",
    "RENDERED_HOST",
    "PORT_RANGE_START",
    "PORT_RANGE_END",
  ]) {
    if (gateway?.[key] !== undefined) values[key] = gateway[key];
  }
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) secrets[key] = value;
  }
  return { secrets, preservedEnvironmentSource: source ?? "" };
}
