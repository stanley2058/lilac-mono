import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { IDBDatabase, IDBFactory, IDBIndex, IDBObjectStore } from "fake-indexeddb";
import type { CachePatch, CacheScope } from "@stanley2058/lilac-client";
import type { BootstrapReply } from "@stanley2058/lilac-client-protocol";
import { mergeCachePatches, WebNativeCache } from "../src/cache";

const scope: CacheScope = {
  installationId: "install",
  principalId: "owner",
  protocolVersion: 1,
  projectionVersion: 1,
};
const caches: WebNativeCache[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
});
function cache(
  factory: IDBFactory | null = new IDBFactory(),
  options: { maxThreads?: number; maxBytes?: number; draftWriteDelayMs?: number } = {},
) {
  const instance = new WebNativeCache({ indexedDB: factory, draftWriteDelayMs: 0, ...options });
  caches.push(instance);
  return instance;
}
function patch(revision = 1, text = "hello"): CachePatch {
  return {
    checkpoint: {
      protocolVersion: 1,
      historyGeneration: 0,
      projectionRevision: revision,
      cursor: `cursor_${revision}`,
    },
    replace: revision === 1,
    put: [
      {
        revision,
        slot: {
          kind: "ready",
          slotId: "latest",
          turnId: "turn",
          position: 1,
          messages: [{ id: "msg", role: "assistant", parts: [{ type: "text", text }] }],
        },
      },
    ],
    remove: [],
  };
}
const bootstrap: BootstrapReply = {
  installationId: "install",
  viewer: { id: "owner", displayName: "Owner", role: "owner", toolMode: "full" },
  threads: { items: [] },
  catalogCursor: "catalog",
  catalog: {
    kind: "catalog",
    catalog: { revision: "catalog", models: [], commands: [], skills: [] },
  },
};

describe("WebNativeCache", () => {
  test("checkpoints and deferred coverage survive close and reopen atomically", async () => {
    const factory = new IDBFactory();
    const first = cache(factory);
    const initial = patch();
    initial.put.unshift({
      revision: 1,
      slot: { kind: "deferred", slotId: "old", position: 0, endPosition: 1 },
    });
    await first.commit(scope, "thread", initial);
    await first.commit(scope, "thread", patch(2, "updated"));
    first.close();
    const second = cache(factory);
    const value = await second.read(scope, "thread");
    expect(value?.checkpoint.projectionRevision).toBe(2);
    expect(value?.slots.map((value) => value.slot.kind)).toEqual(["deferred", "ready"]);
    expect(value?.slots[1]?.slot).toMatchObject({ messages: [{ parts: [{ text: "updated" }] }] });
    expect(await second.read({ ...scope, principalId: "other" }, "thread")).toBeUndefined();
  });

  test("paragraph patch writes only changed slot and checkpoint", async () => {
    const first = cache();
    const initial = patch();
    initial.put.unshift({
      revision: 1,
      slot: { kind: "deferred", slotId: "old", position: 0, endPosition: 1 },
    });
    await first.commit(scope, "thread", initial);
    const puts = spyOn(IDBObjectStore.prototype, "put");
    await first.commit(scope, "thread", patch(2));
    expect(puts.mock.calls).toHaveLength(2);
    puts.mockRestore();
  });

  test("streamed patches that arrive during a write share the next transaction", async () => {
    const factory = new IDBFactory();
    const first = cache(factory);
    await first.commit(scope, "thread", patch());
    const transactions = spyOn(IDBDatabase.prototype, "transaction");
    const writes = [2, 3, 4, 5].map((revision) =>
      first.commit(scope, "thread", patch(revision, `delta ${revision}`)),
    );
    await Promise.all(writes);
    // The first delta writes at once; the other three wait and land together.
    expect(transactions).toHaveBeenCalledTimes(2);
    transactions.mockRestore();
    first.close();
    const reopened = await cache(factory).read(scope, "thread");
    expect(reopened?.checkpoint.projectionRevision).toBe(5);
    expect(reopened?.slots[0]?.slot).toMatchObject({
      messages: [{ parts: [{ text: "delta 5" }] }],
    });
  });

  test("removing a thread drops its writes that have not started", async () => {
    const factory = new IDBFactory();
    const first = cache(factory);
    await first.commit(scope, "thread", patch());
    const running = first.commit(scope, "thread", patch(2));
    const queued = first.commit(scope, "thread", patch(3));
    await first.remove(scope, "thread");
    await Promise.all([running, queued]);
    first.close();
    expect(await cache(factory).read(scope, "thread")).toBeUndefined();
  });

  test("LRU eviction never stores an incomplete incremental checkpoint", async () => {
    const factory = new IDBFactory();
    const first = cache(factory, { maxThreads: 1 });
    await first.commit(scope, "one", patch());
    await first.commit(scope, "two", patch());
    await first.commit(scope, "one", patch(2));
    first.close();
    const second = cache(factory, { maxThreads: 1 });
    expect(await second.read(scope, "one")).toBeUndefined();
    expect(await second.read(scope, "two")).toBeDefined();
  });

  test("unsupported IndexedDB uses isolated memory cache", async () => {
    const first = cache(null);
    await first.commit(scope, "thread", patch());
    expect(first.persistent).toBe(false);
    expect(await first.read(scope, "thread")).toBeDefined();
    await first.purge(scope);
    expect(await first.read(scope, "thread")).toBeUndefined();
  });

  test("quota failure falls back without losing accepted in-memory state", async () => {
    const factory = new IDBFactory();
    const first = cache(factory);
    await first.commit(scope, "thread", patch());
    const put = spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => {
      throw new DOMException("Quota full", "QuotaExceededError");
    });
    await first.commit(scope, "thread", patch(2, "accepted"));
    put.mockRestore();
    expect(first.persistent).toBe(false);
    expect((await first.read(scope, "thread"))?.checkpoint.projectionRevision).toBe(2);
    await first.purge(scope);
    expect(await first.read(scope, "thread")).toBeUndefined();
  });

  test("bootstrap and drafts persist by principal and purge on logout", async () => {
    const factory = new IDBFactory();
    const first = cache(factory);
    await first.saveBootstrap(scope, bootstrap);
    await first.saveDraft(scope, "thread", { text: "unfinished", skillIds: [] });
    first.close();
    const second = cache(factory);
    expect((await second.readLatestBootstrap())?.scope).toEqual(scope);
    expect(await second.readDraft(scope, "thread")).toMatchObject({
      text: "unfinished",
      skillIds: [],
    });
    expect(await second.readDraft({ ...scope, principalId: "other" }, "thread")).toMatchObject({
      text: "",
      skillIds: [],
    });
    await second.purge(scope);
    expect(await second.readLatestBootstrap()).toBeUndefined();
    expect(await second.readDraft(scope, "thread")).toMatchObject({ text: "", skillIds: [] });
  });

  test("unchanged bootstrap retains catalog data without caching selected transcript twice", async () => {
    const first = cache();
    await first.saveBootstrap(scope, bootstrap);
    await first.saveBootstrap(scope, {
      ...bootstrap,
      catalog: { kind: "unchanged", revision: "catalog" },
      selectedThread: { kind: "window", checkpoint: patch().checkpoint, slots: [] },
    });
    const saved = await first.readBootstrap(scope);
    expect(saved?.bootstrap.catalog.kind).toBe("catalog");
    expect(saved?.bootstrap.selectedThread).toBeUndefined();
  });
});

async function openRaw(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open("lilac-native-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("malformed persisted slot is a cache miss instead of trusted display state", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  await first.commit(scope, "thread", patch());
  first.close();
  const raw = await openRaw(factory);
  const tx = raw.transaction("slots", "readwrite");
  const complete = new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  const request = tx.objectStore("slots").openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor)
      cursor.update({ ...cursor.value, data: { revision: 2, slot: { kind: "invented" } } });
  };
  await complete;
  raw.close();
  expect(await cache(factory).read(scope, "thread")).toBeUndefined();
});

test("an aborted transaction never exposes its new checkpoint from persistent cache", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  await first.commit(scope, "thread", patch());
  const original = IDBObjectStore.prototype.put;
  const putting = spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = original.apply(this, args);
    if (this.name === "threads") this.transaction.abort();
    return request;
  });
  await first.commit(scope, "thread", patch(2));
  putting.mockRestore();
  expect(first.persistent).toBe(false);
  first.close();
  expect(await cache(factory).read(scope, "thread")).toBeUndefined();
});

test("structured composer identities survive cache reload", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  const draft = {
    text: "/review current change",
    skillIds: ["repo_review"],
    commandId: "review",
    savedText: "/review current change",
  };
  await first.saveDraft(scope, "thread", draft);
  first.close();
  expect(await cache(factory).readDraft(scope, "thread")).toEqual(draft);
});

test("legacy text-only draft rows retain text with empty selected skills", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  await first.saveDraft(scope, "thread", { text: "existing draft", skillIds: ["skill"] });
  first.close();
  const raw = await openRaw(factory);
  const tx = raw.transaction("drafts", "readwrite");
  const complete = new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  const request = tx.objectStore("drafts").openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor)
      cursor.update({
        key: cursor.primaryKey,
        scopeKey: JSON.stringify(["install", "owner", 1, 1]),
        text: "existing draft",
        updatedAt: 1,
      });
  };
  await complete;
  raw.close();
  expect(await cache(factory).readDraft(scope, "thread")).toMatchObject({
    text: "existing draft",
    skillIds: [],
  });
});

test("local draft discovery survives reload and excludes server drafts and other principals", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  const draft = {
    text: "**Unsent review**",
    skillIds: ["repo_review"],
    commandId: "review",
    savedText: "**Unsent review**",
    title: "Review notes",
    modelId: "fast-model",
  };
  await first.saveDraft(scope, "draft:local", draft);
  await first.saveDraft(scope, "server-thread", { text: "Existing chat draft", skillIds: [] });
  await first.saveDraft(scope, "draft:empty", { text: "  ", skillIds: [], title: "Empty draft" });
  await first.saveDraft({ ...scope, principalId: "other" }, "draft:private", {
    text: "Other person's draft",
    skillIds: [],
  });
  first.close();
  const second = cache(factory);
  expect(await second.listLocalDrafts(scope)).toEqual([{ threadId: "draft:local", draft }]);
  expect(await second.readDraft(scope, "draft:local")).toEqual(draft);
  await second.deleteDraft(scope, "draft:local");
  second.close();
  const third = cache(factory);
  expect(await third.listLocalDrafts(scope)).toEqual([]);
  expect((await third.readDraft(scope, "server-thread")).text).toBe("Existing chat draft");
  expect(await third.listLocalDrafts({ ...scope, principalId: "other" })).toHaveLength(1);
});

test("local drafts remain scoped and cloned when IndexedDB is unavailable", async () => {
  const first = cache(null);
  await first.saveDraft(scope, "draft:local", { text: "Unsent", skillIds: ["skill"] });
  await first.saveDraft(scope, "server-thread", { text: "Existing chat draft", skillIds: [] });
  const discovered = await first.listLocalDrafts(scope);
  discovered[0]!.draft.skillIds.push("mutated");
  expect((await first.listLocalDrafts(scope))[0]?.draft.skillIds).toEqual(["skill"]);
  expect(await first.listLocalDrafts({ ...scope, principalId: "other" })).toEqual([]);
  await first.deleteDraft(scope, "draft:local");
  expect(await first.listLocalDrafts(scope)).toEqual([]);
});

test("logout purges persisted local drafts and fences a discovery already in flight", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  await first.saveDraft(scope, "draft:local", { text: "Unsent", skillIds: [] });
  first.close();
  const second = cache(factory);
  const discovery = second.listLocalDrafts(scope);
  await second.purge(scope);
  expect(await discovery).toEqual([]);
  second.close();
  expect(await cache(factory).listLocalDrafts(scope)).toEqual([]);
});

test("local draft discovery ignores malformed keys and forged scope indexes", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  await first.saveDraft(scope, "draft:valid", { text: "Valid", skillIds: [] });
  first.close();
  const raw = await openRaw(factory);
  const tx = raw.transaction("drafts", "readwrite");
  const complete = new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  const store = tx.objectStore("drafts");
  const scopeKey = JSON.stringify(["install", "owner", 1, 1]);
  const row = { scopeKey, text: "Unexpected draft", skillIds: [], updatedAt: 1 };
  store.put({ ...row, key: "malformed" });
  store.put({
    ...row,
    key: JSON.stringify([JSON.stringify(["install", "other", 1, 1]), "draft:private"]),
  });
  store.put({ ...row, key: JSON.stringify([scopeKey, "draft:corrupt"]), title: 42 });
  await complete;
  raw.close();
  expect((await cache(factory).listLocalDrafts(scope)).map((entry) => entry.threadId)).toEqual([
    "draft:valid",
  ]);
});

test("draft writes avoid reading all draft bodies until the storage cap requires eviction", async () => {
  const factory = new IDBFactory();
  const first = cache(factory, { maxThreads: 2 });
  const getAll = spyOn(IDBIndex.prototype, "getAll");
  await first.saveDraft(scope, "draft:first", { text: "First", skillIds: [] });
  await first.saveDraft(scope, "draft:second", { text: "Second", skillIds: [] });
  await first.saveDraft(scope, "draft:first", { text: "First edited", skillIds: [] });
  expect(getAll).not.toHaveBeenCalled();
  await first.saveDraft(scope, "draft:third", { text: "Third", skillIds: [] });
  expect(getAll).toHaveBeenCalledTimes(1);
  getAll.mockRestore();
  first.close();
  const reopened = cache(factory, { maxThreads: 2 });
  expect((await reopened.listLocalDrafts(scope)).length).toBe(2);
});

test("revoking a parent removes persisted child streams across cache instances and preserves other scopes", async () => {
  const factory = new IDBFactory();
  const first = cache(factory);
  const child = "subagent:thread:wfrun:child";
  const otherScope = { ...scope, principalId: "other" };
  await first.commit(scope, "thread", patch());
  await first.commit(scope, child, patch(1, "Child transcript"));
  await first.commit(otherScope, child, patch(1, "Other principal"));
  first.close();
  const second = cache(factory);
  await second.remove(scope, "thread");
  expect(await second.read(scope, "thread")).toBeUndefined();
  expect(await second.read(scope, child)).toBeUndefined();
  expect(await second.read(otherScope, child)).toBeDefined();
});

async function draftRowKeys(factory: IDBFactory): Promise<string[]> {
  const raw = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("lilac-native-v1", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = raw.transaction("drafts", "readonly").objectStore("drafts").getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  raw.close();
  return keys.map((key) => JSON.parse(String(key))[1] as string).sort();
}

test("clearing a draft deletes its row so empty drafts never evict real ones", async () => {
  const factory = new IDBFactory();
  const first = cache(factory, { maxThreads: 2 });
  await first.saveDraft(scope, "kept", { text: "Keep me", skillIds: [] });
  await first.saveDraft(scope, "question", { text: "Typed answer", skillIds: [] });
  await first.saveDraft(scope, "question", { text: "", skillIds: [] });
  await first.saveDraft(scope, "cleared", { text: "  ", skillIds: [] });
  await first.saveDraft(scope, "newer", { text: "Newer", skillIds: [] });
  first.close();
  expect(await draftRowKeys(factory)).toEqual(["kept", "newer"]);
  const reopened = cache(factory, { maxThreads: 2 });
  expect((await reopened.readDraft(scope, "kept")).text).toBe("Keep me");
  expect((await reopened.readDraft(scope, "question")).text).toBe("");
});

test("draft eviction counts each principal separately", async () => {
  const factory = new IDBFactory();
  const first = cache(factory, { maxThreads: 2 });
  const other = { ...scope, principalId: "other" };
  await first.saveDraft(scope, "draft:mine-1", { text: "Mine 1", skillIds: [] });
  await first.saveDraft(scope, "draft:mine-2", { text: "Mine 2", skillIds: [] });
  await first.saveDraft(other, "draft:theirs-1", { text: "Theirs 1", skillIds: [] });
  await first.saveDraft(other, "draft:theirs-2", { text: "Theirs 2", skillIds: [] });
  first.close();
  const reopened = cache(factory, { maxThreads: 2 });
  expect((await reopened.listLocalDrafts(scope)).map((entry) => entry.threadId).sort()).toEqual([
    "draft:mine-1",
    "draft:mine-2",
  ]);
});

test("in-memory drafts are capped per principal when IndexedDB is unavailable", async () => {
  const first = cache(null, { maxThreads: 1 });
  const other = { ...scope, principalId: "other" };
  await first.saveDraft(scope, "draft:mine", { text: "Mine", skillIds: [] });
  await first.saveDraft(other, "draft:theirs", { text: "Theirs", skillIds: [] });
  expect((await first.readDraft(scope, "draft:mine")).text).toBe("Mine");
});

test("typing writes one draft row after the pause, and reads see every keystroke before it", async () => {
  const factory = new IDBFactory();
  const first = cache(factory, { draftWriteDelayMs: 60_000 });
  const put = spyOn(IDBObjectStore.prototype, "put");
  const saved: Promise<void>[] = [];
  for (const text of ["H", "He", "Hel", "Hello"])
    saved.push(first.saveDraft(scope, "thread", { text, skillIds: [] }));
  expect((await first.readDraft(scope, "thread")).text).toBe("Hello");
  expect(put).not.toHaveBeenCalled();
  await first.flushDrafts();
  await Promise.all(saved);
  expect(
    put.mock.calls.filter(([row]) => (row as { text?: string }).text !== undefined),
  ).toHaveLength(1);
  put.mockRestore();
  first.close();
  expect((await cache(factory).readDraft(scope, "thread")).text).toBe("Hello");
});

test("clearing a draft before its write lands leaves no row behind", async () => {
  const factory = new IDBFactory();
  const first = cache(factory, { draftWriteDelayMs: 60_000 });
  void first.saveDraft(scope, "draft:local", { text: "Unsent", skillIds: [] });
  expect((await first.listLocalDrafts(scope)).map((entry) => entry.threadId)).toEqual([
    "draft:local",
  ]);
  void first.saveDraft(scope, "draft:local", { text: "", skillIds: [] });
  expect(await first.listLocalDrafts(scope)).toEqual([]);
  await first.flushDrafts();
  expect(await draftRowKeys(factory)).toEqual([]);
});

test("merged patches match applying both in order", () => {
  const slot = (slotId: string, revision: number) => ({
    revision,
    slot: { kind: "deferred" as const, slotId, position: revision, endPosition: revision + 1 },
  });
  const checkpoint = (projectionRevision: number) => ({
    protocolVersion: 1 as const,
    historyGeneration: 0,
    projectionRevision,
    cursor: `cursor_${projectionRevision}`,
  });
  const first = { checkpoint: checkpoint(1), replace: false, put: [slot("a", 1)], remove: ["b"] };
  const next = {
    checkpoint: checkpoint(2),
    replace: false,
    put: [slot("b", 2)],
    remove: ["a", "c"],
  };
  expect(mergeCachePatches(first, next)).toEqual({
    checkpoint: checkpoint(2),
    replace: false,
    put: [slot("b", 2)],
    remove: ["a", "c"],
  });
  const replaced = { ...first, replace: true };
  expect(mergeCachePatches(replaced, next)).toEqual({
    checkpoint: checkpoint(2),
    replace: true,
    put: [slot("b", 2)],
    remove: [],
  });
  const reset = { ...next, replace: true };
  expect(mergeCachePatches(first, reset)).toBe(reset);
});
