import { startsContextWindow, type ContextWindowOutline } from "@stanley2058/lilac-client-protocol";

export type OutlineTurnTiming = {
  position: number;
  createdAt: number | null;
  completedAt: number | null;
};

type OpenWindow = {
  firstPosition: number;
  lastPosition: number;
  startAt: number | null;
  endAt: number | null;
  continues: boolean;
};

function closeWindow(window: OpenWindow): ContextWindowOutline {
  const startAt = window.startAt ?? window.endAt ?? 0;
  return {
    firstPosition: window.firstPosition,
    endPosition: window.lastPosition + 1,
    startAt,
    endAt: Math.max(startAt, window.endAt ?? startAt),
    ...(window.continues ? { continues: true as const } : {}),
  };
}

/**
 * Splits ascending turns into DM context windows with the same gap rule the agent uses.
 * `previous` is the turn just before the page; without its timing the first window may continue.
 */
export function outlineContextWindows(
  turns: readonly OutlineTurnTiming[],
  gapMs: number,
  previous?: OutlineTurnTiming,
): ContextWindowOutline[] {
  const windows: ContextWindowOutline[] = [];
  let open: OpenWindow | undefined;
  let lastCompletedAt = previous?.completedAt ?? null;
  for (const turn of turns) {
    const { createdAt, completedAt } = turn;
    const timed = createdAt !== null && completedAt !== null ? { createdAt, completedAt } : null;
    const gap =
      timed !== null &&
      lastCompletedAt !== null &&
      startsContextWindow(lastCompletedAt, timed.createdAt, gapMs);
    if (!open || gap) {
      if (open) windows.push(closeWindow(open));
      open = {
        firstPosition: turn.position,
        lastPosition: turn.position,
        startAt: null,
        endAt: null,
        // Without a gap to the turn before this page, the window may have started earlier.
        continues: previous !== undefined && !gap,
      };
    }
    open.lastPosition = turn.position;
    if (!timed) continue;
    open.startAt ??= timed.createdAt;
    open.endAt = Math.max(open.endAt ?? 0, timed.completedAt);
    lastCompletedAt = timed.completedAt;
  }
  if (open) windows.push(closeWindow(open));
  return windows;
}
