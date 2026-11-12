import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import type { Result } from "better-result";

import { createLocalBlobStore, createS3BlobStore, materializeBlobRead } from "../src";
import { S3BlobBackend } from "../src/s3-backend";

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

const realS3Endpoint = Bun.env.LILAC_BLOB_S3_TEST_ENDPOINT;
const realS3Bucket = Bun.env.LILAC_BLOB_S3_TEST_BUCKET;
const realS3AccessKeyId = Bun.env.LILAC_BLOB_S3_TEST_ACCESS_KEY_ID;
const realS3SecretAccessKey = Bun.env.LILAC_BLOB_S3_TEST_SECRET_ACCESS_KEY;
const realS3SessionToken = Bun.env.LILAC_BLOB_S3_TEST_SESSION_TOKEN;
const realS3Test =
  realS3Endpoint !== undefined &&
  realS3Bucket !== undefined &&
  realS3AccessKeyId !== undefined &&
  realS3SecretAccessKey !== undefined
    ? test
    : test.skip;

async function copyLocalLayoutToS3(input: {
  readonly root: string;
  readonly client: Bun.S3Client;
  readonly prefix: string;
  readonly relative?: string;
}): Promise<void> {
  const relative = input.relative ?? "";
  const entries = await readdir(path.join(input.root, relative), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await copyLocalLayoutToS3({ ...input, relative: child });
    } else if (entry.isFile()) {
      await input.client.write(
        `${input.prefix}/${child.split(path.sep).join("/")}`,
        await readFile(path.join(input.root, child)),
        { acl: "private" },
      );
    }
  }
}

realS3Test("real S3-compatible lifecycle, privacy, and local-copy integration", async () => {
  if (
    realS3Endpoint === undefined ||
    realS3Bucket === undefined ||
    realS3AccessKeyId === undefined ||
    realS3SecretAccessKey === undefined
  ) {
    throw new Error("Real S3 integration variables are incomplete");
  }
  const prefix = `blob-storage-integration/${randomUUID()}`;
  const options = {
    bucket: realS3Bucket,
    prefix,
    endpoint: realS3Endpoint,
    region: "us-east-1",
    accessKeyId: realS3AccessKeyId,
    secretAccessKey: realS3SecretAccessKey,
    ...(realS3SessionToken === undefined ? {} : { sessionToken: realS3SessionToken }),
    forcePathStyle: true,
  } as const;
  const firstAdapter = new S3BlobBackend(options);
  const secondAdapter = new S3BlobBackend(options);
  success(await firstAdapter.initialize({ createIfMissing: true }));
  success(await secondAdapter.initialize({ createIfMissing: false }));
  const casObjectId = `b1_${randomUUID().replaceAll("-", "")}`;
  const pending = '{"state":"pending"}\n';
  const ready = '{"state":"ready"}\n';
  const interrupted = '{"state":"interrupted"}\n';
  success(await firstAdapter.createReservation(casObjectId, pending));
  const casOutcomes = await Promise.all([
    firstAdapter.compareAndSwapReservation(casObjectId, pending, ready),
    secondAdapter.compareAndSwapReservation(casObjectId, pending, interrupted),
  ]);
  expect(casOutcomes.map(success).filter(Boolean)).toHaveLength(1);

  const store = success(await createS3BlobStore(options));
  const bytes = new TextEncoder().encode("real compatible S3 bytes");
  const started = success(
    await store.startUpload({
      source: bytes,
      retention: { kind: "durable" },
    }),
  );
  const ref = success(await started.completion);
  expect(success(await store.resolve(started.handle, { timeoutMs: 0 }))).toEqual(ref);
  expect(success(await materializeBlobRead(success(await store.open(ref))))).toEqual(bytes);

  const anonymousUrl = `${realS3Endpoint.replace(/\/+$/u, "")}/${realS3Bucket}/${prefix}/content/durable/${ref.objectId}`;
  expect((await fetch(anonymousUrl)).status).not.toBe(200);

  const expiresAt = Date.now() + 60_000;
  const expiring = success(
    await store.startUpload({
      source: new Uint8Array([1]),
      retention: { kind: "expires", expiresAt },
    }),
  );
  const expiringRef = success(await expiring.completion);
  expect(success(await store.maintain({ now: expiresAt, limit: 10 })).deleted).toBe(1);
  expect(expiringRef.expiresAt).toBe(expiresAt);
  expect(success(await store.delete(ref))).toBe("deleted");
  expect(failure(await store.open(ref))._tag).toBe("BlobObjectAbsent");

  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-real-copy-"));
  const localRoot = path.join(parent, "local");
  const local = success(await createLocalBlobStore({ root: localRoot }));
  const localStarted = success(
    await local.startUpload({
      source: new TextEncoder().encode("real key copy"),
      retention: { kind: "durable" },
    }),
  );
  const localRef = success(await localStarted.completion);
  const copyPrefix = `blob-storage-integration-copy/${randomUUID()}`;
  const client = new Bun.S3Client({
    bucket: realS3Bucket,
    endpoint: realS3Endpoint,
    region: "us-east-1",
    accessKeyId: realS3AccessKeyId,
    secretAccessKey: realS3SecretAccessKey,
    ...(realS3SessionToken === undefined ? {} : { sessionToken: realS3SessionToken }),
    virtualHostedStyle: false,
  });
  await copyLocalLayoutToS3({
    root: localRoot,
    client,
    prefix: copyPrefix,
  });
  const copied = success(await createS3BlobStore({ ...options, prefix: copyPrefix }));
  expect(success(await materializeBlobRead(success(await copied.open(localRef))))).toEqual(
    new TextEncoder().encode("real key copy"),
  );
});
