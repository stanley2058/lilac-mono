import {
  createCorePrimaryLineageFreshOnlyV2,
  type CorePrimaryLineageV2,
} from "@stanley2058/lilac-event-bus";

/**
 * Builds a fresh-only lineage. Construction rejects only an empty reason or an invalid start,
 * which falls back to a fixed fresh-only lineage instead of failing the caller.
 */
export function createFreshOnlyLineage(
  reason: string,
  currentCanonicalStart = 0,
): CorePrimaryLineageV2 {
  return createCorePrimaryLineageFreshOnlyV2(
    reason,
    currentCanonicalStart,
  ).match<CorePrimaryLineageV2>({
    ok: (value) => value,
    err: () => ({
      state: "fresh-only",
      lineageVersion: 2,
      currentCanonicalStart: 0,
      reason: "lineage-fallback-construction-failed",
    }),
  });
}
