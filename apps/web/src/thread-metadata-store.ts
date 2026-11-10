import { createStore } from "zustand/vanilla";
import type { NativeClient } from "@stanley2058/lilac-client";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";

export type ThreadMetadataStore = ReturnType<typeof createThreadMetadataStore>;

/** The newer of two copies of a thread; a list page can arrive after a live update. */
export function newerThread(current: NativeThread | undefined, next: NativeThread): NativeThread {
  if (!current) return next;
  if (next.revision !== current.revision) return next.revision > current.revision ? next : current;
  return next.updatedAt >= current.updatedAt ? next : current;
}

/**
 * The latest metadata for every conversation this client has seen. Lists keep their own order and
 * membership but render each conversation from here, so a rename or status change shows everywhere.
 */
export function createThreadMetadataStore(initial: readonly NativeThread[] = []) {
  const store = createStore<{
    threads: ReadonlyMap<string, NativeThread>;
    put: (threads: readonly NativeThread[]) => void;
    remove: (threadId: string) => void;
  }>((set, get) => ({
    threads: new Map(initial.map((thread) => [thread.id, thread])),
    put: (threads) => {
      const current = get().threads;
      let changed: Map<string, NativeThread> | undefined;
      for (const thread of threads) {
        const known = (changed ?? current).get(thread.id);
        const next = newerThread(known, thread);
        if (next === known) continue;
        changed ??= new Map(current);
        changed.set(thread.id, next);
      }
      if (changed) set({ threads: changed });
    },
    remove: (threadId) => {
      if (!get().threads.has(threadId)) return;
      const threads = new Map(get().threads);
      threads.delete(threadId);
      set({ threads });
    },
  }));
  return store;
}

/** Keeps the store current with live thread updates; returns the unsubscribe function. */
export function followClientThreads(
  store: ThreadMetadataStore,
  client: Pick<NativeClient, "subscribe">,
) {
  return client.subscribe((event) => {
    if (event.kind === "thread") store.getState().put([event.thread]);
    if (event.kind === "bootstrap") store.getState().put(event.bootstrap.threads.items);
    if (event.kind === "removed") store.getState().remove(event.threadId);
  });
}
