import { expect, test } from "bun:test";
import type { Result } from "better-result";

import { BlobObjectAbsent } from "../src/errors";
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
      throw new Error("Expected failure");
    },
    err: (error) => error,
  });
}

function backend(
  client: ControlledS3Client,
  fetch: ConstructorParameters<typeof S3BlobBackend>[0]["fetch"],
) {
  return new S3BlobBackend({
    bucket: "staged-settlement",
    prefix: "blobs",
    accessKeyId: "test-key",
    secretAccessKey: "test-secret",
    client: client as unknown as Bun.S3Client,
    fetch,
  });
}

function delayedCopy(client: ControlledS3Client) {
  const copying = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const copySource = new Headers(init?.headers).get("x-amz-copy-source");
    if (copySource === null) return client.fetch(input, init);
    const sourcePath = decodeURIComponent(copySource).replace(/^\//u, "");
    const sourceKey = sourcePath.slice(sourcePath.indexOf("/") + 1);
    const captured = client.values.get(sourceKey)?.slice();
    const url = input instanceof Request ? input.url : input.toString();
    const destination = decodeURIComponent(new URL(url).pathname.slice(1));
    if (captured === undefined) return new Response(null, { status: 404 });
    copying.resolve();
    await release.promise;
    client.values.set(destination, captured);
    return new Response("<CopyObjectResult />", { status: 200 });
  };
  return { copying: copying.promise, release: () => release.resolve(), fetch };
}

test("expired pending staging retains ownership of a copy that finishes after producer loss", async () => {
  const client = new ControlledS3Client();
  const copy = delayedCopy(client);
  const producerBackend = backend(client, copy.fetch);
  const maintenanceBackend = backend(client, client.fetch);
  success(await producerBackend.initialize({ createIfMissing: true }));
  const producer = new SupervisedBlobStore(producerBackend);
  const maintainer = new SupervisedBlobStore(maintenanceBackend);
  const expiresAt = Date.now() + 60_000;
  const upload = success(
    await producer.startStagedUpload({
      source: new Uint8Array([1, 2]),
      stagingExpiresAt: expiresAt,
    }),
  );
  await copy.copying;
  expect(success(await maintainer.maintain({ now: expiresAt })).deleted).toBe(1);
  const stopped = Promise.withResolvers<void>();
  producerBackend.compareAndSwapReservation = async () => {
    stopped.resolve();
    return new Promise(() => {});
  };
  copy.release();
  await stopped.promise;
  expect([...client.values.keys()].some((key) => key.includes("/content/"))).toBe(true);
  expect(success(await maintenanceBackend.readReservation(upload.handle.objectId))).toContain(
    '"pendingWrites":true',
  );
  expect(failure(await maintainer.adopt(upload.handle))).toBeInstanceOf(BlobObjectAbsent);
  expect(success(await maintainer.maintain({ now: expiresAt })).inspected).toBe(1);
  expect([...client.values.keys()].some((key) => key.includes("/content/"))).toBe(false);
  expect(success(await maintainer.maintain({ now: expiresAt })).inspected).toBe(1);
});

test("confirmed completion of all content writes retires pending-stage cleanup ownership", async () => {
  const client = new ControlledS3Client();
  const copy = delayedCopy(client);
  const producerBackend = backend(client, copy.fetch);
  const maintenanceBackend = backend(client, client.fetch);
  success(await producerBackend.initialize({ createIfMissing: true }));
  const producer = new SupervisedBlobStore(producerBackend);
  const maintainer = new SupervisedBlobStore(maintenanceBackend);
  const expiresAt = Date.now() + 60_000;
  const upload = success(
    await producer.startStagedUpload({ source: new Uint8Array([1]), stagingExpiresAt: expiresAt }),
  );
  await copy.copying;
  success(await maintainer.maintain({ now: expiresAt }));
  copy.release();
  expect(failure(await upload.completion)._tag).toBe("BlobUploadFailed");
  expect(success(await maintenanceBackend.readReservation(upload.handle.objectId))).toBeNull();
  expect(success(await maintainer.maintain({ now: expiresAt })).inspected).toBe(0);
  expect([...client.values.keys()].some((key) => key.includes("/content/"))).toBe(false);
});

test("a failed copy promise cannot acknowledge a remote write that may still complete", async () => {
  const client = new ControlledS3Client();
  let finishRemoteCopy: (() => void) | undefined;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const copySource = new Headers(init?.headers).get("x-amz-copy-source");
    if (copySource === null) return client.fetch(input, init);
    const sourcePath = decodeURIComponent(copySource).replace(/^\//u, "");
    const captured = client.values.get(sourcePath.slice(sourcePath.indexOf("/") + 1))?.slice();
    const url = input instanceof Request ? input.url : input.toString();
    const destination = decodeURIComponent(new URL(url).pathname.slice(1));
    if (captured === undefined) return new Response(null, { status: 404 });
    finishRemoteCopy = () => client.values.set(destination, captured);
    throw new Error("copy request timed out before its remote outcome was known");
  };
  const producerBackend = backend(client, fetch);
  const maintenanceBackend = backend(client, client.fetch);
  success(await producerBackend.initialize({ createIfMissing: true }));
  const producer = new SupervisedBlobStore(producerBackend);
  const maintainer = new SupervisedBlobStore(maintenanceBackend);
  const expiresAt = Date.now() + 60_000;
  const upload = success(
    await producer.startStagedUpload({ source: new Uint8Array([3]), stagingExpiresAt: expiresAt }),
  );
  expect(failure(await upload.completion)._tag).toBe("BlobUploadFailed");
  success(await maintainer.maintain({ now: expiresAt }));
  finishRemoteCopy?.();
  expect([...client.values.keys()].some((key) => key.includes("/content/"))).toBe(true);
  expect(success(await maintainer.maintain({ now: expiresAt })).inspected).toBe(1);
  expect([...client.values.keys()].some((key) => key.includes("/content/"))).toBe(false);
  expect(success(await maintenanceBackend.readReservation(upload.handle.objectId))).toContain(
    '"pendingWrites":true',
  );
});

for (const operation of ["temporary", "metadata"] as const) {
  test(`expired staging keeps ownership of a late ${operation} write after producer loss`, async () => {
    const client = new ControlledS3Client();
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (operation === "temporary") {
      const originalFile = client.file.bind(client);
      client.file = (key) => {
        const file = originalFile(key);
        return {
          ...file,
          writer: () => {
            const writer = file.writer();
            return {
              ...writer,
              end: async (error?: Error) => {
                if (error !== undefined) return writer.end(error);
                writing.resolve();
                await release.promise;
                return writer.end();
              },
            };
          },
        };
      };
    } else {
      const originalWrite = client.write.bind(client);
      client.write = async (key, data) => {
        if (key.includes("/content/") && key.endsWith(".json")) {
          writing.resolve();
          await release.promise;
        }
        return originalWrite(key, data);
      };
    }
    const producerBackend = backend(client, client.fetch);
    const maintenanceBackend = backend(client, client.fetch);
    success(await producerBackend.initialize({ createIfMissing: true }));
    const producer = new SupervisedBlobStore(producerBackend);
    const maintainer = new SupervisedBlobStore(maintenanceBackend);
    const expiresAt = Date.now() + 60_000;
    const upload = success(
      await producer.startStagedUpload({
        source: new Uint8Array([9]),
        stagingExpiresAt: expiresAt,
      }),
    );
    await writing.promise;
    success(await maintainer.maintain({ now: expiresAt }));
    const stopped = Promise.withResolvers<void>();
    producerBackend.compareAndSwapReservation = async () => {
      stopped.resolve();
      return new Promise(() => {});
    };
    release.resolve();
    await stopped.promise;
    expect(success(await maintenanceBackend.readReservation(upload.handle.objectId))).toContain(
      '"pendingWrites":true',
    );
    expect(
      [...client.values.keys()].some(
        (key) => key.includes("/content/") || key.includes("/temporary/"),
      ),
    ).toBe(true);
    expect(success(await maintainer.maintain({ now: expiresAt })).inspected).toBe(1);
    expect(
      [...client.values.keys()].some(
        (key) => key.includes("/content/") || key.includes("/temporary/"),
      ),
    ).toBe(false);
  });
}
