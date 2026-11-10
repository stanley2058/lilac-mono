import { Result } from "better-result";
import { z } from "zod";
import {
  cacheProjectionKey,
  cacheScopeKey,
  MemoryNativeCache,
  mergeCachePatches,
  type CachePatch,
  type CacheScope,
  type CachedSlot,
  type NativeCache,
  type ThreadCheckpoint,
} from "@stanley2058/lilac-client";

export { mergeCachePatches };
import {
  bootstrapReplySchema,
  replayCheckpointSchema,
  deferredTurnSlotSchema,
  displayMessageSchema,
  displayPartSchema,
  failedTurnSlotSchema,
  readyTurnSlotSchema,
  revisionSchema,
  identitySchema,
  type BootstrapReply,
} from "@stanley2058/lilac-client-protocol";

export type WebDraft = {
  text: string;
  skillIds: string[];
  commandId?: string;
  savedText?: string;
  title?: string;
  modelId?: string;
};

export type CachedBootstrap = { scope: CacheScope; bootstrap: BootstrapReply; savedAt: number };
export type WebCacheOptions = {
  indexedDB?: IDBFactory | null;
  name?: string;
  maxThreads?: number;
  maxBytes?: number;
  /** How long typing must pause before a draft is written to IndexedDB. */
  draftWriteDelayMs?: number;
};
type PendingDraft = {
  scope: CacheScope;
  threadId: string;
  value: WebDraft;
  settled: PromiseWithResolvers<void>;
};
type ThreadRow = {
  key: string;
  scopeKey: string;
  threadId: string;
  checkpoint: ThreadCheckpoint["checkpoint"];
  updatedAt: number;
  bytes: number;
};
type SlotRow = {
  key: string;
  threadKey: string;
  scopeKey: string;
  data: CachedSlot;
  bytes: number;
};
const encode = new TextEncoder();

const cacheScopeSchema = z.strictObject({
  installationId: z.string(),
  principalId: z.string(),
  protocolVersion: z.literal(1),
  projectionVersion: z.literal(1),
});
const threadRowSchema = z.strictObject({
  key: z.string(),
  scopeKey: z.string(),
  threadId: z.string(),
  checkpoint: replayCheckpointSchema,
  updatedAt: revisionSchema,
  bytes: revisionSchema,
});
// Patches append parts and messages to a stored slot, so it can outgrow the wire caps on both.
const cachedTurnSlotSchema = z.discriminatedUnion("kind", [
  readyTurnSlotSchema.extend({
    messages: z.array(displayMessageSchema.extend({ parts: z.array(displayPartSchema) })),
  }),
  deferredTurnSlotSchema,
  failedTurnSlotSchema,
]);
const slotRowSchema = z.strictObject({
  key: z.string(),
  threadKey: z.string(),
  scopeKey: z.string(),
  bytes: revisionSchema,
  data: z.strictObject({ revision: revisionSchema, slot: cachedTurnSlotSchema }),
});
const bootstrapRowSchema = z.strictObject({
  key: z.string(),
  scope: cacheScopeSchema,
  bootstrap: bootstrapReplySchema,
  savedAt: revisionSchema,
});
const draftRowSchema = z.strictObject({
  key: z.string(),
  scopeKey: z.string(),
  text: z.string().max(65_536),
  skillIds: z.array(identitySchema).max(32).default([]),
  commandId: identitySchema.optional(),
  savedText: z.string().max(65_536).optional(),
  title: z.string().max(512).optional(),
  modelId: identitySchema.optional(),
  updatedAt: revisionSchema,
});
function decodeThread(value: unknown): ThreadRow | undefined {
  const parsed = threadRowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function decodeSlot(value: unknown): SlotRow | undefined {
  const parsed = slotRowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function decodeBootstrap(value: unknown): CachedBootstrap | undefined {
  const parsed = bootstrapRowSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { scope, bootstrap, savedAt } = parsed.data;
  if (
    bootstrap.installationId !== scope.installationId ||
    bootstrap.viewer.id !== scope.principalId ||
    parsed.data.key !== cacheScopeKey(scope)
  )
    return undefined;
  return { scope, bootstrap, savedAt };
}
function decodeDraftRow(value: unknown): z.infer<typeof draftRowSchema> | undefined {
  const parsed = draftRowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
function decodeDraft(value: unknown): WebDraft {
  const parsed = draftRowSchema.safeParse(value);
  if (!parsed.success) return { text: "", skillIds: [] };
  return {
    text: parsed.data.text,
    skillIds: parsed.data.skillIds,
    commandId: parsed.data.commandId,
    savedText: parsed.data.savedText,
    ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
    ...(parsed.data.modelId === undefined ? {} : { modelId: parsed.data.modelId }),
  };
}
function rejectWebCacheRequest(reject: (cause: Error) => void, error: Error): void {
  reject(error);
}
function idbRequest<T>(request: IDBRequest<T>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      rejectWebCacheRequest(reject, request.error ?? new Error("IndexedDB request failed"));
  });
}
function completed(transaction: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onabort = () => resolve(false);
    transaction.onerror = () => resolve(false);
  });
}
function signalWebCacheFailure(error: Error): never {
  throw error;
}
async function assertCommitted(completion: Promise<boolean>): Promise<void> {
  if (!(await completion)) signalWebCacheFailure(new Error("Cache transaction failed"));
}
function threadKey(scope: CacheScope, threadId: string): string {
  return JSON.stringify([cacheScopeKey(scope), threadId]);
}
function projectionThreadKey(scope: CacheScope, threadId: string): string {
  return JSON.stringify([cacheProjectionKey(scope), threadId]);
}
function slotKey(key: string, slotId: string): string {
  return JSON.stringify([key, slotId]);
}
const draftKeySchema = z.tuple([z.string(), z.string()]);
function localDraftId(key: string, scopeKey: string): string | undefined {
  const decoded = Result.try({ try: () => JSON.parse(key), catch: () => undefined });
  const value = decoded.match({ ok: (value) => value, err: () => undefined });
  const parsed = draftKeySchema.safeParse(value);
  if (!parsed.success || parsed.data[0] !== scopeKey) return undefined;
  return parsed.data[1];
}
async function deleteIndex(store: IDBObjectStore, index: string, key: string): Promise<void> {
  const keys = await idbRequest(store.index(index).getAllKeys(key));
  if (!Array.isArray(keys)) return;
  for (const entry of keys) {
    if (typeof entry === "string") store.delete(entry);
  }
}

function trimMap<T>(map: Map<string, T>, limit: number): void {
  for (const key of map.keys()) {
    if (map.size <= limit) return;
    map.delete(key);
  }
}
function trimScope<T>(map: Map<string, T>, scopeKey: string, limit: number): void {
  const prefix = JSON.stringify([scopeKey]).slice(0, -1);
  const keys = [...map.keys()].filter((key) => key.startsWith(prefix));
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) map.delete(key);
}
// Writes need only these fields; the non-strict schemas skip the slot and checkpoint they sit beside.
const storedBytesSchema = z.object({ bytes: revisionSchema });
const threadUsageSchema = z.object({
  key: z.string(),
  updatedAt: revisionSchema,
  bytes: revisionSchema,
});
/** Reads a stored row's byte count without decoding the slot it describes. */
function decodeStoredBytes(value: unknown): number | undefined {
  const parsed = storedBytesSchema.safeParse(value);
  return parsed.success ? parsed.data.bytes : undefined;
}
function decodeThreadUsage(value: unknown): z.infer<typeof threadUsageSchema> | undefined {
  const parsed = threadUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
/** Folds a later patch into one still waiting to be written, as if both were applied in order. */
type QueuedWrite = {
  scope: CacheScope;
  threadId: string;
  patch: CachePatch;
  settled: PromiseWithResolvers<void>;
};
function draftIsEmpty(draft: WebDraft): boolean {
  return !draft.text.trim() && !draft.skillIds.length && !draft.commandId && !draft.savedText;
}

export class WebNativeCache implements NativeCache {
  private readonly memory = new MemoryNativeCache();
  private readonly snapshots = new Map<string, CachedBootstrap>();
  private readonly drafts = new Map<string, WebDraft>();
  private readonly pendingDrafts = new Map<string, PendingDraft>();
  /** One IndexedDB write runs per thread; patches that arrive meanwhile merge into the next one. */
  private readonly threadWrites = new Map<
    string,
    { running: Promise<void>; queued?: QueuedWrite }
  >();
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly draftWriteDelayMs: number;
  private readonly factory: IDBFactory | null | undefined;
  private readonly name: string;
  private readonly maxThreads: number;
  private readonly maxBytes: number;
  private connection: Promise<IDBDatabase | undefined> | undefined;
  private database: IDBDatabase | undefined;
  private disabled = false;
  private epoch = 0;
  private readonly residentThreads = new Map<
    string,
    { scope: CacheScope; threadId: string; bytes: number }
  >();

  constructor(options: WebCacheOptions = {}) {
    this.factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
    this.name = options.name ?? "lilac-native-v1";
    this.maxThreads = Math.max(1, options.maxThreads ?? 24);
    this.maxBytes = Math.max(1024, options.maxBytes ?? 64 * 1024 * 1024);
    this.draftWriteDelayMs = Math.max(0, options.draftWriteDelayMs ?? 400);
    if (typeof document === "undefined") return;
    // A hidden tab may be discarded or closed without another chance to write.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.flushDraftsBeforeHide();
    });
    window.addEventListener("pagehide", () => this.flushDraftsBeforeHide());
  }
  get persistent(): boolean {
    return Boolean(this.factory) && !this.disabled;
  }
  private async open(): Promise<IDBDatabase | undefined> {
    if (this.disabled || !this.factory) return undefined;
    if (this.connection) return this.connection;
    this.connection = this.openDatabase();
    return this.connection;
  }
  private async openDatabase(): Promise<IDBDatabase | undefined> {
    const result = await Result.tryPromise({
      try: () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = this.factory!.open(this.name, 1);
          request.onupgradeneeded = () => {
            const db = request.result;
            const threads = db.createObjectStore("threads", { keyPath: "key" });
            threads.createIndex("scope", "scopeKey");
            const slots = db.createObjectStore("slots", { keyPath: "key" });
            slots.createIndex("thread", "threadKey");
            slots.createIndex("scope", "scopeKey");
            db.createObjectStore("snapshots", { keyPath: "key" });
            const drafts = db.createObjectStore("drafts", { keyPath: "key" });
            drafts.createIndex("scope", "scopeKey");
          };
          request.onsuccess = () => {
            if (this.disabled) {
              request.result.close();
              rejectWebCacheRequest(reject, new Error("Cache closed during open"));
              return;
            }
            resolve(request.result);
          };
          request.onerror = () =>
            rejectWebCacheRequest(reject, request.error ?? new Error("IndexedDB request failed"));
          request.onblocked = () =>
            rejectWebCacheRequest(reject, new Error("Cache upgrade blocked"));
        }),
      catch: () => undefined,
    });
    const db = result.match({ ok: (value) => value, err: () => undefined });
    if (!db) {
      this.disabled = true;
      return undefined;
    }
    this.database = db;
    db.onversionchange = () => {
      db.close();
      this.database = undefined;
      this.connection = undefined;
    };
    return db;
  }
  private async attempt<T>(
    operation: (database: IDBDatabase) => Promise<T>,
  ): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return undefined;
    const result = await Result.tryPromise({ try: () => operation(db), catch: () => undefined });
    const outcome = result.match<{ value: T } | { failed: true }>({
      ok: (value) => ({ value }),
      err: () => ({ failed: true }),
    });
    if ("value" in outcome) return outcome.value;
    this.disabled = true;
    this.database?.close();
    this.database = undefined;
    this.connection = undefined;
    const factory = this.factory;
    if (factory) {
      const cleanup = await Result.tryPromise({
        try: () =>
          new Promise<void>((resolve) => {
            const request = factory.deleteDatabase(this.name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
        catch: () => undefined,
      });
      cleanup.match({ ok: () => {}, err: () => {} });
    }
    return undefined;
  }
  async read(scope: CacheScope, threadId: string): Promise<ThreadCheckpoint | undefined> {
    const epoch = this.epoch;
    const cached = await this.memory.read(scope, threadId);
    if (cached) {
      const resident = this.residentThreads.get(projectionThreadKey(scope, threadId));
      if (resident) this.touch(scope, threadId, resident.bytes);
      return cached;
    }
    const key = projectionThreadKey(scope, threadId);
    for (let writes = this.threadWrites.get(key); writes; writes = this.threadWrites.get(key))
      await writes.running;
    const loaded = await this.attempt(async (db) => {
      const tx = db.transaction(["threads", "slots"], "readwrite");
      const done = completed(tx);
      const row = decodeThread(await idbRequest(tx.objectStore("threads").get(key)));
      if (!row || row.scopeKey !== cacheProjectionKey(scope) || row.threadId !== threadId) {
        await assertCommitted(done);
        return undefined;
      }
      const values = await idbRequest(tx.objectStore("slots").index("thread").getAll(key));
      if (!Array.isArray(values)) {
        await assertCommitted(done);
        return undefined;
      }
      const slots: CachedSlot[] = [];
      for (const value of values) {
        const slot = decodeSlot(value);
        if (!slot || slot.threadKey !== key || slot.scopeKey !== cacheProjectionKey(scope)) {
          await assertCommitted(done);
          return undefined;
        }
        slots.push(slot.data);
      }
      tx.objectStore("threads").put({ ...row, updatedAt: Date.now() });
      await assertCommitted(done);
      return {
        checkpoint: row.checkpoint,
        slots: slots.sort((a, b) => a.slot.position - b.slot.position),
      };
    });
    if (!loaded || epoch !== this.epoch) return undefined;
    await this.memory.commit(scope, threadId, {
      checkpoint: loaded.checkpoint,
      replace: true,
      put: loaded.slots,
      remove: [],
    });
    this.touch(scope, threadId, encode.encode(JSON.stringify(loaded)).byteLength);
    await this.evictMemory();
    return loaded;
  }
  private touch(scope: CacheScope, threadId: string, bytes: number): void {
    const key = projectionThreadKey(scope, threadId);
    this.residentThreads.delete(key);
    this.residentThreads.set(key, { scope, threadId, bytes });
  }
  private async evictMemory(): Promise<void> {
    let bytes = 0;
    for (const value of this.residentThreads.values()) bytes += value.bytes;
    for (const [key, value] of this.residentThreads) {
      if (this.residentThreads.size <= this.maxThreads && bytes <= this.maxBytes) return;
      this.residentThreads.delete(key);
      bytes -= value.bytes;
      await this.memory.remove(value.scope, value.threadId);
    }
  }
  async commit(scope: CacheScope, threadId: string, patch: CachePatch): Promise<void> {
    await this.memory.commit(scope, threadId, patch);
    const key = projectionThreadKey(scope, threadId);
    const writes = this.threadWrites.get(key);
    if (!writes) return this.startWrite(key, scope, threadId, patch);
    if (writes.queued) {
      writes.queued.patch = mergeCachePatches(writes.queued.patch, patch);
      return writes.queued.settled.promise;
    }
    writes.queued = { scope, threadId, patch, settled: Promise.withResolvers<void>() };
    return writes.queued.settled.promise;
  }
  private startWrite(
    key: string,
    scope: CacheScope,
    threadId: string,
    patch: CachePatch,
  ): Promise<void> {
    // Failed writes disable the cache inside writeThread, so this chain only resolves.
    const running = this.writeThread(scope, threadId, patch).then(() => {
      const next = this.threadWrites.get(key)?.queued;
      this.threadWrites.delete(key);
      if (!next) return;
      void this.startWrite(key, next.scope, next.threadId, next.patch).then(next.settled.resolve);
    });
    this.threadWrites.set(key, { running });
    return running;
  }
  /** Drops writes that have not started for threads that are being removed. */
  private cancelQueuedWrites(matches: (scope: CacheScope, threadId: string) => boolean): void {
    for (const writes of this.threadWrites.values()) {
      const queued = writes.queued;
      if (!queued || !matches(queued.scope, queued.threadId)) continue;
      writes.queued = undefined;
      queued.settled.resolve();
    }
  }
  private async writeThread(scope: CacheScope, threadId: string, patch: CachePatch): Promise<void> {
    const key = projectionThreadKey(scope, threadId);
    const scopeKey = cacheProjectionKey(scope);
    const rows: SlotRow[] = patch.put.map((data) => ({
      key: slotKey(key, data.slot.slotId),
      threadKey: key,
      scopeKey,
      data,
      bytes: encode.encode(JSON.stringify(data)).byteLength,
    }));
    const bytes = await this.attempt(async (db) => {
      const tx = db.transaction(["threads", "slots"], "readwrite");
      const done = completed(tx);
      const threads = tx.objectStore("threads");
      const slots = tx.objectStore("slots");
      const previous = decodeThreadUsage(await idbRequest(threads.get(key)));
      if (!previous && !patch.replace) {
        await assertCommitted(done);
        return 0;
      }
      let total = patch.replace ? 0 : (previous?.bytes ?? 0);
      if (patch.replace) await deleteIndex(slots, "thread", key);
      for (const id of new Set([...patch.remove, ...patch.put.map((value) => value.slot.slotId)])) {
        const old = patch.replace
          ? undefined
          : decodeStoredBytes(await idbRequest(slots.get(slotKey(key, id))));
        if (old !== undefined) total -= old;
        slots.delete(slotKey(key, id));
      }
      for (const row of rows) {
        slots.put(row);
        total += row.bytes;
      }
      threads.put({
        key,
        scopeKey,
        threadId,
        checkpoint: patch.checkpoint,
        updatedAt: Date.now(),
        bytes: total,
      });
      const all = await idbRequest(threads.getAll());
      const metadata = Array.isArray(all)
        ? all
            .map(decodeThreadUsage)
            .filter((row) => row !== undefined)
            .sort((a, b) => a.updatedAt - b.updatedAt)
        : [];
      let retainedBytes = metadata.reduce((sum, row) => sum + row.bytes, 0);
      let retainedCount = metadata.length;
      for (const row of metadata) {
        if (retainedCount <= this.maxThreads && retainedBytes <= this.maxBytes) break;
        threads.delete(row.key);
        await deleteIndex(slots, "thread", row.key);
        retainedCount--;
        retainedBytes -= row.bytes;
      }
      await assertCommitted(done);
      return total;
    });
    const previousBytes = patch.replace ? 0 : (this.residentThreads.get(key)?.bytes ?? 0);
    this.touch(
      scope,
      threadId,
      bytes ?? previousBytes + rows.reduce((sum, row) => sum + row.bytes, 0),
    );
    await this.evictMemory();
  }
  async remove(scope: CacheScope, threadId: string): Promise<void> {
    this.epoch++;
    await this.memory.remove(scope, threadId);
    const key = threadKey(scope, threadId);
    this.pendingDrafts.get(key)?.settled.resolve();
    this.pendingDrafts.delete(key);
    const scopeKey = cacheProjectionKey(scope);
    this.cancelQueuedWrites(
      (queuedScope, queuedThread) =>
        cacheProjectionKey(queuedScope) === scopeKey &&
        (queuedThread === threadId || queuedThread.startsWith(`subagent:${threadId}:`)),
    );
    for (const [id, row] of this.residentThreads) {
      if (
        cacheProjectionKey(row.scope) === scopeKey &&
        (row.threadId === threadId || row.threadId.startsWith(`subagent:${threadId}:`))
      )
        this.residentThreads.delete(id);
    }
    await this.attempt(async (db) => {
      const tx = db.transaction(["threads", "slots", "drafts"], "readwrite");
      const done = completed(tx);
      const threads = tx.objectStore("threads");
      const values = await idbRequest(threads.index("scope").getAll(scopeKey));
      const rows = Array.isArray(values)
        ? values.map(decodeThread).filter((row) => row !== undefined)
        : [];
      for (const row of rows) {
        if (row.threadId !== threadId && !row.threadId.startsWith(`subagent:${threadId}:`))
          continue;
        threads.delete(row.key);
        await deleteIndex(tx.objectStore("slots"), "thread", row.key);
      }
      tx.objectStore("drafts").delete(key);
      await assertCommitted(done);
    });
    this.drafts.delete(key);
  }

  async purge(scope: CacheScope): Promise<void> {
    this.epoch++;
    await this.memory.purge(scope);
    const key = cacheScopeKey(scope);
    const projectionKey = cacheProjectionKey(scope);
    this.cancelQueuedWrites((queuedScope) => cacheProjectionKey(queuedScope) === projectionKey);
    this.snapshots.delete(key);
    for (const [id, value] of this.residentThreads) {
      if (cacheProjectionKey(value.scope) === projectionKey) this.residentThreads.delete(id);
    }
    for (const id of this.drafts.keys()) {
      if (id.startsWith(JSON.stringify([key]).slice(0, -1))) this.drafts.delete(id);
    }
    for (const [id, pending] of this.pendingDrafts) {
      if (cacheScopeKey(pending.scope) !== key) continue;
      this.pendingDrafts.delete(id);
      pending.settled.resolve();
    }
    await this.attempt(async (db) => {
      const tx = db.transaction(["threads", "slots", "snapshots", "drafts"], "readwrite");
      const done = completed(tx);
      tx.objectStore("snapshots").delete(key);
      // Also drop rows an older bundle wrote under the scope key before projections were versioned.
      for (const scopeKey of new Set([key, projectionKey])) {
        await deleteIndex(tx.objectStore("threads"), "scope", scopeKey);
        await deleteIndex(tx.objectStore("slots"), "scope", scopeKey);
      }
      await deleteIndex(tx.objectStore("drafts"), "scope", key);
      await assertCommitted(done);
    });
  }
  async saveBootstrap(scope: CacheScope, bootstrap: BootstrapReply): Promise<void> {
    if (
      bootstrap.installationId !== scope.installationId ||
      bootstrap.viewer.id !== scope.principalId
    )
      return;
    const key = cacheScopeKey(scope);
    const previous = this.snapshots.get(key);
    const catalog =
      bootstrap.catalog.kind === "unchanged" &&
      previous?.bootstrap.catalog.kind === "catalog" &&
      previous.bootstrap.catalog.catalog.revision === bootstrap.catalog.revision
        ? previous.bootstrap.catalog
        : bootstrap.catalog;
    const value: CachedBootstrap = {
      scope,
      bootstrap: {
        ...bootstrap,
        selectedThread: undefined,
        selectedThreadUnavailable: undefined,
        catalog,
      },
      savedAt: Date.now(),
    };
    this.snapshots.set(key, value);
    trimMap(this.snapshots, this.maxThreads);
    await this.attempt(async (db) => {
      const tx = db.transaction("snapshots", "readwrite");
      const done = completed(tx);
      const store = tx.objectStore("snapshots");
      store.put({ key, ...value });
      const all = await idbRequest(store.getAll());
      const rows = Array.isArray(all)
        ? all
            .map(decodeBootstrap)
            .filter((item) => item !== undefined)
            .sort((a, b) => b.savedAt - a.savedAt)
        : [];
      for (const row of rows.slice(this.maxThreads)) store.delete(cacheScopeKey(row.scope));
      await assertCommitted(done);
    });
  }
  async readBootstrap(scope: CacheScope): Promise<CachedBootstrap | undefined> {
    const epoch = this.epoch;
    const key = cacheScopeKey(scope);
    const existing = this.snapshots.get(key);
    if (existing) return existing;
    const value = await this.attempt(async (db) => {
      const tx = db.transaction("snapshots", "readonly");
      const done = completed(tx);
      const result = decodeBootstrap(await idbRequest(tx.objectStore("snapshots").get(key)));
      await assertCommitted(done);
      return result;
    });
    if (epoch !== this.epoch) return undefined;
    if (value) this.snapshots.set(key, value);
    return value;
  }
  async readLatestBootstrap(): Promise<CachedBootstrap | undefined> {
    const epoch = this.epoch;
    const values = await this.attempt(async (db) => {
      const tx = db.transaction("snapshots", "readonly");
      const done = completed(tx);
      const result = await idbRequest(tx.objectStore("snapshots").getAll());
      await assertCommitted(done);
      return Array.isArray(result)
        ? result.map(decodeBootstrap).filter((value) => value !== undefined)
        : [];
    });
    if (epoch !== this.epoch) return undefined;
    for (const value of values ?? []) this.snapshots.set(cacheScopeKey(value.scope), value);
    return [...this.snapshots.values()].sort((a, b) => b.savedAt - a.savedAt)[0];
  }
  /**
   * Updates the draft in memory now and writes it to IndexedDB once typing pauses, the tab hides,
   * or `flushDrafts` runs. The promise settles when that write finishes.
   */
  saveDraft(scope: CacheScope, threadId: string, draft: WebDraft): Promise<void> {
    const value: WebDraft = {
      text: draft.text.slice(0, 65_536),
      skillIds: [...new Set(draft.skillIds)].slice(0, 32),
      commandId: draft.commandId,
      savedText: draft.savedText?.slice(0, 65_536),
      ...(draft.title === undefined ? {} : { title: draft.title.slice(0, 512) }),
      ...(draft.modelId === undefined ? {} : { modelId: draft.modelId }),
    };
    const key = threadKey(scope, threadId);
    this.drafts.delete(key);
    if (!draftIsEmpty(value)) {
      this.drafts.set(key, value);
      trimScope(this.drafts, cacheScopeKey(scope), this.maxThreads);
    }
    const settled = this.pendingDrafts.get(key)?.settled ?? Promise.withResolvers<void>();
    this.pendingDrafts.set(key, { scope, threadId, value, settled });
    clearTimeout(this.draftTimer);
    if (this.draftWriteDelayMs === 0) void this.flushDrafts();
    else this.draftTimer = setTimeout(() => void this.flushDrafts(), this.draftWriteDelayMs);
    return settled.promise;
  }
  /** Writes every draft still waiting for a pause in typing. */
  async flushDrafts(): Promise<void> {
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    const pending = [...this.pendingDrafts.values()];
    this.pendingDrafts.clear();
    await Promise.all(
      pending.map(async ({ scope, threadId, value, settled }) => {
        await this.writeDraft(scope, threadId, value);
        settled.resolve();
      }),
    );
  }
  /**
   * Writes every pending draft before the page is frozen or unloaded. The browser may run no more
   * script after this handler, so the writes are queued and committed before it returns. The next
   * ordinary draft write trims the scope back under its cap.
   */
  private flushDraftsBeforeHide(): void {
    const db = this.database;
    if (!db) {
      void this.flushDrafts();
      return;
    }
    clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
    const pending = [...this.pendingDrafts.values()];
    this.pendingDrafts.clear();
    if (!pending.length) return;
    const started = Result.try({
      try: () => {
        const tx = db.transaction("drafts", "readwrite");
        const store = tx.objectStore("drafts");
        for (const { scope, threadId, value } of pending) {
          const key = threadKey(scope, threadId);
          if (draftIsEmpty(value)) store.delete(key);
          else store.put({ key, scopeKey: cacheScopeKey(scope), ...value, updatedAt: Date.now() });
        }
        tx.commit();
        return tx;
      },
      catch: () => undefined,
    });
    const committed = started.match({ ok: completed, err: () => Promise.resolve(false) });
    void this.attempt(() => assertCommitted(committed)).then(() => {
      for (const draft of pending) draft.settled.resolve();
    });
  }
  private async writeDraft(scope: CacheScope, threadId: string, value: WebDraft): Promise<void> {
    const key = threadKey(scope, threadId);
    const scopeKey = cacheScopeKey(scope);
    // An empty draft reads back the same as a missing row, so it frees its slot under the cap.
    if (draftIsEmpty(value)) {
      await this.attempt(async (db) => {
        const tx = db.transaction("drafts", "readwrite");
        const done = completed(tx);
        tx.objectStore("drafts").delete(key);
        await assertCommitted(done);
      });
      return;
    }
    await this.attempt(async (db) => {
      const tx = db.transaction("drafts", "readwrite");
      const done = completed(tx);
      const store = tx.objectStore("drafts");
      store.put({ key, scopeKey, ...value, updatedAt: Date.now() });
      const count = await idbRequest(store.index("scope").count(scopeKey));
      if (typeof count === "number" && count <= this.maxThreads) {
        await assertCommitted(done);
        return;
      }
      const all = await idbRequest(store.index("scope").getAll(scopeKey));
      const rows = Array.isArray(all)
        ? all
            .map(decodeDraftRow)
            .filter((row) => row !== undefined)
            .sort((a, b) => b.updatedAt - a.updatedAt)
        : [];
      for (const row of rows.slice(this.maxThreads)) store.delete(row.key);
      await assertCommitted(done);
    });
  }
  async readDraft(scope: CacheScope, threadId: string): Promise<WebDraft> {
    const epoch = this.epoch;
    const key = threadKey(scope, threadId);
    const known = this.pendingDrafts.get(key)?.value ?? this.drafts.get(key);
    if (known !== undefined) return structuredClone(known);
    const value = await this.attempt(async (db) => {
      const tx = db.transaction("drafts", "readonly");
      const done = completed(tx);
      const row = await idbRequest(tx.objectStore("drafts").get(key));
      await assertCommitted(done);
      return decodeDraft(row);
    });
    if (epoch !== this.epoch) return { text: "", skillIds: [] };
    if (value !== undefined && !draftIsEmpty(value)) this.drafts.set(key, value);
    return value ? structuredClone(value) : { text: "", skillIds: [] };
  }
  /** Unsent drafts in the scope by thread, from IndexedDB with newer in-memory edits applied. */
  private async scopeDrafts(scope: CacheScope): Promise<Map<string, WebDraft>> {
    const epoch = this.epoch;
    const scopeKey = cacheScopeKey(scope);
    const rows = await this.attempt(async (db) => {
      const tx = db.transaction("drafts", "readonly");
      const done = completed(tx);
      const values = await idbRequest(tx.objectStore("drafts").index("scope").getAll(scopeKey));
      await assertCommitted(done);
      if (!Array.isArray(values)) return [];
      return values
        .map(decodeDraftRow)
        .filter((row) => row !== undefined)
        .filter((row) => row.scopeKey === scopeKey)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    });
    const drafts = new Map<string, WebDraft>();
    if (epoch !== this.epoch) return drafts;
    for (const row of rows ?? []) {
      const threadId = localDraftId(row.key, scopeKey);
      if (threadId) drafts.set(threadId, decodeDraft(row));
    }
    for (const [key, draft] of this.drafts) {
      const threadId = localDraftId(key, scopeKey);
      if (threadId) drafts.set(threadId, draft);
    }
    for (const [key, pending] of this.pendingDrafts) {
      const threadId = localDraftId(key, scopeKey);
      if (threadId) drafts.set(threadId, pending.value);
    }
    for (const [threadId, draft] of drafts)
      if (!draft.text.trim() && !draft.skillIds.length && !draft.commandId) drafts.delete(threadId);
    return drafts;
  }
  async listLocalDrafts(scope: CacheScope): Promise<{ threadId: string; draft: WebDraft }[]> {
    return [...(await this.scopeDrafts(scope))]
      .filter(([threadId]) => threadId.startsWith("draft:"))
      .map(([threadId, draft]) => ({ threadId, draft: structuredClone(draft) }));
  }
  /** Conversations with an unsent reply, read in one transaction for the whole sidebar. */
  async listDraftedThreads(scope: CacheScope): Promise<Set<string>> {
    return new Set(
      [...(await this.scopeDrafts(scope)).keys()].filter(
        (threadId) => !threadId.startsWith("draft:"),
      ),
    );
  }
  async deleteDraft(scope: CacheScope, threadId: string): Promise<void> {
    this.epoch++;
    const key = threadKey(scope, threadId);
    this.drafts.delete(key);
    this.pendingDrafts.get(key)?.settled.resolve();
    this.pendingDrafts.delete(key);
    await this.attempt(async (db) => {
      const tx = db.transaction("drafts", "readwrite");
      const done = completed(tx);
      tx.objectStore("drafts").delete(key);
      await assertCommitted(done);
    });
  }
  close(): void {
    this.database?.close();
    this.database = undefined;
    this.connection = undefined;
  }
}

export function createWebNativeCache(options: WebCacheOptions = {}): WebNativeCache {
  return new WebNativeCache(options);
}
