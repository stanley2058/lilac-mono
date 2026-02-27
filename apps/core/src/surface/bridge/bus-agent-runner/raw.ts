const SUBAGENT_PROFILES = ["explore", "general", "self"] as const;

export type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];
export type AgentRunProfile = "primary" | SubagentProfile;

export type ParsedSubagentMeta = {
  profile: AgentRunProfile;
  depth: number;
};

export function parseRouterSessionModeFromRaw(raw: unknown): "mention" | "active" | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)["sessionMode"];
  if (value === "mention" || value === "active") return value;
  return null;
}

export function parseSessionConfigIdFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)["sessionConfigId"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseRequestModelOverrideFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)["modelOverride"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type RequestControl = {
  requiresActive: boolean;
  cancel: boolean;
  cancelQueued: boolean;
  targetMessageId: string | null;
};

export function parseRequestControlFromRaw(raw: unknown): RequestControl {
  if (!raw || typeof raw !== "object") {
    return {
      requiresActive: false,
      cancel: false,
      cancelQueued: false,
      targetMessageId: null,
    };
  }

  const record = raw as Record<string, unknown>;
  return {
    requiresActive: record["requiresActive"] === true,
    cancel: record["cancel"] === true,
    cancelQueued: record["cancelQueued"] === true,
    targetMessageId: typeof record["messageId"] === "string" ? record["messageId"] : null,
  };
}

export function parseBufferedForActiveRequestIdFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>)["bufferedForActiveRequestId"];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getChainMessageIdsFromRaw(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== "object") return [];
  const value = (raw as Record<string, unknown>)["chainMessageIds"];
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

export function requestRawReferencesMessage(raw: unknown, messageId: string): boolean {
  return getChainMessageIdsFromRaw(raw).includes(messageId);
}

function isSubagentProfile(value: unknown): value is SubagentProfile {
  return typeof value === "string" && (SUBAGENT_PROFILES as readonly string[]).includes(value);
}

export function parseSubagentMetaFromRaw(raw: unknown): ParsedSubagentMeta {
  if (!raw || typeof raw !== "object") {
    return { profile: "primary", depth: 0 };
  }

  const subagent = (raw as Record<string, unknown>)["subagent"];
  if (!subagent || typeof subagent !== "object") {
    return { profile: "primary", depth: 0 };
  }

  const data = subagent as Record<string, unknown>;
  const rawProfile = data["profile"];
  const profile: AgentRunProfile = isSubagentProfile(rawProfile) ? rawProfile : "primary";

  const depthRaw = data["depth"];
  const defaultDepth = profile === "primary" ? 0 : 1;
  const depth =
    typeof depthRaw === "number" && Number.isFinite(depthRaw)
      ? Math.max(0, Math.trunc(depthRaw))
      : defaultDepth;

  return { profile, depth };
}
