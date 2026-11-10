import { useSyncExternalStore } from "react";

/** Mirrors `--breakpoint-workspace`, where side panels start overlaying the conversation. */
export const NARROW_WORKSPACE_QUERY = "(width < 47.5rem)";

let query: MediaQueryList | undefined;
function narrowQuery(): MediaQueryList {
  query ??= window.matchMedia(NARROW_WORKSPACE_QUERY);
  return query;
}

export function isNarrowWorkspace(): boolean {
  return narrowQuery().matches;
}

function subscribe(listener: () => void) {
  const list = narrowQuery();
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

export function useNarrowWorkspace(): boolean {
  return useSyncExternalStore(subscribe, isNarrowWorkspace, () => false);
}

export function subscribeNarrowWorkspace(listener: () => void): () => void {
  return subscribe(listener);
}
