import { useEffect } from "react";
import { toast } from "./components/ui/toast";
import { useEventCallback } from "./use-event-callback";

export type ConnectionProblem = {
  reason: string;
  /** Omit when retrying cannot help. Settles when the attempt has finished. */
  retry?: () => Promise<void>;
};

// A socket refused by a dead network fails within milliseconds, which would hide the spinner.
const RETRY_FEEDBACK_MS = 600;
const shown = new Map<string, ConnectionProblem>();

function retryAction(problem: ConnectionProblem, id: string) {
  return problem.retry
    ? { children: "Retry", onClick: () => void retryConnection(problem, id) }
    : undefined;
}

async function retryConnection(problem: ConnectionProblem, id: string) {
  toast.update(id, { type: "loading", actionProps: { children: "Retry", disabled: true } });
  await Promise.allSettled([
    problem.retry?.(),
    new Promise((resolve) => setTimeout(resolve, RETRY_FEEDBACK_MS)),
  ]);
  if (shown.get(id) !== problem) return;
  toast.update(id, { type: "offline", actionProps: retryAction(problem, id) });
}

export function showConnectionNotice(problem: ConnectionProblem, id = "connection") {
  shown.set(id, problem);
  toast.add({
    id,
    title: "Not connected",
    description: problem.reason,
    type: "offline",
    timeout: 0,
    actionProps: retryAction(problem, id),
  });
}

export function closeConnectionNotice(id = "connection") {
  shown.delete(id);
  toast.close(id);
}

// Registered at import so the resume time is recorded before the connection lifecycle's
// visibility listener starts the reconnect that the notice then waits on. Page load counts as a
// resume because a cached page's first connection also waits for fresh credentials.
let resumedAt = performance.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumedAt = performance.now();
});

export function connectionNoticeDelay(now = performance.now()): number {
  return Math.max(1_000, resumedAt + 3_000 - now);
}

export function useConnectionNotice({
  online,
  deviceOnline = true,
  retry,
  id = "connection",
}: {
  online: boolean;
  deviceOnline?: boolean;
  retry: () => Promise<void>;
  id?: string;
}) {
  const retryLatest = useEventCallback(retry);
  useEffect(() => {
    if (online) {
      closeConnectionNotice(id);
      return;
    }
    // The browser reconnects by itself when the device returns, so Retry could only fail.
    const problem: ConnectionProblem = deviceOnline
      ? { reason: "Reconnecting…", retry: retryLatest }
      : { reason: "This device is offline." };
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The delay only counts visible time. Returning to the tab reconnects, which may first wait
    // for fresh Clerk credentials, so that reconnect gets a longer grace period.
    const arm = () => {
      clearTimeout(timer);
      closeConnectionNotice(id);
      if (document.visibilityState !== "visible") return;
      timer = setTimeout(() => showConnectionNotice(problem, id), connectionNoticeDelay());
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      document.removeEventListener("visibilitychange", arm);
      clearTimeout(timer);
      closeConnectionNotice(id);
    };
  }, [online, deviceOnline, id, retryLatest]);
}
