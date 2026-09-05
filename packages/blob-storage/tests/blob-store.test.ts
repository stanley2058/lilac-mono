import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  BlobAdapterFailure,
  BlobCloseFailed,
  BlobCloseDeadlineExceeded,
  BlobDeleteFailed,
  BlobIntegrityFailure,
  BlobInvalidRetention,
  BlobMaintenanceFailed,
  BlobObjectExpired,
  BlobObjectAbsent,
  BlobOperationAndCleanupFailed,
  BlobReadCancelled,
  BlobReadSourceFailure,
  BlobResolveTimeout,
  BlobStoreClosed,
  BlobUploadFailed,
  BlobUploadInterrupted,
  createLocalBlobStore,
  createMemoryBlobStore,
  materializeBlobRead,
  type BlobRefV1,
  type BlobStore,
} from "../src";
import type { BlobSink } from "../src/backend";
import { MemoryBlobBackend } from "../src/memory-backend";
import { SupervisedBlobStore, createVerifiedRead } from "../src/store";

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

function adapterFailure(operation: string): BlobAdapterFailure {
  return new BlobAdapterFailure({
    adapter: "memory",
    kind: "io",
    operation,
    message: `controlled ${operation} failure`,
  });
}

class ControlledMemoryBackend extends MemoryBlobBackend {
  reservationReads = 0;
  failReads = false;
  failDeletes = 0;
  failSinkWrite = false;
  failSinkFinish = false;
  failSinkAbort = false;
  failReservationState?: string;
  failReservationWrites = 0;
  #blockedState?: string;
  #writeStarted = Promise.withResolvers<void>();
  #writeRelease = Promise.withResolvers<void>();

  blockReservationState(state: string): Promise<void> {
    this.#blockedState = state;
    this.#writeStarted = Promise.withResolvers<void>();
    this.#writeRelease = Promise.withResolvers<void>();
    return this.#writeStarted.promise;
  }

  releaseReservationWrite(): void {
    this.#writeRelease.resolve();
  }

  override async readReservation(objectId: string) {
    this.reservationReads += 1;
    if (this.failReads) return Result.err(adapterFailure("read reservation"));
    return super.readReservation(objectId);
  }

  override async compareAndSwapReservation(
    objectId: string,
    expectedSerialized: string,
    serialized: string,
  ) {
    if (
      this.failReservationState !== undefined &&
      serialized.includes(`"state":"${this.failReservationState}"`) &&
      this.failReservationWrites > 0
    ) {
      this.failReservationWrites -= 1;
      if (this.failReservationWrites === 0) this.failReservationState = undefined;
      return Result.err(adapterFailure("compare reservation"));
    }
    if (
      this.#blockedState !== undefined &&
      serialized.includes(`"state":"${this.#blockedState}"`)
    ) {
      this.#writeStarted.resolve();
      await this.#writeRelease.promise;
      this.#blockedState = undefined;
    }
    return super.compareAndSwapReservation(objectId, expectedSerialized, serialized);
  }

  override async deleteKeys(keys: readonly string[]) {
    if (this.failDeletes > 0) {
      this.failDeletes -= 1;
      return Result.err(adapterFailure("delete keys"));
    }
    return super.deleteKeys(keys);
  }

  override async openSink(objectId: string, generation: string) {
    const opened = await super.openSink(objectId, generation);
    return opened.map(
      (sink): BlobSink => ({
        write: async (chunk) =>
          this.failSinkWrite ? Result.err(adapterFailure("sink write")) : sink.write(chunk),
        finish: async () =>
          this.failSinkFinish ? Result.err(adapterFailure("sink finish")) : sink.finish(),
        abort: async () =>
          this.failSinkAbort ? Result.err(adapterFailure("sink abort")) : sink.abort(),
      }),
    );
  }
}

function controlledStream(): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly enqueue: (value: Uint8Array) => void;
  readonly close: () => void;
} {
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
  });
  return {
    stream,
    enqueue: (value) => sourceController?.enqueue(value),
    close: () => sourceController?.close(),
  };
}

async function memoryStore(): Promise<BlobStore> {
  return success(await createMemoryBlobStore());
}

async function upload(store: BlobStore, bytes: Uint8Array, expiresAt?: number): Promise<BlobRefV1> {
  const started = success(
    await store.startUpload({
      source: bytes,
      retention: expiresAt === undefined ? { kind: "durable" } : { kind: "expires", expiresAt },
    }),
  );
  return success(await started.completion);
}

describe("blob storage contract", () => {
  test("logs successful and failed upload lifecycles", async () => {
    const debug: Array<{ message: string; context: Record<string, unknown> }> = [];
    const errors: Array<{ message: string; context: Record<string, unknown> }> = [];
    const store = success(
      await createMemoryBlobStore({
        logger: {
          debug: (message, context) => debug.push({ message, context }),
          error: (message, context) => errors.push({ message, context }),
        },
      }),
    );
    const completed = success(
      await store.startUpload({
        source: new Uint8Array([1, 2, 3]),
        retention: { kind: "durable" },
      }),
    );
    success(await completed.completion);
    const failed = success(
      await store.startUpload({
        source: new Uint8Array([1, 2, 3]),
        retention: { kind: "durable" },
        expectedByteLength: 4,
      }),
    );
    expect(failure(await failed.completion)).toBeInstanceOf(BlobUploadFailed);

    expect(debug.map((entry) => entry.message)).toEqual([
      "blob upload reservation started",
      "blob upload started",
      "blob upload sink opened",
      "blob upload source consumed",
      "blob upload content committed",
      "blob upload reference published",
      "blob upload completed",
      "blob upload reservation started",
      "blob upload started",
      "blob upload sink opened",
      "blob upload source consumed",
    ]);
    expect(errors.map((entry) => entry.message)).toEqual([
      "blob upload length verification failed",
      "blob upload failed",
    ]);
    expect(errors[1]).toMatchObject({
      message: "blob upload failed",
      context: {
        adapter: "memory",
        errorClass: "BlobUploadFailed",
        failureReason: "expected_byte_length",
        expectedByteLength: 4,
        observedByteLength: 3,
      },
    });
  });

  test("returns a reservation while a streaming source remains pending", async () => {
    const store = await memoryStore();
    const controlled = controlledStream();
    const started = success(
      await store.startUpload({
        source: controlled.stream,
        retention: { kind: "durable" },
      }),
    );

    expect(started.handle.objectId).toMatch(/^b1_[0-9a-f]{32}$/);
    expect(failure(await store.resolve(started.handle, { timeoutMs: 0 }))).toBeInstanceOf(
      BlobResolveTimeout,
    );

    controlled.enqueue(new TextEncoder().encode("streamed"));
    controlled.close();
    const ref = success(await started.completion);
    expect(ref.byteLength).toBe(8);
    expect(success(await store.resolve(started.handle, { timeoutMs: 100 }))).toEqual(ref);
  });

  test("a second local store resolves a pending reservation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-blob-cross-process-"));
    const root = path.join(directory, "store");
    const producer = success(await createLocalBlobStore({ root }));
    const consumer = success(await createLocalBlobStore({ root }));
    const controlled = controlledStream();
    const started = success(
      await producer.startUpload({
        source: controlled.stream,
        retention: { kind: "durable" },
      }),
    );
    const resolving = consumer.resolve(started.handle, { timeoutMs: 1_000 });

    controlled.enqueue(new Uint8Array([1, 2, 3]));
    controlled.close();
    const localRef = success(await started.completion);
    expect(success(await resolving)).toEqual(localRef);
  });

  test("the producing store resolves its active upload without polling the backend", async () => {
    const backend = new ControlledMemoryBackend();
    const store = new SupervisedBlobStore(backend);
    const controlled = controlledStream();
    const started = success(
      await store.startUpload({
        source: controlled.stream,
        retention: { kind: "durable" },
      }),
    );
    backend.reservationReads = 0;
    const resolving = store.resolve(started.handle, { timeoutMs: 1_000 });
    await Promise.resolve();
    expect(backend.reservationReads).toBe(0);

    controlled.enqueue(new Uint8Array([1, 2, 3]));
    controlled.close();
    const ref = success(await started.completion);
    expect(success(await resolving)).toEqual(ref);
  });

  test("delete fences a pending upload and is idempotent", async () => {
    const store = await memoryStore();
    const controlled = controlledStream();
    const started = success(
      await store.startUpload({
        source: controlled.stream,
        retention: { kind: "durable" },
      }),
    );

    expect(success(await store.delete(started.handle))).toBe("deleted");
    expect(failure(await started.completion)).toBeInstanceOf(BlobUploadFailed);
    expect(success(await store.delete(started.handle))).toBe("absent");
  });

  test("close fences blocked uploads and is idempotent", async () => {
    const store = await memoryStore();
    const controlled = controlledStream();
    const started = success(
      await store.startUpload({
        source: controlled.stream,
        retention: { kind: "durable" },
      }),
    );
    const firstClose = store.close({ deadlineAtMs: Date.now() + 1_000 });
    const secondClose = store.close({ deadlineAtMs: Date.now() + 2_000 });

    expect(secondClose).toBe(firstClose);
    expect(success(await firstClose).interruptedUploads).toBe(1);
    expect(failure(await started.completion)).toBeInstanceOf(BlobUploadInterrupted);
    expect(failure(await store.resolve(started.handle, { timeoutMs: 0 }))).toBeInstanceOf(
      BlobUploadInterrupted,
    );
    expect(
      failure(
        await store.startUpload({
          source: new Uint8Array(),
          retention: { kind: "durable" },
        }),
      ),
    ).toBeInstanceOf(BlobStoreClosed);
  });

  test("close returns a deadline error when a mandatory fence cannot settle", async () => {
    let releaseFence: (() => void) | undefined;
    const fenceGate = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    class SlowFenceBackend extends MemoryBlobBackend {
      override async compareAndSwapReservation(
        objectId: string,
        expectedSerialized: string,
        serialized: string,
      ) {
        if (serialized.includes('"state":"interrupted"')) await fenceGate;
        return super.compareAndSwapReservation(objectId, expectedSerialized, serialized);
      }
    }
    const store = new SupervisedBlobStore(new SlowFenceBackend());
    const controlled = controlledStream();
    const started = success(
      await store.startUpload({
        source: controlled.stream,
        retention: { kind: "durable" },
      }),
    );
    const closed = await store.close({ deadlineAtMs: Date.now() + 10 });
    expect(failure(closed)).toBeInstanceOf(BlobCloseDeadlineExceeded);
    releaseFence?.();
    await started.completion;
  });

  test("verified materialization reports success, integrity mismatch, source failure, and cancel", async () => {
    const bytes = new TextEncoder().encode("verified");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ref: BlobRefV1 = {
      version: 1,
      objectId: "b1_00000000000000000000000000000000",
      sha256,
      byteLength: bytes.byteLength,
    };
    const good = createVerifiedRead(
      ref,
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
    expect(success(await materializeBlobRead(good))).toEqual(bytes);

    const corrupt = createVerifiedRead(
      { ...ref, byteLength: bytes.byteLength + 1 },
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
    expect(failure(await materializeBlobRead(corrupt))).toBeInstanceOf(BlobIntegrityFailure);

    const failed = createVerifiedRead(
      ref,
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("controlled source failure"));
        },
      }),
    );
    expect(failure(await materializeBlobRead(failed))).toBeInstanceOf(BlobReadSourceFailure);

    const blocked = controlledStream();
    const cancelled = createVerifiedRead(ref, blocked.stream);
    await cancelled.stream.cancel();
    expect(failure(await cancelled.completion)).toBeInstanceOf(BlobReadCancelled);
  });

  test("verified read rejects stream and completion with the same Panic for a non-byte chunk", async () => {
    const ref: BlobRefV1 = {
      version: 1,
      objectId: "b1_00000000000000000000000000000000",
      sha256: "0".repeat(64),
      byteLength: 0,
    };
    const maliciousSource = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue({} as Uint8Array);
        controller.close();
      },
    });
    const read = createVerifiedRead(ref, maliciousSource);
    const completionFailure = read.completion.then(
      () => null,
      (panic: unknown) => panic,
    );
    const streamFailure = read.stream
      .getReader()
      .read()
      .then(
        () => null,
        (panic: unknown) => panic,
      );
    const [observedStreamPanic, observedCompletionPanic] = await Promise.all([
      streamFailure,
      completionFailure,
    ]);

    expect(Panic.is(observedStreamPanic)).toBeTrue();
    expect(observedCompletionPanic).toBe(observedStreamPanic);
  });

  test("expiry, bounded maintenance, and independent equal payload ownership", async () => {
    const store = await memoryStore();
    const bytes = new TextEncoder().encode("same");
    const first = await upload(store, bytes);
    const second = await upload(store, bytes);
    expect(first.objectId).not.toBe(second.objectId);
    expect(first.sha256).toBe(second.sha256);
    expect(success(await store.delete(first))).toBe("deleted");
    expect(success(await materializeBlobRead(success(await store.open(second))))).toEqual(bytes);

    const expiresAt = Date.now() + 60_000;
    const expiring = await upload(store, bytes, expiresAt);
    const summary = success(await store.maintain({ now: expiresAt, limit: 100 }));
    expect(summary.deleted).toBe(1);
    expect(failure(await store.open(expiring))).not.toBeInstanceOf(BlobObjectExpired);

    const expiredRef: BlobRefV1 = {
      ...second,
      objectId: "b1_11111111111111111111111111111111",
      expiresAt: Date.now() - 1,
    };
    expect(failure(await store.open(expiredRef))).toBeInstanceOf(BlobObjectExpired);
  });

  test("maintenance continues past a failed expired object and retries it later", async () => {
    const backend = new ControlledMemoryBackend();
    success(await backend.initialize());
    const store = new SupervisedBlobStore(backend);
    const now = Date.now() + 60_000;
    const first = await upload(store, new Uint8Array([1]), now - 1);
    const second = await upload(store, new Uint8Array([2]), now);

    backend.failDeletes = 1;
    expect(failure(await store.maintain({ now, limit: 2 }))).toBeInstanceOf(BlobMaintenanceFailed);
    expect(success(await backend.readReservation(second.objectId))).toBeNull();
    expect(success(await store.delete(second))).toBe("absent");

    expect(success(await store.maintain({ now, limit: 2 }))).toEqual({
      inspected: 1,
      deleted: 1,
      remaining: false,
    });
    expect(success(await backend.readReservation(first.objectId))).toBeNull();
  });

  test("expected digest and length mismatches publish terminal failure", async () => {
    const store = await memoryStore();
    const bytes = new Uint8Array([1, 2, 3]);
    const digestStarted = success(
      await store.startUpload({
        source: bytes,
        retention: { kind: "durable" },
        expectedSha256: "0".repeat(64),
      }),
    );
    expect(failure(await digestStarted.completion)).toBeInstanceOf(BlobUploadFailed);
    expect(failure(await store.resolve(digestStarted.handle, { timeoutMs: 0 }))).toBeInstanceOf(
      BlobUploadFailed,
    );

    const lengthStarted = success(
      await store.startUpload({
        source: bytes,
        retention: { kind: "durable" },
        expectedByteLength: 4,
      }),
    );
    expect(failure(await lengthStarted.completion)).toBeInstanceOf(BlobUploadFailed);
  });

  test("an unexpected source Panic rejects completion with the exact defect", async () => {
    const backend = new MemoryBlobBackend();
    success(await backend.initialize());
    const store = new SupervisedBlobStore(backend);
    const observer = new SupervisedBlobStore(backend);
    const panic = new Panic({ message: "controlled upload defect" });
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw panic;
      },
    });
    const started = success(await store.startUpload({ source, retention: { kind: "durable" } }));
    await expect(started.completion).rejects.toBe(panic);
    expect(failure(await observer.resolve(started.handle, { timeoutMs: 0 }))).toBeInstanceOf(
      BlobUploadInterrupted,
    );
    expect(
      success(await store.close({ deadlineAtMs: Date.now() + 1_000 })).interruptedUploads,
    ).toBe(0);
  });

  test("a panicking upload stays supervised until shutdown retries its durable fence", async () => {
    const backend = new ControlledMemoryBackend();
    success(await backend.initialize());
    backend.failReservationState = "interrupted";
    backend.failReservationWrites = 3;
    const store = new SupervisedBlobStore(backend);
    const observer = new SupervisedBlobStore(backend);
    const panic = new Panic({ message: "controlled unfenced upload defect" });
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw panic;
      },
    });
    const started = success(await store.startUpload({ source, retention: { kind: "durable" } }));
    await expect(started.completion).rejects.toBe(panic);

    expect(
      success(await store.close({ deadlineAtMs: Date.now() + 1_000 })).interruptedUploads,
    ).toBe(1);
    expect(failure(await observer.resolve(started.handle, { timeoutMs: 0 }))).toBeInstanceOf(
      BlobUploadInterrupted,
    );
  });

  test("close re-fences a ready publication that settles after its first fence", async () => {
    const backend = new ControlledMemoryBackend();
    success(await backend.initialize());
    const store = new SupervisedBlobStore(backend);
    const readyWriteStarted = backend.blockReservationState("ready");
    const started = success(
      await store.startUpload({
        source: new Uint8Array([1, 2, 3]),
        retention: { kind: "durable" },
      }),
    );
    await readyWriteStarted;

    const closed = store.close({ deadlineAtMs: Date.now() + 1_000 });
    backend.releaseReservationWrite();
    expect(success(await closed).interruptedUploads).toBe(1);
    expect(failure(await started.completion)).toBeInstanceOf(BlobUploadInterrupted);
    expect(failure(await store.resolve(started.handle, { timeoutMs: 0 }))).toBeInstanceOf(
      BlobUploadInterrupted,
    );
  });

  test("close fences an upload whose delete fence is still blocked", async () => {
    const backend = new ControlledMemoryBackend();
    success(await backend.initialize());
    const store = new SupervisedBlobStore(backend);
    const source = controlledStream();
    const started = success(
      await store.startUpload({
        source: source.stream,
        retention: { kind: "durable" },
      }),
    );
    const deleteWriteStarted = backend.blockReservationState("deleted");
    const deleting = store.delete(started.handle);
    await deleteWriteStarted;

    expect(
      success(await store.close({ deadlineAtMs: Date.now() + 1_000 })).interruptedUploads,
    ).toBe(1);
    backend.releaseReservationWrite();
    expect(success(await deleting)).toBe("deleted");
  });

  test("close fails and settles completion when reservation inspection fails", async () => {
    const backend = new ControlledMemoryBackend();
    success(await backend.initialize());
    const store = new SupervisedBlobStore(backend);
    const source = controlledStream();
    const started = success(
      await store.startUpload({
        source: source.stream,
        retention: { kind: "durable" },
      }),
    );
    backend.failReads = true;

    expect(failure(await store.close({ deadlineAtMs: Date.now() + 1_000 }))).toBeInstanceOf(
      BlobCloseFailed,
    );
    expect(failure(await started.completion)).toBeInstanceOf(BlobUploadInterrupted);
  });

  test("delete retries physical cleanup behind a durable deleted fence", async () => {
    const backend = new ControlledMemoryBackend();
    success(await backend.initialize());
    const store = new SupervisedBlobStore(backend);
    const ref = await upload(store, new Uint8Array([4, 5, 6]));
    backend.failDeletes = 1;

    expect(failure(await store.delete(ref))).toBeInstanceOf(BlobDeleteFailed);
    expect(success(await store.delete(ref))).toBe("deleted");
    expect(success(await store.delete(ref))).toBe("absent");
  });

  test("sink write failure is durable and finish plus cleanup failure is combined", async () => {
    const writeBackend = new ControlledMemoryBackend();
    success(await writeBackend.initialize());
    writeBackend.failSinkWrite = true;
    const writeStore = new SupervisedBlobStore(writeBackend);
    const writeStarted = success(
      await writeStore.startUpload({
        source: new Uint8Array([1]),
        retention: { kind: "durable" },
      }),
    );
    const writeFailure = failure(await writeStarted.completion);
    expect(writeFailure).toBeInstanceOf(BlobUploadFailed);
    if (writeFailure instanceof BlobUploadFailed) expect(writeFailure.reason).toBe("write");
    expect(failure(await writeStore.resolve(writeStarted.handle, { timeoutMs: 0 }))).toMatchObject({
      _tag: "BlobUploadFailed",
      reason: "write",
    });

    const finishBackend = new ControlledMemoryBackend();
    success(await finishBackend.initialize());
    finishBackend.failSinkFinish = true;
    finishBackend.failSinkAbort = true;
    const finishStore = new SupervisedBlobStore(finishBackend);
    const finishStarted = success(
      await finishStore.startUpload({
        source: new Uint8Array([2]),
        retention: { kind: "durable" },
      }),
    );
    expect(failure(await finishStarted.completion)).toBeInstanceOf(BlobOperationAndCleanupFailed);
    expect(
      failure(await finishStore.resolve(finishStarted.handle, { timeoutMs: 0 })),
    ).toMatchObject({ _tag: "BlobUploadFailed", reason: "write" });
  });

  test("verified read propagates an underlying Panic without hanging completion", async () => {
    const panic = new Panic({ message: "controlled read defect" });
    const ref: BlobRefV1 = {
      version: 1,
      objectId: `b1_${"a".repeat(32)}`,
      sha256: createHash("sha256").update(new Uint8Array()).digest("hex"),
      byteLength: 0,
    };
    const read = createVerifiedRead(
      ref,
      new ReadableStream<Uint8Array>({
        pull() {
          throw panic;
        },
      }),
    );

    await expect(materializeBlobRead(read)).rejects.toBe(panic);
    await expect(read.completion).rejects.toBe(panic);
  });

  test("retention rejects timestamps outside the JavaScript Date range", async () => {
    const store = await memoryStore();
    expect(
      failure(
        await store.startUpload({
          source: new Uint8Array(),
          retention: {
            kind: "expires",
            expiresAt: 8_640_000_000_000_001,
          },
        }),
      ),
    ).toBeInstanceOf(BlobInvalidRetention);
  });

  test("local committed files use private permissions and corruption fails terminal verification", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-blob-local-"));
    const root = path.join(directory, "store");
    const store = success(await createLocalBlobStore({ root }));
    const bytes = new TextEncoder().encode("content");
    const ref = await upload(store, bytes);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const contentPath = path.join(root, "content", "durable", ref.objectId);
    expect((await stat(contentPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(contentPath)).toEqual(Buffer.from(bytes));

    await writeFile(contentPath, "corrupt", { mode: 0o600 });
    const read = success(await store.open(ref));
    expect(failure(await materializeBlobRead(read))).toBeInstanceOf(BlobIntegrityFailure);
  });
});

describe("staged blob recovery", () => {
  test("a reopened local store adopts staged bytes and preserves their identity", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "lilac-staged-reopen-"));
    const root = path.join(parent, "store");
    const store = success(await createLocalBlobStore({ root }));
    const bytes = new TextEncoder().encode("staged before process restart");
    const started = success(
      await store.startStagedUpload({ source: bytes, stagingExpiresAt: Date.now() + 60_000 }),
    );
    const ref = success(await started.completion);
    success(await store.close({ deadlineAtMs: Date.now() + 1000 }));
    const reopened = success(await createLocalBlobStore({ root }));
    expect(success(await reopened.adopt(started.handle))).toEqual(ref);
    expect(success(await materializeBlobRead(success(await reopened.open(ref))))).toEqual(bytes);
  });

  test("expiry losing to adoption does not delete the adopted object", async () => {
    const backend = new ControlledMemoryBackend();
    const producer = new SupervisedBlobStore(backend);
    const maintainer = new SupervisedBlobStore(backend);
    const stagingExpiresAt = Date.now() + 60_000;
    const started = success(
      await producer.startStagedUpload({ source: new Uint8Array([1]), stagingExpiresAt }),
    );
    const ref = success(await started.completion);
    const blocked = backend.blockReservationState("deleted");
    const maintenance = maintainer.maintain({ now: stagingExpiresAt });
    await blocked;
    expect(success(await producer.adopt(started.handle))).toEqual(ref);
    backend.releaseReservationWrite();
    expect(success(await maintenance).deleted).toBe(0);
    expect(success(await materializeBlobRead(success(await producer.open(ref))))).toEqual(
      new Uint8Array([1]),
    );
  });

  test("adoption losing to completed expiry cleanup cannot resurrect an object", async () => {
    const backend = new ControlledMemoryBackend();
    const producer = new SupervisedBlobStore(backend);
    const maintainer = new SupervisedBlobStore(backend);
    const stagingExpiresAt = Date.now() + 60_000;
    const started = success(
      await producer.startStagedUpload({ source: new Uint8Array([1]), stagingExpiresAt }),
    );
    const ref = success(await started.completion);
    const blocked = backend.blockReservationState("ready");
    const adoption = producer.adopt(started.handle);
    await blocked;
    expect(success(await maintainer.maintain({ now: stagingExpiresAt })).deleted).toBe(1);
    backend.releaseReservationWrite();
    expect(failure(await adoption)).toBeInstanceOf(BlobObjectAbsent);
    expect(failure(await producer.open(ref))).toBeInstanceOf(BlobObjectAbsent);
  });

  test("failed staged deletion stays indexed for another maintenance cycle", async () => {
    const backend = new ControlledMemoryBackend();
    const store = new SupervisedBlobStore(backend);
    const stagingExpiresAt = Date.now() + 60_000;
    const started = success(
      await store.startStagedUpload({ source: new Uint8Array([1]), stagingExpiresAt }),
    );
    await started.completion;
    backend.failDeletes = 1;
    expect(failure(await store.maintain({ now: stagingExpiresAt }))).toBeInstanceOf(
      BlobMaintenanceFailed,
    );
    expect(failure(await store.adopt(started.handle))).toBeInstanceOf(BlobObjectAbsent);
    expect(success(await store.maintain({ now: stagingExpiresAt })).deleted).toBe(1);
    expect(success(await store.maintain({ now: stagingExpiresAt })).inspected).toBe(0);
  });
});
