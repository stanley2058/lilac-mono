import type { ToolResultArtifactStore } from "@stanley2058/lilac-tool-results";

export const DEFAULT_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ARTIFACT_MAX_BYTES_PER_SCOPE = 50 * 1024 * 1024;
export const DEFAULT_BASH_SPOOL_MAX_BYTES = 50 * 1024 * 1024;

/** Caller-owned artifact authority. The scope is fixed when the toolset is created. */
export type CodingToolArtifactIntegration = {
  artifacts: ToolResultArtifactStore;
  scopeId: string;
  requestId: string;
  ttlMs?: number;
  maxBytesPerScope?: number;
  maxArtifactBytes?: number;
  maxSpoolBytes?: number;
};
