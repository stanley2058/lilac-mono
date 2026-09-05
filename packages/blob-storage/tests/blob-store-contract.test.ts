import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import type { Result } from "better-result";

import {
  BlobIntegrityFailure,
  BlobInvalidRetention,
  BlobObjectAbsent,
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
import { S3BlobBackend } from "../src/s3-backend";
import { SupervisedBlobStore } from "../src/store";
import { ControlledS3Client } from "./controlled-s3-client";

function success<T, E>(result: Result<T, E>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

function failure<T, E>(result: Result<T, E>): E {
  return result.match({
    ok: () => {
      throw new Error("Expected an error Result");
    },
    err: (error) => error,
  });
}

function controlledStream(): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly enqueue: (value: Uint8Array) => void;
  readonly close: () => void;
} {
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController = controller;
      },
    }),
    enqueue: (value) => sourceController?.enqueue(value),
    close: () => sourceController?.close(),
  };
}

type ContractAdapter = {
  readonly name: string;
  readonly create: () => Promise<BlobStore>;
};

const adapters: readonly ContractAdapter[] = [
  {
    name: "memory",
    create: async () => success(await createMemoryBlobStore()),
  },
  {
    name: "local",
    create: async () => {
      const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-contract-"));
      return success(await createLocalBlobStore({ root: path.join(parent, "store") }));
    },
  },
  {
    name: "controlled S3",
    create: async () => {
      const client = new ControlledS3Client();
      const backend = new S3BlobBackend({
        bucket: "contract-bucket",
        prefix: "contract",
        accessKeyId: "contract-key",
        secretAccessKey: "contract-secret",
        forcePathStyle: true,
        client: client as unknown as Bun.S3Client,
        fetch: client.fetch,
      });
      success(await backend.initialize({ createIfMissing: true }));
      return new SupervisedBlobStore(backend);
    },
  },
];

for (const adapter of adapters) {
  describe(`BlobStore contract: ${adapter.name}`, () => {
    test("staged bytes stay unreadable until durable adoption, then survive staging expiry", async () => {
      const store = await adapter.create();
      const bytes = new TextEncoder().encode("recoverable publication");
      const stagingExpiresAt = Date.now() + 60_000;
      const started = success(await store.startStagedUpload({ source: bytes, stagingExpiresAt }));
      const ref = success(await started.completion);
      expect(ref.expiresAt).toBeUndefined();
      expect(failure(await store.resolve(started.handle, { timeoutMs: 0 }))).toBeInstanceOf(
        BlobResolveTimeout,
      );
      expect(failure(await store.open(ref))).toBeInstanceOf(BlobObjectAbsent);
      expect(success(await store.adopt(started.handle))).toEqual(ref);
      expect(success(await store.adopt(started.handle))).toEqual(ref);
      expect(success(await store.maintain({ now: stagingExpiresAt, limit: 10 })).deleted).toBe(0);
      expect(success(await store.maintain({ now: stagingExpiresAt, limit: 10 })).inspected).toBe(0);
      expect(success(await materializeBlobRead(success(await store.open(ref))))).toEqual(bytes);
      expect(success(await store.delete(ref))).toBe("deleted");
      expect(failure(await store.adopt(started.handle))).toBeInstanceOf(BlobObjectAbsent);
    });

    test("unadopted staged bytes expire and cannot be adopted after cleanup", async () => {
      const store = await adapter.create();
      const stagingExpiresAt = Date.now() + 60_000;
      const started = success(
        await store.startStagedUpload({ source: new Uint8Array([1, 2]), stagingExpiresAt }),
      );
      const ref = success(await started.completion);
      expect(success(await store.maintain({ now: stagingExpiresAt, limit: 10 })).deleted).toBe(1);
      expect(failure(await store.adopt(started.handle))).toBeInstanceOf(BlobObjectAbsent);
      expect(failure(await store.open(ref))).toBeInstanceOf(BlobObjectAbsent);
      expect(success(await store.maintain({ now: stagingExpiresAt, limit: 10 })).inspected).toBe(0);
    });

    test("staged validation, pending adoption, and explicit deletion preserve lifecycle errors", async () => {
      const store = await adapter.create();
      const source = controlledStream();
      expect(
        failure(await store.startStagedUpload({ source: new Uint8Array(), stagingExpiresAt: -1 }))
          ._tag,
      ).toBe("BlobInvalidInput");
      const started = success(
        await store.startStagedUpload({
          source: source.stream,
          stagingExpiresAt: Date.now() + 60_000,
        }),
      );
      expect(failure(await store.adopt(started.handle))).toBeInstanceOf(BlobResolveTimeout);
      source.enqueue(new Uint8Array([1]));
      source.close();
      const ref = success(await started.completion);
      expect(success(await store.delete(ref))).toBe("deleted");
      expect(failure(await store.adopt(started.handle))).toBeInstanceOf(BlobObjectAbsent);
    });

    test("reserves asynchronously, resolves, and verifies readable bytes", async () => {
      const store = await adapter.create();
      const source = controlledStream();
      const started = success(
        await store.startUpload({
          source: source.stream,
          retention: { kind: "durable" },
        }),
      );
      expect(failure(await store.resolve(started.handle, { timeoutMs: 0 }))).toBeInstanceOf(
        BlobResolveTimeout,
      );

      const bytes = new TextEncoder().encode("shared contract bytes");
      source.enqueue(bytes);
      source.close();
      const ref = success(await started.completion);
      expect(success(await store.resolve(started.handle, { timeoutMs: 100 }))).toEqual(ref);
      expect(success(await materializeBlobRead(success(await store.open(ref))))).toEqual(bytes);
    });

    test("deletes pending and ready objects idempotently", async () => {
      const store = await adapter.create();
      const pendingSource = controlledStream();
      const pending = success(
        await store.startUpload({
          source: pendingSource.stream,
          retention: { kind: "durable" },
        }),
      );
      expect(success(await store.delete(pending.handle))).toBe("deleted");
      expect(failure(await pending.completion)).toBeInstanceOf(BlobUploadFailed);
      expect(success(await store.delete(pending.handle))).toBe("absent");

      const ready = success(
        await store.startUpload({
          source: new Uint8Array([1, 2]),
          retention: { kind: "durable" },
        }),
      );
      const ref = success(await ready.completion);
      expect(success(await store.delete(ref))).toBe("deleted");
      expect(failure(await store.open(ref))).toBeInstanceOf(BlobObjectAbsent);
    });

    test("closes idempotently, fences pending work, and rejects new uploads", async () => {
      const store = await adapter.create();
      const source = controlledStream();
      const started = success(
        await store.startUpload({
          source: source.stream,
          retention: { kind: "durable" },
        }),
      );
      const first = store.close({ deadlineAtMs: Date.now() + 1_000 });
      const second = store.close({ deadlineAtMs: Date.now() + 2_000 });
      expect(second).toBe(first);
      expect(success(await first).interruptedUploads).toBe(1);
      expect(failure(await started.completion)).toBeInstanceOf(BlobUploadInterrupted);
      expect(
        failure(
          await store.startUpload({
            source: new Uint8Array(),
            retention: { kind: "durable" },
          }),
        ),
      ).toBeInstanceOf(BlobStoreClosed);
    });

    test("publishes terminal expected-integrity failures", async () => {
      const store = await adapter.create();
      const bytes = new Uint8Array([1, 2, 3]);
      const started = success(
        await store.startUpload({
          source: bytes,
          retention: { kind: "durable" },
          expectedSha256: createHash("sha256")
            .update(new Uint8Array([9]))
            .digest("hex"),
        }),
      );
      expect(failure(await started.completion)).toMatchObject({
        _tag: "BlobUploadFailed",
        reason: "expected_sha256",
      });
      expect(failure(await store.resolve(started.handle, { timeoutMs: 0 }))).toMatchObject({
        _tag: "BlobUploadFailed",
        reason: "expected_sha256",
      });
    });

    test("keeps equal payload ownership independent and reclaims expiry", async () => {
      const store = await adapter.create();
      const bytes = new TextEncoder().encode("equal payload");
      const upload = async (expiresAt?: number): Promise<BlobRefV1> => {
        const started = success(
          await store.startUpload({
            source: bytes,
            retention:
              expiresAt === undefined ? { kind: "durable" } : { kind: "expires", expiresAt },
          }),
        );
        return success(await started.completion);
      };
      const first = await upload();
      const second = await upload();
      expect(first.objectId).not.toBe(second.objectId);
      expect(first.sha256).toBe(second.sha256);
      expect(success(await store.delete(first))).toBe("deleted");
      expect(success(await materializeBlobRead(success(await store.open(second))))).toEqual(bytes);

      const expiresAt = Date.now() + 60_000;
      await upload(expiresAt);
      expect(success(await store.maintain({ now: expiresAt, limit: 1 })).deleted).toBe(1);
    });

    test("reports source, retention, and terminal integrity failures", async () => {
      const store = await adapter.create();
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("controlled source failure"));
        },
      });
      const failed = success(
        await store.startUpload({
          source,
          retention: { kind: "durable" },
        }),
      );
      expect(failure(await failed.completion)).toMatchObject({
        _tag: "BlobUploadFailed",
        reason: "source",
      });
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

      const bytes = new Uint8Array([7]);
      const uploaded = success(
        await store.startUpload({
          source: bytes,
          retention: { kind: "durable" },
        }),
      );
      const ref = success(await uploaded.completion);
      const corruptRef = { ...ref, byteLength: ref.byteLength + 1 };
      expect(failure(await store.open(corruptRef))).toBeInstanceOf(BlobIntegrityFailure);
    });
  });
}
