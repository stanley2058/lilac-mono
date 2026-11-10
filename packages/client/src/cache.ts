import type { ReplayCheckpoint, TurnSlot } from "@stanley2058/lilac-client-protocol";

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

/** Implementations commit slots and checkpoint in a single transaction. */
export interface NativeCache {
  read(scope: CacheScope, threadId: string): Promise<ThreadCheckpoint | undefined>;
  commit(scope: CacheScope, threadId: string, patch: CachePatch): Promise<void>;
  remove(scope: CacheScope, threadId: string): Promise<void>;
  purge(scope: CacheScope): Promise<void>;
}

export function cacheScopeKey(scope: CacheScope): string {
  return JSON.stringify([
    scope.installationId,
    scope.principalId,
    scope.protocolVersion,
    scope.projectionVersion,
  ]);
}

export class MemoryNativeCache implements NativeCache {
  private readonly scopes = new Map<
    string,
    Map<string, { checkpoint: ReplayCheckpoint; slots: Map<string, CachedSlot> }>
  >();

  async read(scope: CacheScope, threadId: string): Promise<ThreadCheckpoint | undefined> {
    const value = this.scopes.get(cacheScopeKey(scope))?.get(threadId);
    if (!value) return undefined;
    return {
      checkpoint: { ...value.checkpoint },
      slots: [...value.slots.values()]
        .map((slot) => structuredClone(slot))
        .sort((a, b) => a.slot.position - b.slot.position),
    };
  }

  async commit(scope: CacheScope, threadId: string, patch: CachePatch): Promise<void> {
    const key = cacheScopeKey(scope);
    const threads =
      this.scopes.get(key) ??
      new Map<string, { checkpoint: ReplayCheckpoint; slots: Map<string, CachedSlot> }>();
    const previous = threads.get(threadId);
    if (!previous && !patch.replace) return;
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
    const threads = this.scopes.get(cacheScopeKey(scope));
    for (const key of threads?.keys() ?? []) {
      if (key === threadId || key.startsWith(`subagent:${threadId}:`)) threads?.delete(key);
    }
  }

  async purge(scope: CacheScope): Promise<void> {
    this.scopes.delete(cacheScopeKey(scope));
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
    remove: [...remove],
  };
}
