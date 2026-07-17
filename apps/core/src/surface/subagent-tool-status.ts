import type { SurfaceToolStatusUpdate } from "./adapter";

export function isSubagentToolDisplay(display: string): boolean {
  const trimmed = display.trimStart();
  return (
    trimmed.startsWith("subagent (") ||
    trimmed.startsWith("subagent_delegate") ||
    trimmed.startsWith("[subagent]")
  );
}

function isMultilineDisplay(display: string): boolean {
  return display.includes("\n");
}

export function mergeSubagentToolStatus(
  previous: SurfaceToolStatusUpdate | undefined,
  next: SurfaceToolStatusUpdate,
): SurfaceToolStatusUpdate {
  if (
    !previous ||
    (!isSubagentToolDisplay(previous.display) && !isSubagentToolDisplay(next.display))
  ) {
    return next;
  }

  const display =
    isMultilineDisplay(next.display) || !isMultilineDisplay(previous.display)
      ? next.display
      : previous.display;

  if (previous.status !== "end" || next.status === "end") {
    return { ...next, display };
  }

  return {
    ...next,
    display,
    status: "end",
    ok: previous.ok,
    error: previous.error,
  };
}
