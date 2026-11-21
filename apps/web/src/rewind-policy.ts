import { dmRewindReasonText, type DmRewindReason } from "@stanley2058/lilac-client-protocol";

export type RewindReason = DmRewindReason | "loading" | "unavailable" | "changed";
export type RewindRestriction = { turnId?: string; reason?: RewindReason };

export function rewindReasonText(reason: RewindReason): string {
  if (reason === "changed") return "The conversation changed. Close this dialog and try again.";
  if (reason === "loading") return "Loading rewind availability.";
  if (reason === "unavailable") return "Load the latest turn before rewinding.";
  return dmRewindReasonText(reason);
}

const tooltipReasons: Record<RewindReason, string> = {
  busy: "Wait for active run to finish",
  "not-latest": "Latest turn only",
  outside: "Blocked by outside messages",
  unsettled: "Wait for this turn to finish",
  expired: "Rewind window expired",
  loading: "Checking availability",
  unavailable: "Load latest turn first",
  changed: "Conversation changed",
};

export function rewindTooltipText(reason: RewindReason): string {
  return tooltipReasons[reason];
}

export function rewindRestrictionReason(
  restriction: RewindRestriction | undefined,
  turnId: string | undefined,
): RewindReason | undefined {
  if (!restriction) return undefined;
  return restriction.reason ?? (restriction.turnId !== turnId ? "not-latest" : undefined);
}

export function rewindRejectionReason(message: string): RewindReason | undefined {
  if (message === "Thread changed before rewind") return "changed";
  if (message === "Wait for cancellation to finish.") return "busy";
  const reasons = ["busy", "not-latest", "outside", "unsettled", "expired"] as const;
  return reasons.find((reason) => dmRewindReasonText(reason) === message);
}
