import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import type { Result } from "better-result";

import {
  BlobAdapterFailure,
  BlobIntegrityFailure,
  createLocalBlobStore,
  createS3BlobStore,
  materializeBlobRead,
} from "../src";
import {
  reservationDecisionKey,
  reservationFenceKey,
  reservationKey,
  reservationTransitionKey,
} from "../src/backend";
import { S3BlobBackend } from "../src/s3-backend";
import { SupervisedBlobStore } from "../src/store";

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

class FakeS3Client {
  readonly values = new Map<string, Uint8Array>();
  readonly writes: Array<{ readonly key: string; readonly acl?: string }> = [];
  readonly fetches: Array<{ readonly key: string; readonly method: string }> = [];
  failExists?: Error;
  ambiguousContentWrite = false;
  ambiguousKeyIncludes?: string;
  failKeyIncludesBeforeWrite?: string;
  blockContentCopy?: Promise<void>;
  notifyContentCopy?: () => void;
  notifySinkWrite?: () => void;
  notifySinkAbort?: () => void;
  blockReservationState?: string;
  blockReservationWrite?: Promise<void>;

  async exists(key: string): Promise<boolean> {
    if (this.failExists !== undefined) throw this.failExists;
    return this.values.has(key);
  }

  presign(key: string): string {
    return `https://fake-s3.invalid/${encodeURIComponent(key)}`;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const key = decodeURIComponent(new URL(url).pathname.slice(1));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    this.fetches.push({ key, method });
    if (method === "GET") {
      const value = this.values.get(key);
      return value === undefined
        ? new Response(null, { status: 404 })
        : new Response(value.slice(), { status: 200 });
    }
    if (
      this.failKeyIncludesBeforeWrite !== undefined &&
      key.includes(this.failKeyIncludesBeforeWrite)
    ) {
      this.failKeyIncludesBeforeWrite = undefined;
      throw new Error("controlled conditional write failed before commit");
    }
    const copySource = new Headers(init?.headers).get("x-amz-copy-source");
    if (method === "PUT" && copySource !== null) {
      const sourcePath = decodeURIComponent(copySource).replace(/^\//u, "");
      const sourceKey = sourcePath.slice(sourcePath.indexOf("/") + 1);
      const source = this.values.get(sourceKey);
      if (source === undefined) return new Response(null, { status: 404 });
      this.notifyContentCopy?.();
      if (this.blockContentCopy !== undefined) await this.blockContentCopy;
      this.values.set(key, source.slice());
      if (this.ambiguousContentWrite) {
        this.ambiguousContentWrite = false;
        throw new Error("connection closed after copy response was lost");
      }
      return new Response("<CopyObjectResult />", { status: 200 });
    }
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    if (new Headers(init?.headers).get("if-none-match") === "*" && this.values.has(key)) {
      return new Response(null, { status: 412 });
    }
    if (
      this.blockReservationState !== undefined &&
      text.includes(`"state":"${this.blockReservationState}"`) &&
      this.blockReservationWrite !== undefined
    ) {
      await this.blockReservationWrite;
    }
    this.values.set(key, bytes);
    if (this.ambiguousKeyIncludes !== undefined && key.includes(this.ambiguousKeyIncludes)) {
      this.ambiguousKeyIncludes = undefined;
      throw new Error("connection closed after conditional PUT committed");
    }
    return new Response(null, { status: 200 });
  };

  file(key: string) {
    return {
      __fakeS3Key: key,
      text: async () => {
        return new TextDecoder().decode(this.values.get(key) ?? new Uint8Array());
      },
      arrayBuffer: async () => (this.values.get(key) ?? new Uint8Array()).slice().buffer,
      stream: () => {
        const value = this.values.get(key) ?? new Uint8Array();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(value.slice());
            controller.close();
          },
        });
      },
      writer: (options?: { readonly acl?: string }) => {
        this.writes.push({ key, acl: options?.acl });
        const chunks: Uint8Array[] = [];
        return {
          write: (chunk: Uint8Array) => {
            this.notifySinkWrite?.();
            chunks.push(chunk.slice());
            return chunk.byteLength;
          },
          flush: () => 0,
          end: async (error?: Error) => {
            if (error !== undefined) {
              this.notifySinkAbort?.();
              throw error;
            }
            const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            const bytes = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            this.values.set(key, bytes);
            return length;
          },
        };
      },
    };
  }

  async write(
    key: string,
    data: string | Uint8Array | { readonly __fakeS3Key: string },
    options?: { readonly acl?: string },
  ): Promise<number> {
    this.writes.push({ key, acl: options?.acl });
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data.slice()
          : (this.values.get(data.__fakeS3Key)?.slice() ?? new Uint8Array());
    if (
      this.failKeyIncludesBeforeWrite !== undefined &&
      key.includes(this.failKeyIncludesBeforeWrite)
    ) {
      this.failKeyIncludesBeforeWrite = undefined;
      throw new Error("controlled write failed before commit");
    }
    if (
      typeof data === "string" &&
      this.blockReservationState !== undefined &&
      data.includes(`"state":"${this.blockReservationState}"`) &&
      this.blockReservationWrite !== undefined
    ) {
      await this.blockReservationWrite;
    }
    if (key.includes("/content/") && !key.endsWith(".json")) {
      this.notifyContentCopy?.();
      if (this.blockContentCopy !== undefined) await this.blockContentCopy;
    }
    this.values.set(key, bytes);
    if (this.ambiguousKeyIncludes !== undefined && key.includes(this.ambiguousKeyIncludes)) {
      this.ambiguousKeyIncludes = undefined;
      throw new Error("connection closed after control-plane PUT committed");
    }
    if (this.ambiguousContentWrite && key.includes("/content/") && !key.endsWith(".json")) {
      this.ambiguousContentWrite = false;
      throw new Error("connection closed after PUT response was lost");
    }
    return bytes.byteLength;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async stat(key: string) {
    return {
      size: this.values.get(key)?.byteLength ?? 0,
      lastModified: new Date(),
      etag: "provider-etag-is-not-a-content-digest",
      type: "application/octet-stream",
    };
  }

  async list(input?: { readonly prefix?: string; readonly maxKeys?: number }) {
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(input?.prefix ?? ""))
      .sort();
    const limit = input?.maxKeys ?? 1_000;
    return {
      contents: keys.slice(0, limit).map((key) => ({
        key,
        size: this.values.get(key)?.byteLength,
        eTag: "not-sha256",
      })),
      isTruncated: keys.length > limit,
    };
  }
}

function backend(client: FakeS3Client): S3BlobBackend {
  return new S3BlobBackend({
    bucket: "private-test-bucket",
    prefix: "/tenant/blobs/",
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
    forcePathStyle: true,
    client: client as unknown as Bun.S3Client,
    fetch: client.fetch,
  });
}

async function copyLocalLayoutToFakeS3(
  root: string,
  client: FakeS3Client,
  relative = "",
): Promise<void> {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await copyLocalLayoutToFakeS3(root, client, child);
    } else if (entry.isFile()) {
      client.values.set(
        `tenant/blobs/${child.split(path.sep).join("/")}`,
        new Uint8Array(await readFile(path.join(root, child))),
      );
    }
  }
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

test("S3 backend uses private prefixed keys, paginates, and verifies bytes without ETag", async () => {
  const client = new FakeS3Client();
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  const bytes = new TextEncoder().encode("s3 bytes");
  const started = success(
    await store.startUpload({ source: bytes, retention: { kind: "durable" } }),
  );
  const ref = success(await started.completion);

  expect([...client.values.keys()].every((key) => key.startsWith("tenant/blobs/"))).toBe(true);
  expect(client.writes.every(({ acl }) => acl === "private")).toBe(true);
  expect(success(await materializeBlobRead(success(await store.open(ref))))).toEqual(bytes);

  for (let index = 0; index < 3; index += 1) {
    await adapter.createReservation(`b1_${index.toString(16).padStart(32, "0")}`, "{}\n", 1);
  }
  const page = success(await adapter.listExpiredReservationIds(1, 2));
  expect(page.ids).toHaveLength(2);
  expect(page.remaining).toBe(true);

  const contentKey = [...client.values.keys()].find(
    (key) => key.endsWith(ref.objectId) && !key.endsWith(".json"),
  );
  expect(contentKey).toBeDefined();
  if (contentKey !== undefined) client.values.set(contentKey, new TextEncoder().encode("tampered"));
  expect(failure(await materializeBlobRead(success(await store.open(ref))))).toBeInstanceOf(
    BlobIntegrityFailure,
  );
});

test("S3 provider authorization failures map to a closed adapter failure", async () => {
  const client = new FakeS3Client();
  client.failExists = new Error("AccessDenied 403");
  const failed = failure(await backend(client).initialize({ createIfMissing: true }));
  expect(failed).toBeInstanceOf(BlobAdapterFailure);
  expect(failed.kind).toBe("authorization");
  expect(failed.message).not.toContain("test-secret");
});

test("S3 conditional reservation publication has one cross-instance winner", async () => {
  const client = new FakeS3Client();
  const first = backend(client);
  const second = backend(client);
  success(await first.initialize({ createIfMissing: true }));
  success(await second.initialize({ createIfMissing: false }));
  const objectId = `b1_${"b".repeat(32)}`;
  const pending = '{"state":"pending"}\n';
  const ready = '{"state":"ready"}\n';
  const interrupted = '{"state":"interrupted"}\n';
  success(await first.createReservation(objectId, pending));

  const outcomes = await Promise.all([
    first.compareAndSwapReservation(objectId, pending, ready),
    second.compareAndSwapReservation(objectId, pending, interrupted),
  ]);
  expect(outcomes.map(success).filter(Boolean)).toHaveLength(1);
  const observed = success(await first.readReservation(objectId));
  expect(observed).not.toBeNull();
  expect([ready, interrupted].includes(observed ?? "")).toBe(true);
});

test("S3 constructor forwards endpoint, region, session token, prefix, and path style", () => {
  const client = new FakeS3Client();
  let received: Bun.S3Options | undefined;
  new S3BlobBackend({
    bucket: "configured-bucket",
    prefix: "configured/prefix",
    endpoint: "http://127.0.0.1:9000",
    region: "ap-northeast-1",
    accessKeyId: "key",
    secretAccessKey: "secret",
    sessionToken: "session",
    forcePathStyle: true,
    clientFactory: (options) => {
      received = options;
      return client as unknown as Bun.S3Client;
    },
  });
  expect(received).toMatchObject({
    bucket: "configured-bucket",
    endpoint: "http://127.0.0.1:9000",
    region: "ap-northeast-1",
    accessKeyId: "key",
    secretAccessKey: "secret",
    sessionToken: "session",
    virtualHostedStyle: false,
  });
});

test("S3 ambiguous content PUT is accepted only after exact content inspection", async () => {
  const client = new FakeS3Client();
  client.ambiguousContentWrite = true;
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  const bytes = new TextEncoder().encode("ambiguous but committed");
  const started = success(
    await store.startUpload({ source: bytes, retention: { kind: "durable" } }),
  );
  const ref = success(await started.completion);
  expect(success(await materializeBlobRead(success(await store.open(ref))))).toEqual(bytes);
});

test("S3 inspects ambiguous pending, ready, expiry-index, and delete fences", async () => {
  const client = new FakeS3Client();
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
  });
  client.ambiguousKeyIncludes = "/reservations/";
  const started = success(
    await store.startUpload({
      source,
      retention: { kind: "durable" },
    }),
  );
  client.ambiguousKeyIncludes = "/reservations/";
  sourceController?.enqueue(new Uint8Array([7]));
  sourceController?.close();
  const ref = success(await started.completion);
  expect(success(await store.resolve(started.handle, { timeoutMs: 0 }))).toEqual(ref);

  client.ambiguousKeyIncludes = "/reservations/";
  expect(success(await store.delete(ref))).toBe("deleted");
  expect(success(await store.delete(ref))).toBe("absent");

  client.ambiguousKeyIncludes = "/expiry/";
  const expiring = success(
    await store.startUpload({
      source: new Uint8Array([8]),
      retention: { kind: "expires", expiresAt: Date.now() + 60_000 },
    }),
  );
  success(await expiring.completion);
});

test("S3 compensates a failed expiry index without orphaning its pending reservation", async () => {
  const client = new FakeS3Client();
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  client.failKeyIncludesBeforeWrite = "/expiry/";

  expect(
    failure(
      await store.startUpload({
        source: new Uint8Array([9]),
        retention: { kind: "expires", expiresAt: Date.now() + 60_000 },
      }),
    )._tag,
  ).toBe("BlobUploadReservationFailed");
  expect([...client.values.keys()].some((key) => key.includes("/reservations/"))).toBe(false);
});

test("S3 maps authentication, throttling, and timeout failures", async () => {
  const cases = [
    [new Error("InvalidAccessKeyId credential rejected"), "authentication"],
    [new Error("SlowDown throttled 429"), "throttled"],
    [new Error("request timed out"), "timeout"],
  ] as const;
  for (const [providerError, expectedKind] of cases) {
    const client = new FakeS3Client();
    client.failExists = providerError;
    const mapped = failure(await backend(client).initialize({ createIfMissing: true }));
    expect(mapped.kind).toBe(expectedKind);
  }
});

test("S3 maps structured provider codes and statuses", async () => {
  const cases = [
    [
      Object.assign(new Error("provider rejected request"), {
        code: "InvalidAccessKeyId",
      }),
      "authentication",
    ],
    [
      Object.assign(new Error("provider rejected request"), {
        code: "AccessDenied",
      }),
      "authorization",
    ],
    [
      Object.assign(new Error("provider rejected request"), {
        statusCode: 429,
      }),
      "throttled",
    ],
  ] as const;
  for (const [providerError, expectedKind] of cases) {
    const client = new FakeS3Client();
    client.failExists = providerError;
    expect(failure(await backend(client).initialize({ createIfMissing: true })).kind).toBe(
      expectedKind,
    );
  }
});

test("S3 shutdown fence wins over a controlled late content copy", async () => {
  const client = new FakeS3Client();
  let releaseCopy: (() => void) | undefined;
  client.blockContentCopy = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  let announceCopy: (() => void) | undefined;
  const copyStarted = new Promise<void>((resolve) => {
    announceCopy = resolve;
  });
  client.notifyContentCopy = announceCopy;
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  const started = success(
    await store.startUpload({
      source: new TextEncoder().encode("late copy"),
      retention: { kind: "durable" },
    }),
  );
  await copyStarted;

  const closed = store.close({ deadlineAtMs: Date.now() + 1_000 });
  expect(success(await closed).interruptedUploads).toBe(1);
  releaseCopy?.();
  await expect(started.completion).resolves.toMatchObject({ status: "error" });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  const resolved = await store.resolve(started.handle, { timeoutMs: 0 });
  expect(failure(resolved)._tag).toBe("BlobUploadInterrupted");
});

test("S3 cross-process fence wins while content commit is in flight", async () => {
  const client = new FakeS3Client();
  let releaseCopy: (() => void) | undefined;
  client.blockContentCopy = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  let announceCopy: (() => void) | undefined;
  const copyStarted = new Promise<void>((resolve) => {
    announceCopy = resolve;
  });
  client.notifyContentCopy = announceCopy;
  const producerBackend = backend(client);
  const fencingBackend = backend(client);
  success(await producerBackend.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(producerBackend);
  const started = success(
    await store.startUpload({
      source: new TextEncoder().encode("cross-process fence"),
      retention: { kind: "durable" },
    }),
  );
  await copyStarted;

  const pending = success(await fencingBackend.readReservation(started.handle.objectId));
  expect(pending).not.toBeNull();
  const interrupted = `${JSON.stringify({ ...JSON.parse(pending ?? "{}"), state: "interrupted" })}\n`;
  expect(
    success(
      await fencingBackend.compareAndSwapReservation(
        started.handle.objectId,
        pending ?? "",
        interrupted,
      ),
    ),
  ).toBe(true);

  releaseCopy?.();
  expect(failure(await started.completion)._tag).toBe("BlobUploadFailed");
  expect(success(await fencingBackend.readReservation(started.handle.objectId))).toBe(interrupted);
  expect([...client.values.keys()].some((key) => key.includes("/content/"))).toBe(false);
});

test("S3 close starts multipart abort while its interruption fence is blocked", async () => {
  const client = new FakeS3Client();
  let announceWrite: (() => void) | undefined;
  const sinkWriteStarted = new Promise<void>((resolve) => {
    announceWrite = resolve;
  });
  client.notifySinkWrite = announceWrite;
  let announceAbort: (() => void) | undefined;
  const sinkAbortStarted = new Promise<void>((resolve) => {
    announceAbort = resolve;
  });
  client.notifySinkAbort = announceAbort;
  let releaseFence: (() => void) | undefined;
  client.blockReservationState = "interrupted";
  client.blockReservationWrite = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
    cancel() {
      return new Promise<void>(() => undefined);
    },
  });
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  const started = success(await store.startUpload({ source, retention: { kind: "durable" } }));
  sourceController?.enqueue(new Uint8Array([1]));
  await sinkWriteStarted;

  const closed = store.close({ deadlineAtMs: Date.now() + 1_000 });
  await sinkAbortStarted;
  releaseFence?.();
  expect(success(await closed).interruptedUploads).toBe(1);
  expect(failure(await started.completion)._tag).toBe("BlobUploadInterrupted");
});

test("S3 delete fence wins over a controlled late content copy", async () => {
  const client = new FakeS3Client();
  let releaseCopy: (() => void) | undefined;
  client.blockContentCopy = new Promise<void>((resolve) => {
    releaseCopy = resolve;
  });
  let announceCopy: (() => void) | undefined;
  const copyStarted = new Promise<void>((resolve) => {
    announceCopy = resolve;
  });
  client.notifyContentCopy = announceCopy;
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  const started = success(
    await store.startUpload({
      source: new TextEncoder().encode("late deleted copy"),
      retention: { kind: "durable" },
    }),
  );
  await copyStarted;

  const deleted = store.delete(started.handle);
  releaseCopy?.();
  expect(success(await deleted)).toBe("deleted");
  expect(failure(await started.completion)._tag).toBe("BlobUploadFailed");
  expect(failure(await store.resolve(started.handle, { timeoutMs: 0 }))._tag).toBe(
    "BlobObjectAbsent",
  );
  expect([...client.values.keys()].some((key) => key.includes("/content/"))).toBe(false);
});

test("S3 maintenance removes expiring objects across bounded pages", async () => {
  const client = new FakeS3Client();
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: true }));
  const store = new SupervisedBlobStore(adapter);
  const expiresAt = Date.now() + 60_000;
  for (let index = 0; index < 5; index += 1) {
    const started = success(
      await store.startUpload({
        source: new Uint8Array([index]),
        retention: { kind: "expires", expiresAt },
      }),
    );
    success(await started.completion);
  }
  let deleted = 0;
  for (let page = 0; page < 3; page += 1) {
    deleted += success(await store.maintain({ now: expiresAt, limit: 2 })).deleted;
  }
  expect(deleted).toBe(5);
  expect([...client.values.keys()].some((key) => key.includes("/content/expires/"))).toBe(false);
});

test("a key-for-key local to S3 copy preserves adapter-neutral references", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lilac-blob-copy-"));
  const root = path.join(parent, "local");
  const local = success(await createLocalBlobStore({ root }));
  const bytes = new TextEncoder().encode("copied between adapters");
  const started = success(
    await local.startUpload({
      source: bytes,
      retention: { kind: "durable" },
    }),
  );
  const ref = success(await started.completion);
  const client = new FakeS3Client();
  await copyLocalLayoutToFakeS3(root, client);
  const adapter = backend(client);
  success(await adapter.initialize({ createIfMissing: false }));
  const copied = new SupervisedBlobStore(adapter);

  expect(success(await materializeBlobRead(success(await copied.open(ref))))).toEqual(bytes);
});

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

test("S3 staged adoption and expiry use one conditional decision key", async () => {
  const client = new FakeS3Client();
  const first = backend(client);
  const second = backend(client);
  const objectId = `b1_${"d".repeat(32)}`;
  const pending = '{"state":"pending"}\n';
  const staged = '{"state":"staged"}\n';
  const ready = '{"state":"ready"}\n';
  const deleted = '{"state":"deleted"}\n';
  success(await first.initialize({ createIfMissing: true }));
  success(await first.createReservation(objectId, pending));
  expect(success(await first.compareAndSwapReservation(objectId, pending, staged))).toBe(true);

  const decisions = await Promise.all([
    first.compareAndSwapReservation(objectId, staged, ready),
    second.compareAndSwapReservation(objectId, staged, deleted),
  ]);
  expect(decisions.map(success).filter(Boolean)).toHaveLength(1);
  const expected = success(decisions[0]!) ? ready : deleted;
  expect(success(await first.readReservation(objectId))).toBe(expected);
  expect(success(await second.readReservation(objectId))).toBe(expected);
  expect(success(await second.compareAndSwapReservation(objectId, staged, ready))).toBe(false);
  expect(success(await first.compareAndSwapReservation(objectId, staged, deleted))).toBe(false);
  expect(client.values.has(`tenant/blobs/reservations/${objectId}.decision.json`)).toBe(true);
});

test("S3 adopted reservations retain their explicit deletion fence", async () => {
  const client = new FakeS3Client();
  const first = backend(client);
  const objectId = `b1_${"e".repeat(32)}`;
  const pending = '{"state":"pending"}\n';
  const staged = '{"state":"staged"}\n';
  const ready = '{"state":"ready"}\n';
  const deleted = '{"state":"deleted"}\n';
  success(await first.initialize({ createIfMissing: true }));
  success(await first.createReservation(objectId, pending));
  expect(success(await first.compareAndSwapReservation(objectId, pending, staged))).toBe(true);
  expect(success(await first.compareAndSwapReservation(objectId, staged, ready))).toBe(true);
  const reopened = backend(client);
  expect(success(await reopened.readReservation(objectId))).toBe(ready);
  expect(success(await reopened.compareAndSwapReservation(objectId, ready, deleted))).toBe(true);
  expect(success(await first.readReservation(objectId))).toBe(deleted);
  expect(client.values.has(`tenant/blobs/reservations/${objectId}.fence.json`)).toBe(true);
  expect(success(await first.compareAndSwapReservation(objectId, staged, ready))).toBe(false);
});

test("S3 a delayed staged adopter cannot recreate a deleted reservation", async () => {
  const client = new FakeS3Client();
  const first = backend(client);
  const second = backend(client);
  const objectId = `b1_${"f".repeat(32)}`;
  const pending = '{"state":"pending"}\n';
  const staged = '{"state":"staged"}\n';
  const ready = '{"state":"ready"}\n';
  const deleted = '{"state":"deleted"}\n';
  success(await first.initialize({ createIfMissing: true }));
  success(await first.createReservation(objectId, pending));
  expect(success(await first.compareAndSwapReservation(objectId, pending, staged))).toBe(true);
  const observed = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const readReservation = first.readReservation.bind(first);
  let pause = true;
  first.readReservation = async (id) => {
    const result = await readReservation(id);
    if (pause) {
      pause = false;
      observed.resolve();
      await resume.promise;
    }
    return result;
  };

  const adopting = first.compareAndSwapReservation(objectId, staged, ready);
  await observed.promise;
  expect(success(await second.compareAndSwapReservation(objectId, staged, deleted))).toBe(true);
  success(
    await second.deleteKeys([
      reservationKey(objectId),
      reservationFenceKey(objectId),
      reservationDecisionKey(objectId),
      reservationTransitionKey(objectId),
    ]),
  );
  resume.resolve();

  expect(success(await adopting)).toBe(false);
  expect(success(await second.readReservation(objectId))).toBeNull();
  expect(client.values.has(`tenant/blobs/${reservationDecisionKey(objectId)}`)).toBe(false);
});
