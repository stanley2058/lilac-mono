import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import {
  BlobAdapterFailure,
  BlobDeleteFailed,
  BlobIntegrityFailure,
  createMemoryBlobStore,
  type BlobReadComplete,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";
import { Panic, Result, type Result as ResultType } from "better-result";

import type { ResourceId, ResourceOriginV1, ResourceRecordV1 } from "../../src/resource/contracts";
import { ResourceStoreFailure } from "../../src/resource/errors";
import {
  ResourceOriginAdapterRegistry,
  type ResourceOriginAdapter,
} from "../../src/resource/origin";
import { consumeVerifiedResourceRead, CoreResourceService } from "../../src/resource/service";
import type {
  ResourceCacheAttachDecision,
  ResourceRegisterDecision,
  ResourceStore,
  ResourceUnretainedFinalization,
} from "../../src/resource/store";

function success<T, E>(result: ResultType<T, E>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

function failure<T, E>(result: ResultType<T, E>): E {
  return result.match({
    ok: () => {
      throw new Error("Expected an error Result");
    },
    err: (error) => error,
  });
}

const origin: ResourceOriginV1 = {
  version: 1,
  kind: "discord-attachment",
  channelId: "channel",
  messageId: "message",
  ordinal: 0,
  attachmentId: "attachment",
};

class MemoryResourceStore implements ResourceStore {
  readonly records = new Map<ResourceId, ResourceRecordV1>();
  readonly retained = new Set<ResourceId>();
  readonly finalized: ResourceId[] = [];
  readonly cacheAttached: Promise<void>;
  #resolveCacheAttached!: () => void;
  getRetainedDefect?: Panic;
  beforeClearCache?: (input: Parameters<ResourceStore["clearCache"]>[0]) => void;

  constructor() {
    this.cacheAttached = new Promise((resolve) => {
      this.#resolveCacheAttached = resolve;
    });
  }

  registerOrGet(
    input: Parameters<ResourceStore["registerOrGet"]>[0],
  ): ResultType<ResourceRegisterDecision, ResourceStoreFailure> {
    const existing = [...this.records.values()].find(
      (record) => JSON.stringify(record.origin) === JSON.stringify(input.origin),
    );
    if (existing) return Result.ok({ kind: "existing", record: existing });
    if (this.records.has(input.candidateResourceId)) return Result.ok({ kind: "collision" });
    const record: ResourceRecordV1 = {
      version: 1,
      resourceId: input.candidateResourceId,
      origin: input.origin,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      ...(input.declaredMediaType === undefined
        ? {}
        : { declaredMediaType: input.declaredMediaType }),
      ...(input.reportedByteLength === undefined
        ? {}
        : { reportedByteLength: input.reportedByteLength }),
      createdAt: input.createdAt,
    };
    this.records.set(record.resourceId, record);
    return Result.ok({ kind: "created", record });
  }

  getRetained(resourceId: ResourceId): ResultType<ResourceRecordV1 | null, ResourceStoreFailure> {
    if (this.getRetainedDefect !== undefined) throw this.getRetainedDefect;
    return Result.ok(this.retained.has(resourceId) ? (this.records.get(resourceId) ?? null) : null);
  }

  compareAndSwapCache(
    input: Parameters<ResourceStore["compareAndSwapCache"]>[0],
  ): ResultType<ResourceCacheAttachDecision, ResourceStoreFailure> {
    const current = this.records.get(input.resourceId);
    if (!current) return Result.ok({ kind: "lost", record: null });
    if (JSON.stringify(current.cache) !== JSON.stringify(input.expected)) {
      return Result.ok({ kind: "lost", record: current });
    }
    const record = {
      ...current,
      cache: input.next,
      ...(input.detectedMediaType === undefined
        ? {}
        : { detectedMediaType: input.detectedMediaType }),
    };
    this.records.set(input.resourceId, record);
    this.#resolveCacheAttached();
    return Result.ok({ kind: "attached", record });
  }

  clearCache(
    input: Parameters<ResourceStore["clearCache"]>[0],
  ): ResultType<boolean, ResourceStoreFailure> {
    this.beforeClearCache?.(input);
    const current = this.records.get(input.resourceId);
    if (!current || JSON.stringify(current.cache) !== JSON.stringify(input.expected))
      return Result.ok(false);
    const { cache: _cache, ...record } = current;
    this.records.set(input.resourceId, record);
    return Result.ok(true);
  }

  recordDetectedMediaType(
    input: Parameters<ResourceStore["recordDetectedMediaType"]>[0],
  ): ResultType<boolean, ResourceStoreFailure> {
    const current = this.records.get(input.resourceId);
    if (!current || current.detectedMediaType !== input.expected) return Result.ok(false);
    this.records.set(input.resourceId, {
      ...current,
      detectedMediaType: input.next,
    });
    return Result.ok(true);
  }

  listUnretained(): ResultType<readonly ResourceRecordV1[], ResourceStoreFailure> {
    return Result.ok(
      [...this.records.values()].filter((record) => !this.retained.has(record.resourceId)),
    );
  }

  finalizeUnretained(
    input: Parameters<ResourceStore["finalizeUnretained"]>[0],
  ): ResultType<ResourceUnretainedFinalization, ResourceStoreFailure> {
    this.finalized.push(input.resourceId);
    const current = this.records.get(input.resourceId);
    if (!current) return Result.ok({ kind: "absent" });
    if (this.retained.has(input.resourceId))
      return Result.ok({ kind: "retained", record: current });
    if (JSON.stringify(current.cache) !== JSON.stringify(input.expectedCache)) {
      return Result.ok({ kind: "changed", record: current });
    }
    this.records.delete(input.resourceId);
    return Result.ok({ kind: "deleted" });
  }
}

async function fixture(input: {
  bytes: Uint8Array;
  filename?: string;
  declaredMediaType?: string;
  reportedByteLength?: number;
  limits?: ConstructorParameters<typeof CoreResourceService>[0]["limits"];
  waitForFetch?: Promise<void>;
  fetch?: NonNullable<ConstructorParameters<typeof CoreResourceService>[0]["fetch"]>;
  now?: () => number;
  retain?: boolean;
}) {
  const ownedBlobStore = success(await createMemoryBlobStore());
  let uploadCount = 0;
  let openOverride: ((ref: BlobRefV1) => ReturnType<BlobStore["open"]>) | undefined;
  let deleteOverride:
    | ((target: Parameters<BlobStore["delete"]>[0]) => ReturnType<BlobStore["delete"]>)
    | undefined;
  const blobStore: BlobStore = {
    startUpload: (upload) => {
      uploadCount += 1;
      return ownedBlobStore.startUpload(upload);
    },
    resolve: (handle, options) => ownedBlobStore.resolve(handle, options),
    open: (ref) => openOverride?.(ref) ?? ownedBlobStore.open(ref),
    delete: (target) => deleteOverride?.(target) ?? ownedBlobStore.delete(target),
    maintain: (options) => ownedBlobStore.maintain(options),
    close: (options) => ownedBlobStore.close(options),
  };
  const store = new MemoryResourceStore();
  let fetchCount = 0;
  const adapter: ResourceOriginAdapter = {
    kind: "discord-attachment",
    resolve: async ({ record }) =>
      Result.ok({
        url: new URL(`https://cdn.example.test/${record.resourceId}`),
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...(input.declaredMediaType === undefined
          ? {}
          : { declaredMediaType: input.declaredMediaType }),
        ...(input.reportedByteLength === undefined
          ? {}
          : { reportedByteLength: input.reportedByteLength }),
      }),
  };
  const service = new CoreResourceService({
    store,
    blobStore,
    originAdapters: new ResourceOriginAdapterRegistry([adapter]),
    fetch: async (url, init) => {
      fetchCount += 1;
      if (input.fetch !== undefined) return input.fetch(url, init);
      await input.waitForFetch;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(input.bytes);
            controller.close();
          },
        }),
      );
    },
    randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index),
    limits: input.limits,
    now: input.now,
  });
  const descriptor = success(
    await service.register({
      origin,
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      ...(input.declaredMediaType === undefined
        ? {}
        : { declaredMediaType: input.declaredMediaType }),
      ...(input.reportedByteLength === undefined
        ? {}
        : { reportedByteLength: input.reportedByteLength }),
    }),
  );
  const resourceId = descriptor.uri.slice("resource://".length) as ResourceId;
  if (input.retain !== false) store.retained.add(resourceId);
  return {
    blobStore,
    descriptor,
    fetchCount: () => fetchCount,
    resourceId,
    service,
    store,
    deleteStoredBlob: (target: Parameters<BlobStore["delete"]>[0]) => ownedBlobStore.delete(target),
    openStoredBlob: (ref: BlobRefV1) => ownedBlobStore.open(ref),
    setDeleteOverride: (next: typeof deleteOverride) => {
      deleteOverride = next;
    },
    setOpenOverride: (next: typeof openOverride) => {
      openOverride = next;
    },
    uploadCount: () => uploadCount,
  };
}

async function closeFixture(service: CoreResourceService, blobStore: BlobStore): Promise<void> {
  await service.close();
  success(await blobStore.close({ deadlineAtMs: Date.now() + 5_000 }));
}

describe("CoreResourceService", () => {
  test("describe preserves a store Panic with exact identity", async () => {
    const resources = await fixture({
      bytes: new TextEncoder().encode("resource"),
    });
    const defect = new Panic({ message: "resource store invariant failed" });
    resources.store.getRetainedDefect = defect;

    const captured = Result.try({
      try: () => resources.service.describe(resources.descriptor.uri),
      catch: (cause) => cause,
    });
    expect(failure(captured)).toBe(defect);

    resources.store.getRetainedDefect = undefined;
    await closeFixture(resources.service, resources.blobStore);
  });

  test("preserves a readPrefix Panic with exact identity", async () => {
    const resources = await fixture({
      bytes: new TextEncoder().encode("resource"),
    });
    const defect = new Panic({ message: "blob read invariant failed" });
    resources.setOpenOverride((ref) => {
      const completion = Promise.withResolvers<ResultType<BlobReadComplete, never>>();
      return Promise.resolve(
        Result.ok({
          ref,
          stream: new ReadableStream<Uint8Array>({
            pull(controller) {
              completion.reject(defect);
              controller.error(defect);
            },
          }),
          completion: completion.promise,
        }),
      );
    });

    const captured = await Result.tryPromise({
      try: () => resources.service.open(resources.descriptor.uri, { maxBytes: 100 }),
      catch: (cause) =>
        Panic.is(cause) ? cause : new Panic({ message: "Unexpected non-Panic rejection", cause }),
    });
    expect(failure(captured)).toBe(defect);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("re-registering a cached origin does not refill or replace the cache", async () => {
    const resources = await fixture({
      bytes: new TextEncoder().encode("cached resource"),
      filename: "cached.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: 15,
    });
    await resources.store.cacheAttached;
    const cacheBefore = resources.store.records.get(resources.resourceId)?.cache;
    expect(cacheBefore).toBeDefined();

    const descriptor = success(
      await resources.service.register({
        origin,
        filename: "cached.txt",
        declaredMediaType: "text/plain",
        reportedByteLength: 15,
      }),
    );
    await resources.service.close();

    expect(descriptor.uri).toBe(resources.descriptor.uri);
    expect(resources.fetchCount()).toBe(1);
    expect(resources.uploadCount()).toBe(1);
    expect(resources.store.records.get(resources.resourceId)?.cache).toEqual(cacheBefore);
    success(await resources.blobStore.close({ deadlineAtMs: Date.now() + 5_000 }));
  });

  test("bounds origin downloads and retries a transport failure on a fresh connection", async () => {
    const bytes = new TextEncoder().encode("retried resource");
    const requests: BunFetchRequestInit[] = [];
    const resources = await fixture({
      bytes,
      filename: "retried.txt",
      declaredMediaType: "text/plain",
      fetch: async (_url, init) => {
        requests.push(init);
        if (requests.length === 1) throw new Error("stale pooled connection");
        return new Response(bytes);
      },
    });

    const read = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );

    expect(success(await consumeVerifiedResourceRead(read))).toEqual(bytes);
    expect(requests).toHaveLength(2);
    expect(requests.map(({ timeout }) => timeout)).toEqual([15_000, 15_000]);
    expect(requests[0]?.keepalive).toBeUndefined();
    expect(requests[1]?.keepalive).toBe(false);
    expect(requests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
    expect(resources.uploadCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("retries a failed response body on a fresh connection", async () => {
    const bytes = new TextEncoder().encode("retried stream");
    const requests: BunFetchRequestInit[] = [];
    const resources = await fixture({
      bytes,
      filename: "retried.txt",
      declaredMediaType: "text/plain",
      fetch: async (_url, init) => {
        requests.push(init);
        if (requests.length > 1) return new Response(bytes);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("stale pooled response body"));
            },
          }),
        );
      },
    });

    const read = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );

    expect(success(await consumeVerifiedResourceRead(read))).toEqual(bytes);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.keepalive).toBe(false);
    expect(resources.uploadCount()).toBe(2);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("releases a registration reservation after observing durable retention", async () => {
    let now = 10_000;
    const resources = await fixture({
      bytes: new TextEncoder().encode("resource"),
      now: () => now,
      retain: false,
    });

    const protectedMaintenance = success(await resources.service.maintain({ limit: 10 }));
    expect(protectedMaintenance).toMatchObject({
      inspected: 1,
      deleted: 0,
      changed: 0,
    });
    expect(resources.store.finalized).toEqual([]);
    expect(resources.store.records.has(resources.resourceId)).toBe(true);

    resources.store.retained.add(resources.resourceId);
    success(await resources.service.maintain({ limit: 10 }));
    resources.store.retained.delete(resources.resourceId);

    const releasedMaintenance = success(await resources.service.maintain({ limit: 10 }));
    expect(releasedMaintenance.deleted).toBe(1);
    expect(resources.store.finalized).toEqual([resources.resourceId]);
    expect(resources.store.records.has(resources.resourceId)).toBe(false);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("bounds a reused zero-reference registration from its latest request", async () => {
    let now = 10_000;
    const resources = await fixture({
      bytes: new TextEncoder().encode("resource"),
      now: () => now,
      retain: false,
    });
    now += 60_001;
    const registeredAgain = success(await resources.service.register({ origin }));
    expect(registeredAgain.uri).toBe(resources.descriptor.uri);

    const renewedMaintenance = success(await resources.service.maintain({ limit: 10 }));
    expect(renewedMaintenance).toMatchObject({
      inspected: 1,
      deleted: 0,
      changed: 0,
    });
    expect(resources.store.records.has(resources.resourceId)).toBe(true);

    now += 60_001;
    const expiredMaintenance = success(await resources.service.maintain({ limit: 10 }));
    expect(expiredMaintenance.deleted).toBe(1);
    expect(resources.store.records.has(resources.resourceId)).toBe(false);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("waits for one terminal cache repair before returning the integrity failure", async () => {
    const bytes = new TextEncoder().encode("cached resource");
    const resources = await fixture({
      bytes,
      filename: "cached.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: bytes.byteLength,
    });
    await resources.store.cacheAttached;
    const staleCache = resources.store.records.get(resources.resourceId)?.cache;
    if (staleCache === undefined) throw new Error("Expected eager cache fill");
    let corruptOpenCount = 0;
    resources.setOpenOverride((ref) => {
      if (ref.objectId !== staleCache.blob.objectId) return resources.openStoredBlob(ref);
      corruptOpenCount += 1;
      return Promise.resolve(
        Result.ok({
          ref,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          completion: Promise.resolve(
            Result.err(
              new BlobIntegrityFailure({
                objectId: ref.objectId,
                reason: "digest mismatch",
                message: "terminal verification failed",
              }),
            ),
          ),
        }),
      );
    });

    const corruptRead = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(failure(await consumeVerifiedResourceRead(corruptRead))._tag).toBe(
      "ResourceIntegrityFailure",
    );

    const repairedCache = resources.store.records.get(resources.resourceId)?.cache;
    expect(repairedCache?.blob.objectId).not.toBe(staleCache.blob.objectId);
    const repairedRead = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(success(await consumeVerifiedResourceRead(repairedRead))).toEqual(bytes);
    expect(corruptOpenCount).toBe(1);
    expect(resources.fetchCount()).toBe(2);
    expect(resources.uploadCount()).toBe(2);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("repairs terminal corruption on the first read of a newly filled blob", async () => {
    const bytes = new TextEncoder().encode("origin resource");
    const resources = await fixture({
      bytes,
      filename: "origin.txt",
      declaredMediaType: "text/plain",
    });
    let corruptFirstOpen = true;
    resources.setOpenOverride((ref) => {
      if (!corruptFirstOpen) return resources.openStoredBlob(ref);
      corruptFirstOpen = false;
      return Promise.resolve(
        Result.ok({
          ref,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          completion: Promise.resolve(
            Result.err(
              new BlobIntegrityFailure({
                objectId: ref.objectId,
                reason: "digest mismatch",
                message: "terminal verification failed",
              }),
            ),
          ),
        }),
      );
    });

    const firstRead = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(failure(await consumeVerifiedResourceRead(firstRead))._tag).toBe(
      "ResourceIntegrityFailure",
    );
    expect(resources.fetchCount()).toBe(2);
    expect(resources.uploadCount()).toBe(2);
    expect(resources.store.records.get(resources.resourceId)?.cache?.blob.objectId).not.toBe(
      firstRead.blob.objectId,
    );

    await closeFixture(resources.service, resources.blobStore);
  });

  test("retains a corrupt cache reference when durable deletion fails", async () => {
    const bytes = new TextEncoder().encode("cached resource");
    const resources = await fixture({
      bytes,
      filename: "cached.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: bytes.byteLength,
    });
    await resources.store.cacheAttached;
    const staleCache = resources.store.records.get(resources.resourceId)?.cache;
    if (staleCache === undefined) throw new Error("Expected eager cache fill");
    resources.setOpenOverride((ref) => {
      if (ref.objectId !== staleCache.blob.objectId) return resources.openStoredBlob(ref);
      return Promise.resolve(
        Result.ok({
          ref,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          completion: Promise.resolve(
            Result.err(
              new BlobIntegrityFailure({
                objectId: ref.objectId,
                reason: "digest mismatch",
                message: "terminal verification failed",
              }),
            ),
          ),
        }),
      );
    });
    resources.setDeleteOverride((target) =>
      Promise.resolve(
        Result.err(
          new BlobDeleteFailed({
            objectId: target.objectId,
            failure: new BlobAdapterFailure({
              adapter: "memory",
              kind: "io",
              operation: "delete",
              message: "test delete failed",
            }),
            message: "test delete failed",
          }),
        ),
      ),
    );

    const corruptRead = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(failure(await consumeVerifiedResourceRead(corruptRead))._tag).toBe(
      "ResourceIntegrityFailure",
    );
    expect(resources.store.records.get(resources.resourceId)?.cache).toEqual(staleCache);
    expect(resources.fetchCount()).toBe(1);

    resources.setDeleteOverride(undefined);
    await closeFixture(resources.service, resources.blobStore);
  });

  test("preserves a concurrent cache winner during terminal repair", async () => {
    const bytes = new TextEncoder().encode("cached resource");
    const resources = await fixture({
      bytes,
      filename: "cached.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: bytes.byteLength,
    });
    await resources.store.cacheAttached;
    const staleCache = resources.store.records.get(resources.resourceId)?.cache;
    if (staleCache === undefined) throw new Error("Expected eager cache fill");
    const winningCache = {
      blob: { ...staleCache.blob, objectId: `b1_${"f".repeat(32)}` },
      cachedAt: staleCache.cachedAt + 1,
    };
    resources.setOpenOverride((ref) =>
      Promise.resolve(
        Result.ok({
          ref,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          completion: Promise.resolve(
            Result.err(
              new BlobIntegrityFailure({
                objectId: ref.objectId,
                reason: "digest mismatch",
                message: "terminal verification failed",
              }),
            ),
          ),
        }),
      ),
    );
    resources.store.beforeClearCache = ({ resourceId }) => {
      resources.store.beforeClearCache = undefined;
      const current = resources.store.records.get(resourceId);
      if (current !== undefined) {
        resources.store.records.set(resourceId, {
          ...current,
          cache: winningCache,
        });
      }
    };

    const corruptRead = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(failure(await consumeVerifiedResourceRead(corruptRead))._tag).toBe(
      "ResourceIntegrityFailure",
    );
    expect(resources.store.records.get(resources.resourceId)?.cache).toEqual(winningCache);
    expect(resources.fetchCount()).toBe(1);
    expect(resources.uploadCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("clears a corrupt cache reference when the supervised refill fails", async () => {
    const bytes = new TextEncoder().encode("cached resource");
    let fetchAttempt = 0;
    const resources = await fixture({
      bytes,
      filename: "cached.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: bytes.byteLength,
      fetch: async () => {
        fetchAttempt += 1;
        return fetchAttempt === 1 ? new Response(bytes) : new Response(null, { status: 503 });
      },
    });
    await resources.store.cacheAttached;
    const staleCache = resources.store.records.get(resources.resourceId)?.cache;
    if (staleCache === undefined) throw new Error("Expected eager cache fill");
    let corruptOpenCount = 0;
    resources.setOpenOverride((ref) => {
      if (ref.objectId !== staleCache.blob.objectId) return resources.openStoredBlob(ref);
      corruptOpenCount += 1;
      return Promise.resolve(
        Result.ok({
          ref,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          completion: Promise.resolve(
            Result.err(
              new BlobIntegrityFailure({
                objectId: ref.objectId,
                reason: "length mismatch",
                message: "terminal verification failed",
              }),
            ),
          ),
        }),
      );
    });

    const corruptRead = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(failure(await consumeVerifiedResourceRead(corruptRead))._tag).toBe(
      "ResourceIntegrityFailure",
    );
    expect(resources.store.records.get(resources.resourceId)?.cache).toBeUndefined();
    expect(corruptOpenCount).toBe(1);
    expect(resources.fetchCount()).toBe(2);
    expect(resources.uploadCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("coalesces different caller limits while rejecting only the smaller caller", async () => {
    const fetchGate = Promise.withResolvers<void>();
    const bytes = new TextEncoder().encode("12345678");
    const resources = await fixture({
      bytes,
      filename: "shared.txt",
      declaredMediaType: "text/plain",
      waitForFetch: fetchGate.promise,
    });

    const smallOpen = resources.service.open(resources.descriptor.uri, {
      maxBytes: 5,
      expected: "text",
    });
    const largeOpen = resources.service.open(resources.descriptor.uri, {
      maxBytes: 20,
      expected: "text",
    });
    fetchGate.resolve();

    const smallError = failure(await smallOpen);
    expect(smallError._tag).toBe("ResourceTooLarge");
    if (smallError._tag === "ResourceTooLarge") {
      expect(smallError.limit).toBe(5);
      expect(smallError.observedBytes).toBe(bytes.byteLength);
    }
    const largeRead = success(await largeOpen);
    expect(success(await consumeVerifiedResourceRead(largeRead))).toEqual(bytes);
    expect(resources.fetchCount()).toBe(1);
    expect(resources.uploadCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("coalesces eager fill with a larger caller when actual bytes exceed the eager limit", async () => {
    const fetchGate = Promise.withResolvers<void>();
    const bytes = new TextEncoder().encode("12345678");
    const resources = await fixture({
      bytes,
      reportedByteLength: 4,
      limits: { maxBytes: 20, modelInlineMaxBytes: 5 },
      waitForFetch: fetchGate.promise,
    });

    const opened = resources.service.open(resources.descriptor.uri, {
      maxBytes: 20,
      expected: "any",
    });
    fetchGate.resolve();
    const read = success(await opened);
    expect(success(await consumeVerifiedResourceRead(read))).toEqual(bytes);
    expect(resources.fetchCount()).toBe(1);
    expect(resources.uploadCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("treats Discord size and MIME as hints when downloaded bytes were transformed", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const resources = await fixture({
      bytes: png,
      filename: "advertised.webp",
      declaredMediaType: "image/webp",
      reportedByteLength: 1,
    });

    const read = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "image",
      }),
    );

    expect(read.classification).toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    expect(success(await consumeVerifiedResourceRead(read))).toEqual(png);
    expect(resources.store.records.get(resources.resourceId)?.detectedMediaType).toBe("image/png");

    await closeFixture(resources.service, resources.blobStore);
  });

  test("uses the filename and UTF-8 bytes instead of a declared image MIME", async () => {
    const bytes = new TextEncoder().encode("transformed text");
    const resources = await fixture({
      bytes,
      filename: "notes.txt",
      declaredMediaType: "image/webp",
    });

    const read = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );

    expect(read.classification).toEqual({
      kind: "text",
      mediaType: "text/plain",
      encoding: "utf-8",
    });
    expect(success(await consumeVerifiedResourceRead(read))).toEqual(bytes);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("does not reject a small download from stored or refreshed reported sizes", async () => {
    const bytes = new TextEncoder().encode("tiny");
    const resources = await fixture({
      bytes,
      filename: "tiny.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: 10_000,
      limits: { maxBytes: 100, modelInlineMaxBytes: 10 },
    });

    const read = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 5,
        expected: "text",
      }),
    );
    expect(success(await consumeVerifiedResourceRead(read))).toEqual(bytes);
    expect(resources.fetchCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("uses observed bytes over a stale reported length for a late fill participant", async () => {
    const secondPullStarted = Promise.withResolvers<void>();
    const releaseSecondChunk = Promise.withResolvers<void>();
    let pullCount = 0;
    const resources = await fixture({
      bytes: new Uint8Array(),
      filename: "shared.txt",
      declaredMediaType: "text/plain",
      reportedByteLength: 4,
      limits: { maxBytes: 20, modelInlineMaxBytes: 1 },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                pullCount += 1;
                if (pullCount === 1) {
                  controller.enqueue(new TextEncoder().encode("12345678"));
                  return;
                }
                secondPullStarted.resolve();
                await releaseSecondChunk.promise;
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    });

    const largeOpen = resources.service.open(resources.descriptor.uri, {
      maxBytes: 20,
      expected: "text",
    });
    await secondPullStarted.promise;
    const smallError = failure(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 5,
        expected: "text",
      }),
    );
    expect(smallError._tag).toBe("ResourceTooLarge");
    if (smallError._tag === "ResourceTooLarge") expect(smallError.observedBytes).toBe(8);
    releaseSecondChunk.resolve();

    const largeRead = success(await largeOpen);
    expect(new TextDecoder().decode(success(await consumeVerifiedResourceRead(largeRead)))).toBe(
      "12345678",
    );
    expect(resources.fetchCount()).toBe(1);
    expect(resources.uploadCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("cancels one fill participant without cancelling its coalesced peer", async () => {
    const fetchGate = Promise.withResolvers<void>();
    const bytes = new TextEncoder().encode("shared");
    const resources = await fixture({
      bytes,
      filename: "shared.txt",
      declaredMediaType: "text/plain",
      waitForFetch: fetchGate.promise,
    });
    const cancelled = new AbortController();

    const cancelledOpen = resources.service.open(resources.descriptor.uri, {
      maxBytes: 10,
      expected: "text",
      signal: cancelled.signal,
    });
    const survivingOpen = resources.service.open(resources.descriptor.uri, {
      maxBytes: 20,
      expected: "text",
    });
    cancelled.abort();
    fetchGate.resolve();

    expect(failure(await cancelledOpen)._tag).toBe("ResourceCancelled");
    const survivingRead = success(await survivingOpen);
    expect(success(await consumeVerifiedResourceRead(survivingRead))).toEqual(bytes);
    expect(resources.fetchCount()).toBe(1);
    expect(resources.uploadCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("aborts an unobserved fill and lets a later caller start cleanly", async () => {
    const firstFetchStarted = Promise.withResolvers<void>();
    const bytes = new TextEncoder().encode("recovered");
    let fetchAttempt = 0;
    let abortCount = 0;
    const resources = await fixture({
      bytes,
      filename: "shared.txt",
      declaredMediaType: "text/plain",
      fetch: async (_url, init) => {
        fetchAttempt += 1;
        if (fetchAttempt > 1) return new Response(bytes);
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              firstFetchStarted.resolve();
              init.signal?.addEventListener(
                "abort",
                () => {
                  abortCount += 1;
                  controller.error(new Error("aborted test body"));
                },
                { once: true },
              );
            },
          }),
        );
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstOpen = resources.service.open(resources.descriptor.uri, {
      maxBytes: 20,
      signal: firstController.signal,
    });
    const secondOpen = resources.service.open(resources.descriptor.uri, {
      maxBytes: 20,
      signal: secondController.signal,
    });
    await firstFetchStarted.promise;
    firstController.abort();
    secondController.abort();

    expect(failure(await firstOpen)._tag).toBe("ResourceCancelled");
    expect(failure(await secondOpen)._tag).toBe("ResourceCancelled");
    expect(resources.store.records.get(resources.resourceId)?.cache).toBeUndefined();

    const recovered = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 20,
        expected: "text",
      }),
    );
    expect(success(await consumeVerifiedResourceRead(recovered))).toEqual(bytes);
    expect(abortCount).toBe(1);
    expect(resources.fetchCount()).toBe(2);
    expect(resources.uploadCount()).toBe(2);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("streams a cache miss once and reuses the verified cache", async () => {
    const resources = await fixture({
      bytes: new TextEncoder().encode("hello resource"),
      filename: "note.txt",
      declaredMediaType: "text/plain",
    });

    const first = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(new TextDecoder().decode(success(await consumeVerifiedResourceRead(first)))).toBe(
      "hello resource",
    );
    const second = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 100,
        expected: "text",
      }),
    );
    expect(new TextDecoder().decode(success(await consumeVerifiedResourceRead(second)))).toBe(
      "hello resource",
    );
    expect(resources.fetchCount()).toBe(1);

    await closeFixture(resources.service, resources.blobStore);
  });

  test("enforces the actual streamed operation limit", async () => {
    const resources = await fixture({
      bytes: new TextEncoder().encode("0123456789"),
      filename: "note.txt",
      declaredMediaType: "text/plain",
      limits: { maxBytes: 64, modelInlineMaxBytes: 4 },
    });

    const error = failure(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 5,
        expected: "text",
      }),
    );
    expect(error._tag).toBe("ResourceTooLarge");
    if (error._tag === "ResourceTooLarge") {
      expect(error.limitKind).toBe("operation");
      expect(error.observedBytes).toBe(10);
    }

    await closeFixture(resources.service, resources.blobStore);
  });

  test("rejects invalid UTF-8 for text reads but materializes the same bytes", async () => {
    const bytes = new Uint8Array(8 * 1024 + 3).fill(0x61);
    bytes.set([0xc3, 0x28], bytes.byteLength - 2);
    const resources = await fixture({
      bytes,
      filename: "broken.txt",
      declaredMediaType: "text/plain",
      limits: { modelInlineMaxBytes: 1 },
    });

    const textRead = success(
      await resources.service.open(resources.descriptor.uri, {
        maxBytes: 10_000,
        expected: "text",
      }),
    );
    const textError = failure(await consumeVerifiedResourceRead(textRead));
    expect(textError._tag).toBe("ResourceUnsupportedClassification");

    const directory = await mkdtemp(join(tmpdir(), "lilac-resource-"));
    const materialized = success(
      await resources.service.materialize(resources.descriptor.uri, {
        targetDirectory: directory,
        maxBytes: 10_000,
      }),
    );
    expect(new Uint8Array(await readFile(materialized.path))).toEqual(bytes);
    await rm(directory, { recursive: true, force: true });
    await closeFixture(resources.service, resources.blobStore);
  });

  test("uses exclusive materialization without overwriting", async () => {
    const resources = await fixture({
      bytes: new TextEncoder().encode("new"),
      filename: "note.txt",
      declaredMediaType: "text/plain",
      limits: { modelInlineMaxBytes: 1 },
    });
    const directory = await mkdtemp(join(tmpdir(), "lilac-resource-"));
    const destination = join(directory, "note.txt");
    await writeFile(destination, "existing");

    const error = failure(
      await resources.service.materialize(resources.descriptor.uri, {
        targetDirectory: directory,
        maxBytes: 10,
      }),
    );
    expect(error._tag).toBe("ResourceAlreadyExists");
    expect(await readFile(destination, "utf8")).toBe("existing");

    await rm(directory, { recursive: true, force: true });
    await closeFixture(resources.service, resources.blobStore);
  });
});
