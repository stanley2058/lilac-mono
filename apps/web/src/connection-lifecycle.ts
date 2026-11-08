import type { NativeClient } from "@stanley2058/lilac-client";

export const CONNECTION_CHECK_INTERVAL_MS = 20_000;

// Failed requests only reach the error toasts as message text. This covers Lilac's own messages,
// oRPC's closed-socket errors, gateway failures, and each browser's failed-fetch wording.
const CONNECTION_FAILURE =
  /^(Could not connect to Lilac|Could not refresh your session|Connection (failed|unavailable)|Cannot send message, WebSocket is not open|\[AsyncIdQueue\] Queue\[.*\] was closed or aborted|Failed to fetch|fetch failed|Load failed|NetworkError|Network request failed|Service Unavailable|Bad Gateway|Gateway Timeout)/i;

export function isConnectionFailure(message: string): boolean {
  return CONNECTION_FAILURE.test(message);
}

// A stalled attempt is replaced at the client's own 10-second deadline by another that only reports
// "connecting", and a disposed client reports nothing, so no event may ever end the wait.
const RECONNECT_ATTEMPT_LIMIT_MS = 10_000;

/** Reconnects and settles once the attempt has connected, failed, or reached its time limit. */
export function reconnectAttempt(client: Pick<NativeClient, "reconnect" | "subscribe">) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(limit);
      stop();
      resolve();
    };
    const stop = client.subscribe((event) => {
      if (event.kind === "connection" && event.state !== "connecting") finish();
    });
    const limit = setTimeout(finish, RECONNECT_ATTEMPT_LIMIT_MS);
    client.reconnect();
  });
}

export function watchConnectionLifecycle(
  client: Pick<NativeClient, "reconnect" | "connectionState" | "checkConnection">,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  events: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  let hidden = page.visibilityState === "hidden";
  const visible = () => {
    if (page.visibilityState === "hidden") {
      hidden = true;
      return;
    }
    if (!hidden) return;
    hidden = false;
    client.reconnect();
  };
  const online = () => {
    if (page.visibilityState === "visible") client.reconnect();
  };
  const focus = () => {
    if (client.connectionState === "offline") online();
  };
  // Hidden pages reconnect when they return, so only a visible page needs to probe its socket.
  const check = setInterval(() => {
    if (page.visibilityState === "visible") void client.checkConnection();
  }, CONNECTION_CHECK_INTERVAL_MS);
  page.addEventListener("visibilitychange", visible);
  events.addEventListener("online", online);
  events.addEventListener("focus", focus);
  return () => {
    clearInterval(check);
    page.removeEventListener("visibilitychange", visible);
    events.removeEventListener("online", online);
    events.removeEventListener("focus", focus);
  };
}
