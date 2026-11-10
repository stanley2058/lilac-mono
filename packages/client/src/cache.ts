import type { ReplayCheckpoint, TurnSlot } from "@stanley2058/lilac-client-protocol";

// The shared decoder owns the effective projection version. Callers keep their existing scope shape.
export const CACHE_PROJECTION_VERSION = 2;

export type CacheScope = {
  installationId: string;
  principalId: string;
  protocolVersion: 1;
  projectionVersion: 1;
};
export type CachedSlot = { revision: number; slot: TurnSlot };
export type ThreadCheckpoint = {
  checkpoint: ReplayCheckpoint;
  slots: CachedSlot[];
};
export type CachePatch = {
  checkpoint: ReplayCheckpoint;
  replace: boolean;
  put: CachedSlot[];
  remove: string[];
};

/**
 * `missing` means the cache held no checkpoint for an incremental patch, such as after eviction, and
 * dropped it. The caller commits the thread's full state as a replace so it caches again.
 */
export type CacheCommitOutcome = "missing" | void;

/** Implementations commit slots and checkpoint in a single transaction. */
export interface NativeCache {
  read(scope: CacheScope, threadId: string): Promise<ThreadCheckpoint | undefined>;
  commit(scope: CacheScope, threadId: string, patch: CachePatch): Promise<CacheCommitOutcome>;
  remove(scope: CacheScope, threadId: string): Promise<void>;
  purge(scope: CacheScope): Promise<void>;
}

/** Keys principal-scoped data that survives projection changes, such as drafts and catalogs. */
export function cacheScopeKey(scope: CacheScope): string {
  return JSON.stringify([
    scope.installationId,
    scope.principalId,
    scope.protocolVersion,
    scope.projectionVersion,
  ]);
}

/** Keys cached projected threads, so a projection version change discards only replay data. */
export function cacheProjectionKey(scope: CacheScope): string {
  return JSON.stringify([
    scope.installationId,
    scope.principalId,
    scope.protocolVersion,
    CACHE_PROJECTION_VERSION,
  ]);
}

export class MemoryNativeCache implements NativeCache {
  private readonly scopes = new Map<
    string,
    Map<string, { checkpoint: ReplayCheckpoint; slots: Map<string, CachedSlot> }>
  >();

  async read(scope: CacheScope, threadId: string): Promise<ThreadCheckpoint | undefined> {
    const value = this.scopes.get(cacheProjectionKey(scope))?.get(threadId);
    if (!value) return undefined;
    return {
      checkpoint: { ...value.checkpoint },
      slots: [...value.slots.values()]
        .map((slot) => structuredClone(slot))
        .sort((a, b) => a.slot.position - b.slot.position),
    };
  }

  async commit(
    scope: CacheScope,
    threadId: string,
    patch: CachePatch,
  ): Promise<CacheCommitOutcome> {
    const key = cacheProjectionKey(scope);
    const threads =
      this.scopes.get(key) ??
      new Map<string, { checkpoint: ReplayCheckpoint; slots: Map<string, CachedSlot> }>();
    const previous = threads.get(threadId);
    if (!previous && !patch.replace) return "missing";
    const slots = patch.replace
      ? new Map<string, CachedSlot>()
      : (previous?.slots ?? new Map<string, CachedSlot>());
    for (const id of patch.remove) slots.delete(id);
    for (const slot of patch.put) slots.set(slot.slot.slotId, structuredClone(slot));
    threads.set(threadId, {
      checkpoint: { ...patch.checkpoint },
      slots,
    });
    this.scopes.set(key, threads);
  }

  async remove(scope: CacheScope, threadId: string): Promise<void> {
    const threads = this.scopes.get(cacheProjectionKey(scope));
    for (const key of threads?.keys() ?? []) {
      if (key === threadId || key.startsWith(`subagent:${threadId}:`)) threads?.delete(key);
    }
  }

  async purge(scope: CacheScope): Promise<void> {
    this.scopes.delete(cacheProjectionKey(scope));
  }
}

export class NoNativeCache implements NativeCache {
  async read(): Promise<undefined> {
    return undefined;
  }
  async commit(): Promise<void> {}
  async remove(): Promise<void> {}
  async purge(): Promise<void> {}
}

export function mergeCachePatches(previous: CachePatch | undefined, next: CachePatch): CachePatch {
  if (!previous || next.replace) return next;
  const put = new Map(previous.put.map((slot) => [slot.slot.slotId, slot]));
  const remove = new Set(previous.remove);
  for (const id of next.remove) {
    put.delete(id);
    remove.add(id);
  }
  for (const slot of next.put) {
    remove.delete(slot.slot.slotId);
    put.set(slot.slot.slotId, slot);
  }
  return {
    checkpoint: next.checkpoint,
    replace: previous.replace,
    put: [...put.values()],
    // A merged replace rewrites every slot, so earlier removals have nothing left to remove.
    remove: previous.replace ? [] : [...remove],
  };
}
