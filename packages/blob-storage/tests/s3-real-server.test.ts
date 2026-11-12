import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";
import type { Result } from "better-result";

import {
  BlobAdapterFailure,
  createLocalBlobStore,
  createS3BlobStore,
  materializeBlobRead,
} from "../src";
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

type RealS3Config = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};

function realS3Config(): RealS3Config {
  if (
    realS3Endpoint === undefined ||
    realS3Bucket === undefined ||
    realS3AccessKeyId === undefined ||
    realS3SecretAccessKey === undefined
  ) {
    throw new Error("Real S3 integration variables are incomplete");
  }
  return {
    endpoint: realS3Endpoint.replace(/\/+$/u, ""),
    bucket: realS3Bucket,
    accessKeyId: realS3AccessKeyId,
    secretAccessKey: realS3SecretAccessKey,
    ...(realS3SessionToken === undefined ? {} : { sessionToken: realS3SessionToken }),
  };
}

function realBackendOptions(config: RealS3Config, prefix: string) {
  return {
    bucket: config.bucket,
    prefix,
    endpoint: config.endpoint,
    region: "us-east-1",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    forcePathStyle: true,
  } as const;
}

function realClient(config: RealS3Config): Bun.S3Client {
  return new Bun.S3Client({
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: "us-east-1",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
    virtualHostedStyle: false,
  });
}

function uniquePrefix(name: string): string {
  return `blob-storage-integration/${name}/${randomUUID()}`;
}

function uniqueObjectId(): string {
  return `b1_${randomUUID().replaceAll("-", "")}`;
}

function encodeS3Segment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: string | Uint8Array, value: string): Uint8Array {
  return createHmac("sha256", key).update(value).digest();
}

// Bun.S3Client cannot address sub-resources such as `?acl` or `?uploads`, so these
// inspection requests are signed here with SigV4 header authentication.
async function signedS3Get(
  config: RealS3Config,
  key: string,
  query: Readonly<Record<string, string>>,
): Promise<string> {
  const objectPath = key === "" ? "" : `/${key.split("/").map(encodeS3Segment).join("/")}`;
  const url = new URL(`${config.endpoint}/${encodeS3Segment(config.bucket)}${objectPath}`);
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeS3Segment(name)}=${encodeS3Segment(query[name] ?? "")}`)
    .join("&");
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update("").digest("hex");
  const headers = new Map<string, string>([
    ["host", url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
    ...(config.sessionToken === undefined
      ? []
      : ([["x-amz-security-token", config.sessionToken]] as const)),
  ]);
  const names = [...headers.keys()].sort();
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery,
    names.map((name) => `${name}:${headers.get(name)}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, date), "us-east-1"), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  url.search = canonicalQuery;
  const response = await fetch(url, {
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
      ...Object.fromEntries([...headers].filter(([name]) => name !== "host")),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Signed S3 GET returned ${response.status}: ${body}`);
  return body;
}

async function incompleteMultipartUploads(config: RealS3Config, prefix: string): Promise<number> {
  const body = await signedS3Get(config, "", { prefix, uploads: "" });
  return body.match(/<Upload>/gu)?.length ?? 0;
}

async function listedKeys(client: Bun.S3Client, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await client.list({ prefix: `${prefix}/`, startAfter });
    const contents = page.contents ?? [];
    keys.push(...contents.map(({ key }) => key));
    const last = contents.at(-1)?.key;
    if (page.isTruncated !== true || last === undefined) return keys;
    startAfter = last;
  }
}

async function expectPrivateObject(config: RealS3Config, key: string): Promise<void> {
  const anonymous = await fetch(
    `${config.endpoint}/${encodeS3Segment(config.bucket)}/${key.split("/").map(encodeS3Segment).join("/")}`,
  );
  expect({ key, status: anonymous.status }).toEqual({ key, status: 403 });
  const acl = await signedS3Get(config, key, { acl: "" });
  expect(acl).toContain("<AccessControlPolicy");
  expect(acl).not.toContain("AllUsers");
  expect(acl).not.toContain("AuthenticatedUsers");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function randomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  // getRandomValues fills at most 64 KiB per call.
  for (let offset = 0; offset < byteLength; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, byteLength)));
  }
  return bytes;
}

function chunkedStream(
  bytes: Uint8Array,
  chunkSize: number,
  failAfter?: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && offset >= failAfter) {
        controller.error(new Error("controlled source interruption"));
        return;
      }
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

const SLOW_REAL_S3_TIMEOUT_MS = 60_000;

realS3Test(
  "real S3 conditional create admits exactly one of many racing writers",
  async () => {
    const config = realS3Config();
    const prefix = uniquePrefix("conditional-create");
    const writers = 8;
    const rounds = 5;
    success(
      await new S3BlobBackend(realBackendOptions(config, prefix)).initialize({
        createIfMissing: true,
      }),
    );
    for (let round = 0; round < rounds; round += 1) {
      const objectId = uniqueObjectId();
      const pending = '{"state":"pending"}\n';
      const conditionalStatuses: number[] = [];
      const arrivals = Promise.withResolvers<void>();
      let arrived = 0;
      // Hold every conditional PUT until all writers have read the pending state, so each
      // writer reaches the server and the store alone decides the winner.
      const barrierFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const conditional =
          init?.method === "PUT" && new Headers(init.headers).get("if-none-match") === "*";
        if (!conditional) return fetch(input, init);
        arrived += 1;
        if (arrived === writers) arrivals.resolve();
        await arrivals.promise;
        const response = await fetch(input, init);
        conditionalStatuses.push(response.status);
        return response;
      };
      const adapters = Array.from(
        { length: writers },
        () => new S3BlobBackend({ ...realBackendOptions(config, prefix), fetch: barrierFetch }),
      );
      success(await adapters[0]!.createReservation(objectId, pending));
      const outcomes = await Promise.all(
        adapters.map((adapter, index) =>
          adapter.compareAndSwapReservation(
            objectId,
            pending,
            `{"state":"ready","writer":${index}}\n`,
          ),
        ),
      );

      const won = outcomes.map(success);
      expect(won.filter(Boolean)).toHaveLength(1);
      expect(conditionalStatuses.toSorted()).toEqual([200, ...Array(writers - 1).fill(412)]);
      const winner = won.indexOf(true);
      for (const adapter of adapters) {
        expect(success(await adapter.readReservation(objectId))).toBe(
          `{"state":"ready","writer":${winner}}\n`,
        );
      }
    }
  },
  SLOW_REAL_S3_TIMEOUT_MS,
);

realS3Test("real S3 server-side copy keeps bytes intact and objects private", async () => {
  const config = realS3Config();
  const prefix = uniquePrefix("copy with space+plus");
  const client = realClient(config);
  const adapter = new S3BlobBackend(realBackendOptions(config, prefix));
  success(await adapter.initialize({ createIfMissing: true }));
  const objectId = uniqueObjectId();
  const generation = "g1";
  const contentKey = `content/durable/${objectId}`;
  const bytes = randomBytes(256 * 1024);
  const sink = success(await adapter.openSink(objectId, generation));
  success(await sink.write(bytes));
  success(await sink.finish());

  success(
    await adapter.commitTemp(objectId, generation, contentKey, '{"metadata":true}\n', {
      sha256: sha256Hex(bytes),
      byteLength: bytes.byteLength,
    }),
  );

  const opened = success(await adapter.openContent(contentKey));
  if (opened === null) throw new Error("Copied content is absent");
  expect(sha256Hex(new Uint8Array(await new Response(opened).arrayBuffer()))).toBe(
    sha256Hex(bytes),
  );
  expect(await client.exists(`${prefix}/temporary/${objectId}.${generation}`)).toBe(false);
  await expectPrivateObject(config, `${prefix}/${contentKey}`);
  await expectPrivateObject(config, `${prefix}/${contentKey}.json`);
});

realS3Test("real S3 copy of a missing source fails without a destination", async () => {
  const config = realS3Config();
  const prefix = uniquePrefix("copy-missing");
  const client = realClient(config);
  const adapter = new S3BlobBackend(realBackendOptions(config, prefix));
  success(await adapter.initialize({ createIfMissing: true }));
  const objectId = uniqueObjectId();
  const contentKey = `content/durable/${objectId}`;

  const committed = await adapter.commitTemp(objectId, "absent", contentKey, "{}\n", {
    sha256: sha256Hex(new Uint8Array()),
    byteLength: 0,
  });

  expect(failure(committed)).toBeInstanceOf(BlobAdapterFailure);
  expect(await client.exists(`${prefix}/${contentKey}`)).toBe(false);
});

realS3Test(
  "real S3 accepts private ACLs on every adapter write and keeps objects private",
  async () => {
    const config = realS3Config();
    const prefix = uniquePrefix("acl");
    const options = realBackendOptions(config, prefix);
    const store = success(await createS3BlobStore(options));
    const started = success(
      await store.startUpload({
        source: new TextEncoder().encode("private bytes"),
        retention: { kind: "expires", expiresAt: Date.now() + 3_600_000 },
      }),
    );
    success(await started.completion);
    const objectId = uniqueObjectId();
    const adapter = new S3BlobBackend(options);
    success(await adapter.createReservation(objectId, '{"state":"pending"}\n'));
    expect(
      success(
        await adapter.compareAndSwapReservation(
          objectId,
          '{"state":"pending"}\n',
          '{"state":"ready"}\n',
        ),
      ),
    ).toBe(true);

    const keys = await listedKeys(realClient(config), prefix);
    const relative = keys.map((key) => key.slice(prefix.length + 1));
    // Each family comes from a different write path: Bun write, conditional presigned PUT,
    // and the signed CopyObject.
    for (const family of ["layout.json", "reservations/", "expiry/", "content/expires/"]) {
      expect(relative.some((key) => key.startsWith(family))).toBe(true);
    }
    for (const key of keys) await expectPrivateObject(config, key);
  },
);

realS3Test("real S3 ListObjectsV2 pages zero-padded keys in order", async () => {
  const config = realS3Config();
  const prefix = uniquePrefix("list");
  const client = realClient(config);
  for (const index of [3, 0, 4, 1, 2]) {
    await client.write(`${prefix}/page/${index.toString().padStart(4, "0")}`, "x", {
      acl: "private",
    });
  }
  const pages: Array<{ readonly keys: readonly string[]; readonly truncated: boolean }> = [];
  let startAfter: string | undefined;
  for (;;) {
    const page = await client.list({ prefix: `${prefix}/page/`, maxKeys: 2, startAfter });
    const keys = (page.contents ?? []).map(({ key }) => key.slice(`${prefix}/page/`.length));
    pages.push({ keys, truncated: page.isTruncated === true });
    if (page.isTruncated !== true) break;
    startAfter = `${prefix}/page/${keys.at(-1)}`;
  }
  expect(pages).toEqual([
    { keys: ["0000", "0001"], truncated: true },
    { keys: ["0002", "0003"], truncated: true },
    { keys: ["0004"], truncated: false },
  ]);

  const adapter = new S3BlobBackend(realBackendOptions(config, prefix));
  success(await adapter.initialize({ createIfMissing: true }));
  const first = `b1_${"a".repeat(32)}`;
  const second = `b1_${"b".repeat(32)}`;
  const third = `b1_${"c".repeat(32)}`;
  success(await adapter.createReservation(second, '{"state":"deleted"}\n', 1));
  success(await adapter.createReservation(third, '{"state":"deleted"}\n', 2));
  success(await adapter.createReservation(first, '{"state":"deleted"}\n', 1));
  for (let index = 0; index < 5; index += 1) {
    success(
      await adapter.createReservation(
        `b1_${index.toString().padStart(32, "0")}`,
        '{"state":"pending"}\n',
        10,
      ),
    );
  }
  const expired = [];
  for (let page = 0; page < 3; page += 1) {
    expired.push(success(await adapter.listExpiredReservationIds(2, 1)));
  }
  expect(expired).toEqual([
    { ids: [first], remaining: true },
    { ids: [second], remaining: true },
    { ids: [third], remaining: false },
  ]);
  expect(success(await adapter.listExpiredReservationIds(10, 100))).toEqual({
    ids: [
      first,
      second,
      third,
      ...Array.from({ length: 5 }, (_, index) => `b1_${index.toString().padStart(32, "0")}`),
    ],
    remaining: false,
  });
});

realS3Test(
  "real S3 multipart upload above the part size commits and verifies",
  async () => {
    const config = realS3Config();
    const prefix = uniquePrefix("multipart");
    const store = success(await createS3BlobStore(realBackendOptions(config, prefix)));
    const bytes = randomBytes(11 * 1024 * 1024 + 123);
    const started = success(
      await store.startUpload({
        source: chunkedStream(bytes, 1024 * 1024),
        retention: { kind: "durable" },
        expectedSha256: sha256Hex(bytes),
        expectedByteLength: bytes.byteLength,
      }),
    );
    const ref = success(await started.completion);

    const read = success(await materializeBlobRead(success(await store.open(ref))));
    expect(read.byteLength).toBe(bytes.byteLength);
    expect(sha256Hex(read)).toBe(sha256Hex(bytes));
    const keys = await listedKeys(realClient(config), prefix);
    expect(keys.some((key) => key.includes("/temporary/"))).toBe(false);
    expect(await incompleteMultipartUploads(config, prefix)).toBe(0);
  },
  SLOW_REAL_S3_TIMEOUT_MS,
);

realS3Test(
  "real S3 aborted multipart sink leaves no object or incomplete upload",
  async () => {
    const config = realS3Config();
    const prefix = uniquePrefix("multipart-abort");
    const client = realClient(config);
    const adapter = new S3BlobBackend(realBackendOptions(config, prefix));
    const objectId = uniqueObjectId();
    const sink = success(await adapter.openSink(objectId, "g1"));
    const chunk = randomBytes(1024 * 1024);
    for (let index = 0; index < 12; index += 1) success(await sink.write(chunk));
    expect(await incompleteMultipartUploads(config, prefix)).toBeGreaterThan(0);

    success(await sink.abort());

    expect(await listedKeys(client, prefix)).toEqual([]);
    expect(await incompleteMultipartUploads(config, prefix)).toBe(0);
  },
  SLOW_REAL_S3_TIMEOUT_MS,
);

realS3Test(
  "real S3 interrupted streaming upload leaves no content or incomplete upload",
  async () => {
    const config = realS3Config();
    const prefix = uniquePrefix("upload-interrupted");
    const store = success(await createS3BlobStore(realBackendOptions(config, prefix)));
    const bytes = randomBytes(12 * 1024 * 1024);
    const started = success(
      await store.startUpload({
        source: chunkedStream(bytes, 1024 * 1024, 7 * 1024 * 1024),
        retention: { kind: "durable" },
      }),
    );

    expect(failure(await started.completion)._tag).toBe("BlobUploadFailed");

    const keys = await listedKeys(realClient(config), prefix);
    expect(keys.filter((key) => key.includes("/temporary/") || key.includes("/content/"))).toEqual(
      [],
    );
    expect(await incompleteMultipartUploads(config, prefix)).toBe(0);
  },
  SLOW_REAL_S3_TIMEOUT_MS,
);

realS3Test("real S3 presigned GET treats 404 as absent and 403 as a failure", async () => {
  const config = realS3Config();
  const prefix = uniquePrefix("presigned-get");
  const adapter = new S3BlobBackend(realBackendOptions(config, prefix));
  success(await adapter.initialize({ createIfMissing: true }));
  const objectId = uniqueObjectId();
  expect(success(await adapter.readReservation(objectId))).toBeNull();

  success(await adapter.createReservation(objectId, '{"state":"pending"}\n'));
  const forbidden = new S3BlobBackend({
    ...realBackendOptions(config, prefix),
    secretAccessKey: `${config.secretAccessKey}-wrong`,
  });
  const failed = failure(await forbidden.readReservation(objectId));
  expect(failed).toBeInstanceOf(BlobAdapterFailure);
  expect(failed.kind).toBe("authorization");
});
