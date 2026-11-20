import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { dmRewindDisabledReason } from "@stanley2058/lilac-client-protocol";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { RewindReason, RewindRestriction } from "./rewind-policy";
import { recentContextOptions } from "./components/RecentContext";

function rewindCandidate(store: ReturnType<NativeClient["thread"]>) {
  for (let index = store.size - 1; index >= 0; index--) {
    const slot = store.at(index);
    if (
      slot?.kind !== "ready" ||
      slot.partsCursor ||
      slot.messages.length ||
      slot.settledAt === undefined ||
      !["complete", "failed", "canceled"].includes(slot.state ?? "")
    )
      return slot;
  }
}

export function useDmRewind(options: {
  client: NativeClient;
  threadId: string;
  ownerId: string;
  dm: boolean;
  online: boolean;
  busy: boolean;
}) {
  const { client, threadId, ownerId, dm, online, busy } = options;
  const store = client.thread(threadId);
  const windowMs = useQuery({
    ...recentContextOptions(client, threadId),
    enabled: dm && online,
    select: (context) => context.timestampGapMs,
  }).data;
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!dm) return () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      function schedule() {
        clearTimeout(timer);
        const last = rewindCandidate(store);
        if (last?.kind !== "ready" || last.settledAt === undefined || windowMs === undefined)
          return;
        const remaining = last.settledAt + windowMs - Date.now();
        if (remaining > 0)
          timer = setTimeout(
            () => {
              schedule();
              notify();
            },
            Math.min(remaining, 2_147_483_647),
          );
      }
      schedule();
      const unsubscribe = store.subscribe(() => {
        schedule();
        notify();
      });
      return () => {
        clearTimeout(timer);
        unsubscribe();
      };
    },
    [store, dm, windowMs],
  );
  const snapshot = useCallback((): RewindReason | undefined => {
    if (!dm) return undefined;
    if (windowMs === undefined) return "loading";
    const last = rewindCandidate(store);
    if (last?.kind !== "ready") return "unavailable";
    if (busy) return "busy";
    if (last.settledAt !== undefined && Date.now() >= last.settledAt + windowMs) return "expired";
    if (last.partsCursor) return "loading";
    return dmRewindDisabledReason({
      turn: last,
      latestTurnId: last.turnId,
      ownerId,
      busy,
      windowMs,
      now: Date.now(),
    });
  }, [dm, store, windowMs, ownerId, busy]);
  const reason = useSyncExternalStore(subscribe, snapshot, snapshot);
  const latestSnapshot = useCallback(() => {
    if (!dm) return undefined;
    const last = rewindCandidate(store);
    return last?.kind === "ready" ? last.turnId : undefined;
  }, [store, dm]);
  const subscribeLatest = useCallback(
    (notify: () => void) => (dm ? store.subscribe(notify) : () => {}),
    [store, dm],
  );
  const latestId = useSyncExternalStore(subscribeLatest, latestSnapshot, latestSnapshot);
  const pageSnapshot = useCallback(() => {
    const last = rewindCandidate(store);
    if (
      !dm ||
      busy ||
      windowMs === undefined ||
      last?.kind !== "ready" ||
      last.settledAt === undefined ||
      Date.now() >= last.settledAt + windowMs
    )
      return undefined;
    return last.partsCursor;
  }, [store, dm, busy, windowMs]);
  const cursor = useSyncExternalStore(subscribeLatest, pageSnapshot, pageSnapshot);
  const revisionSnapshot = useCallback(
    () => (cursor ? store.checkpoint?.projectionRevision : undefined),
    [store, cursor],
  );
  const revision = useSyncExternalStore(subscribeLatest, revisionSnapshot, revisionSnapshot);
  useEffect(() => {
    if (online && cursor && latestId) void client.loadTurnPage(threadId, latestId);
  }, [client, threadId, online, cursor, latestId, revision]);
  return useMemo<RewindRestriction | undefined>(
    () => (dm ? { turnId: reason ? undefined : latestId, reason: reason || undefined } : undefined),
    [dm, reason, latestId],
  );
}
