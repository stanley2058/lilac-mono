import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Panic, Result } from "better-result";
import {
  BlobReadCancelled,
  createMemoryBlobStore,
  materializeBlobRead,
  type BlobRead,
  type BlobRefV1,
  type BlobStore,
} from "@stanley2058/lilac-blob-storage";

import { createBlobBackedToolResultArtifactStore } from "../src/blob-tool-result-artifact-store";
import {
  ToolResultArtifactContentMismatch,
  ToolResultArtifactDecryptAuthenticationFailed,
  ToolResultArtifactReadCancelled,
  ToolResultArtifactReadTooLarge,
  ToolResultArtifactStorageFailure,
  ToolResultArtifactTooLargeError,
} from "../src/tool-result-artifact-store";

describe("blob-backed tool result artifact store", () => {
  let baseDir: string;
  const stores: BlobStore[] = [];

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "lilac-blob-tool-results-"));
  });

  afterEach(async () => {
    setSystemTime();
    await Promise.all(
      stores.splice(0).map((store) => store.close({ deadlineAtMs: Date.now() + 1_000 })),
    );
    await rm(baseDir, { recursive: true, force: true });
  });

  async function memoryStore(): Promise<BlobStore> {
    const created = await createMemoryBlobStore();
    if (created.status === "error") throw created.error;
    stores.push(created.value);
    return created.value;
  }

  function params(content: string, maxBytesPerScope = 100) {
    return {
      scopeId: "scope-a",
      requestId: "request-a",
      toolCallId: "call-a",
      toolName: "tool-a",
      content,
      ttlMs: 1_000,
      maxBytesPerScope,
    };
  }

  function observeUploads(store: BlobStore, refs: BlobRefV1[]): BlobStore {
    return {
      startStagedUpload: (input) => store.startStagedUpload(input),
      adopt: (handle) => store.adopt(handle),
      startUpload: async (input) =>
        (await store.startUpload(input)).map((upload) => ({
          ...upload,
          completion: upload.completion.then((completed) =>
            completed.map((ref) => {
              refs.push(ref);
              return ref;
            }),
          ),
        })),
      resolve: (handle, options) => store.resolve(handle, options),
      open: (ref) => store.open(ref),
      delete: (target) => store.delete(target),
      maintain: (input) => store.maintain(input),
      close: (input) => store.close(input),
    };
  }

  it("stores only encrypted blob content and preserves exact domain expiry", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const blobs = await memoryStore();
    const refs: BlobRefV1[] = [];
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      observeUploads(blobs, refs),
    );
    expect((await artifacts.init()).status).toBe("ok");

    const created = await artifacts.create(params("hello"));
    expect(created.status).toBe("ok");
    if (created.status === "error") throw created.error;
    expect(await readdir(artifacts.rootDir)).toHaveLength(1);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ byteLength: 33, expiresAt: 1_767_225_601_000 });

    const opened = await blobs.open(refs[0]!);
    if (opened.status === "error") throw opened.error;
    const encrypted = await materializeBlobRead(opened.value);
    if (encrypted.status === "error") throw encrypted.error;
    expect(Buffer.from(encrypted.value).includes(Buffer.from("hello"))).toBe(false);

    expect(await artifacts.read(created.value.uri, "scope-b")).toMatchObject({ status: "error" });
    expect(await artifacts.read(created.value.uri, "scope-a")).toMatchObject({
      status: "ok",
      value: { content: "hello", createdAt: 1_767_225_600_000, expiresAt: 1_767_225_601_000 },
    });
  });

  it("streams encrypted input and keeps paging semantics", async () => {
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      await memoryStore(),
    );
    await artifacts.init();
    const { content: _content, ...streamParams } = params("unused");
    const created = await artifacts.createFromStream({
      ...streamParams,
      source: Readable.from(["A😀\n", "beta"]),
    });
    if (created.status === "error") throw created.error;

    expect(
      await artifacts.readWindow(created.value.uri, "scope-a", {
        start: { type: "offset", offset: 1 },
        maxCharacters: 2,
        maxLines: 10,
      }),
    ).toMatchObject({
      status: "ok",
      value: {
        content: "😀\n",
        startOffset: 1,
        endOffset: 3,
        totalCharacters: 7,
        hasMore: true,
        nextStart: { type: "offset", offset: 3 },
      },
    });
  });

  it("pages a large artifact without assembling its full plaintext", async () => {
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      await memoryStore(),
    );
    await artifacts.init();
    const content = "😀ab\n".repeat(256 * 1024);
    const created = await artifacts.create({ ...params(content), ttlMs: 60_000 });
    if (created.status === "error") throw created.error;

    const originalConcat = Buffer.concat;
    let largestConcatenation = 0;
    const concat = spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
      largestConcatenation = Math.max(
        largestConcatenation,
        totalLength ?? list.reduce((sum, part) => sum + part.byteLength, 0),
      );
      return originalConcat(list, totalLength);
    });
    try {
      const page = await artifacts.readWindow(created.value.uri, "scope-a", {
        start: { type: "offset", offset: 1 },
        maxCharacters: 5,
        maxLines: 10,
      });
      expect(page).toMatchObject({
        status: "ok",
        value: {
          content: "ab\n😀a",
          startOffset: 1,
          endOffset: 6,
          totalCharacters: 1024 * 1024,
          nextStart: { type: "offset", offset: 6 },
        },
      });
      expect(largestConcatenation).toBeLessThanOrEqual(64 * 1024);
    } finally {
      concat.mockRestore();
    }
  });

  it("handles fragmented nonce, Unicode, and authentication tag while preserving continuation", async () => {
    const blobs = await memoryStore();
    const fragmented: BlobStore = {
      startStagedUpload: (input) => blobs.startStagedUpload(input),
      adopt: (handle) => blobs.adopt(handle),
      startUpload: (input) => blobs.startUpload(input),
      resolve: (handle, options) => blobs.resolve(handle, options),
      delete: (target) => blobs.delete(target),
      maintain: (input) => blobs.maintain(input),
      close: (input) => blobs.close(input),
      open: async (ref) =>
        (await blobs.open(ref)).map((read) => ({
          ...read,
          stream: read.stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                for (let offset = 0; offset < chunk.byteLength; offset += 1) {
                  controller.enqueue(chunk.subarray(offset, offset + 1));
                }
              },
            }),
          ),
        })),
    };
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      fragmented,
    );
    await artifacts.init();
    const content = "A😀é\nsecond\nlast";
    const created = await artifacts.create(params(content));
    if (created.status === "error") throw created.error;
    let start = { type: "offset" as const, offset: 0 };
    const pages: string[] = [];
    for (let index = 0; index < [...content].length; index += 1) {
      const page = await artifacts.readWindow(created.value.uri, "scope-a", {
        start,
        maxCharacters: 100,
        maxLines: 1,
        maxOutputBytes: 4,
      });
      if (page.status === "error") throw page.error;
      pages.push(page.value.content);
      if (!page.value.hasMore) break;
      if (page.value.nextStart?.type !== "offset") throw new Error("Expected offset cursor");
      expect(page.value.nextStart.offset).toBeGreaterThan(start.offset);
      start = page.value.nextStart;
    }
    expect(pages.join("")).toBe(content);
    expect(
      await artifacts.readWindow(created.value.uri, "scope-a", {
        start: { type: "line", line: 1, column: 1 },
        maxCharacters: 100,
        maxLines: 1,
      }),
    ).toMatchObject({
      status: "ok",
      value: { content: "😀é", nextStart: { type: "line", line: 2, column: 0 } },
    });
  });

  it("withholds a selected page when final authentication or blob verification fails", async () => {
    const blobs = await memoryStore();
    let failure: "authentication" | "completion" | undefined;
    const observed: BlobStore = {
      startStagedUpload: (input) => blobs.startStagedUpload(input),
      adopt: (handle) => blobs.adopt(handle),
      startUpload: (input) => blobs.startUpload(input),
      resolve: (handle, options) => blobs.resolve(handle, options),
      delete: (target) => blobs.delete(target),
      maintain: (input) => blobs.maintain(input),
      close: (input) => blobs.close(input),
      open: async (ref) =>
        (await blobs.open(ref)).map((read) => ({
          ...read,
          stream: read.stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                const copied = chunk.slice();
                if (failure === "authentication") copied[copied.byteLength - 1]! ^= 1;
                controller.enqueue(copied);
              },
            }),
          ),
          completion: read.completion.then((completed) =>
            failure === "completion"
              ? Result.err(
                  new BlobReadCancelled({ objectId: ref.objectId, message: "test failure" }),
                )
              : completed,
          ),
        })),
    };
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      observed,
      { onDiagnostic: () => undefined },
    );
    await artifacts.init();
    const created = await artifacts.create(params("requested page\nlater text"));
    if (created.status === "error") throw created.error;
    const readPage = () =>
      artifacts.readWindow(created.value.uri, "scope-a", {
        start: { type: "offset", offset: 0 },
        maxCharacters: 4,
        maxLines: 1,
      });
    failure = "authentication";
    const corrupt = await readPage();
    expect(corrupt.status === "error" && corrupt.error).toBeInstanceOf(
      ToolResultArtifactDecryptAuthenticationFailed,
    );
    failure = "completion";
    const incomplete = await readPage();
    expect(incomplete.status === "error" && incomplete.error).toBeInstanceOf(
      ToolResultArtifactContentMismatch,
    );
    failure = undefined;
    expect(await readPage()).toMatchObject({ status: "ok", value: { content: "requ" } });
  });

  it("rejects bounded reads from metadata before opening content and honors cancellation", async () => {
    const blobs = await memoryStore();
    let openCalls = 0;
    let deferOpen = false;
    let overrun = false;
    let overrunCancelled = false;
    let interruptStream = false;
    let interruptedStreamCancelled = false;
    const openStarted = Promise.withResolvers<void>();
    const openGate = Promise.withResolvers<void>();
    const streamStarted = Promise.withResolvers<void>();
    const observed: BlobStore = {
      startStagedUpload: (input) => blobs.startStagedUpload(input),
      adopt: (handle) => blobs.adopt(handle),
      startUpload: (input) => blobs.startUpload(input),
      resolve: (handle, options) => blobs.resolve(handle, options),
      open: async (ref) => {
        openCalls += 1;
        if (overrun) {
          let pulls = 0;
          return Result.ok({
            ref,
            stream: new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(pulls === 0 ? ref.byteLength : 1));
                pulls += 1;
              },
              cancel() {
                overrunCancelled = true;
              },
            }),
            completion: Promise.resolve(
              Result.ok({ sha256: ref.sha256, byteLength: ref.byteLength + 1 }),
            ),
          });
        }
        if (interruptStream) {
          let delivered = false;
          const terminal = Promise.withResolvers<Awaited<BlobRead["completion"]>>();
          return Result.ok({
            ref,
            stream: new ReadableStream<Uint8Array>({
              pull(controller) {
                if (delivered) return new Promise<void>(() => undefined);
                delivered = true;
                controller.enqueue(new Uint8Array(1));
                streamStarted.resolve();
              },
              cancel() {
                interruptedStreamCancelled = true;
                terminal.resolve(
                  Result.err(
                    new BlobReadCancelled({
                      objectId: ref.objectId,
                      message: "test read cancelled",
                    }),
                  ),
                );
              },
            }),
            completion: terminal.promise,
          });
        }
        if (deferOpen) {
          openStarted.resolve();
          await openGate.promise;
        }
        return blobs.open(ref);
      },
      delete: (target) => blobs.delete(target),
      maintain: (input) => blobs.maintain(input),
      close: (input) => blobs.close(input),
    };
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      observed,
    );
    await artifacts.init();
    const created = await artifacts.create(params("bounded content"));
    if (created.status === "error") throw created.error;

    const oversized = await artifacts.read(created.value.uri, "scope-a", { maxBytes: 4 });
    expect(oversized.status === "error" && oversized.error).toBeInstanceOf(
      ToolResultArtifactReadTooLarge,
    );
    expect(openCalls).toBe(0);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await artifacts.read(created.value.uri, "scope-a", {
      maxBytes: 100,
      signal: controller.signal,
    });
    expect(cancelled.status === "error" && cancelled.error).toBeInstanceOf(
      ToolResultArtifactReadCancelled,
    );
    expect(openCalls).toBe(0);

    deferOpen = true;
    const activeController = new AbortController();
    const activeRead = artifacts.read(created.value.uri, "scope-a", {
      maxBytes: 100,
      signal: activeController.signal,
    });
    await openStarted.promise;
    activeController.abort();
    openGate.resolve();
    const interrupted = await activeRead;
    expect(interrupted.status === "error" && interrupted.error).toBeInstanceOf(
      ToolResultArtifactReadCancelled,
    );
    expect(openCalls).toBe(1);

    deferOpen = false;
    overrun = true;
    const exceededStream = await artifacts.read(created.value.uri, "scope-a", { maxBytes: 100 });
    expect(exceededStream.status === "error" && exceededStream.error).toBeInstanceOf(
      ToolResultArtifactContentMismatch,
    );
    expect(overrunCancelled).toBe(true);

    overrun = false;
    interruptStream = true;
    const streamController = new AbortController();
    const streamingRead = artifacts.read(created.value.uri, "scope-a", {
      maxBytes: 100,
      signal: streamController.signal,
    });
    await streamStarted.promise;
    streamController.abort();
    const interruptedStream = await streamingRead;
    expect(interruptedStream.status === "error" && interruptedStream.error).toBeInstanceOf(
      ToolResultArtifactReadCancelled,
    );
    expect(interruptedStreamCancelled).toBe(true);
  });

  for (const failure of ["consumer", "overflow", "abort"] as const) {
    it(`releases the reader and preserves Panic precedence after ${failure} cancellation fails`, async () => {
      const blobs = await memoryStore();
      const primaryPanic = new Panic({ message: "consumer invariant failed" });
      const cleanupPanic = new Panic({ message: "cancellation invariant failed" });
      const started = Promise.withResolvers<void>();
      let cancelled = false;
      let completionObserved = false;
      let stream: ReadableStream<Uint8Array> | undefined;
      const observed: BlobStore = {
        startStagedUpload: (input) => blobs.startStagedUpload(input),
        adopt: (handle) => blobs.adopt(handle),
        startUpload: (input) => blobs.startUpload(input),
        resolve: (handle, options) => blobs.resolve(handle, options),
        delete: (target) => blobs.delete(target),
        maintain: (input) => blobs.maintain(input),
        close: (input) => blobs.close(input),
        open: async (ref) => {
          const chunk = new Uint8Array(failure === "overflow" ? ref.byteLength + 1 : 12);
          if (failure === "consumer") {
            chunk.subarray = () => {
              throw primaryPanic;
            };
          }
          let delivered = false;
          stream = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (delivered) return new Promise<void>(() => undefined);
                delivered = true;
                controller.enqueue(chunk);
                started.resolve();
              },
              cancel() {
                cancelled = true;
                throw cleanupPanic;
              },
            },
            { highWaterMark: 0 },
          );
          return Result.ok({
            ref,
            stream,
            get completion() {
              completionObserved = true;
              return Promise.resolve(
                Result.err(
                  new BlobReadCancelled({
                    objectId: ref.objectId,
                    message: "test read cancelled",
                  }),
                ),
              );
            },
          });
        },
      };
      const artifacts = createBlobBackedToolResultArtifactStore(
        path.join(baseDir, "metadata"),
        observed,
      );
      await artifacts.init();
      const created = await artifacts.create(params("content"));
      if (created.status === "error") throw created.error;
      const abort = new AbortController();
      const read =
        failure === "abort"
          ? artifacts.read(created.value.uri, "scope-a", { signal: abort.signal })
          : artifacts.readWindow(created.value.uri, "scope-a", {
              start: { type: "offset", offset: 0 },
              maxCharacters: 4,
              maxLines: 1,
            });
      const settled = read.then(
        () => undefined,
        (error: unknown) => error,
      );
      await started.promise;
      if (failure === "abort") abort.abort();
      const thrown = await settled;
      expect(thrown).toBe(failure === "consumer" ? primaryPanic : cleanupPanic);
      expect(cancelled).toBe(true);
      expect(stream?.locked).toBe(false);
      expect(completionObserved).toBe(true);
    });
  }

  it("rejects an oversized stream and deletes the completed partial blob", async () => {
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      await memoryStore(),
    );
    await artifacts.init();
    const { content: _content, ...streamParams } = params("unused");
    const created = await artifacts.createFromStream({
      ...streamParams,
      maxArtifactBytes: 5,
      source: Readable.from(["123", "456"]),
    });

    expect(created.status === "error" && created.error).toBeInstanceOf(
      ToolResultArtifactTooLargeError,
    );
    expect(await readdir(artifacts.rootDir)).toEqual([]);
  });

  it("maps a failed source and releases serialized artifact operations", async () => {
    const artifacts = createBlobBackedToolResultArtifactStore(
      path.join(baseDir, "metadata"),
      await memoryStore(),
    );
    await artifacts.init();
    const { content: _content, ...streamParams } = params("unused");
    const failedSource = new Readable({
      read() {
        this.destroy(new Error("source failed"));
      },
    });
    const failed = await artifacts.createFromStream({ ...streamParams, source: failedSource });
    expect(failed.status === "error" && failed.error).toBeInstanceOf(
      ToolResultArtifactStorageFailure,
    );

    const created = await artifacts.create(params("stored"));
    expect(created.status).toBe("ok");
  });

  it("unlinks evicted metadata before deleting its blob", async () => {
    const blobs = await memoryStore();
    const metadataRoot = path.join(baseDir, "metadata");
    const metadataCountsAtDelete: number[] = [];
    const observed: BlobStore = {
      startStagedUpload: (input) => blobs.startStagedUpload(input),
      adopt: (handle) => blobs.adopt(handle),
      startUpload: (input) => blobs.startUpload(input),
      resolve: (handle, options) => blobs.resolve(handle, options),
      open: (ref) => blobs.open(ref),
      async delete(target) {
        metadataCountsAtDelete.push(
          (await readdir(metadataRoot)).filter((entry) => entry.endsWith(".meta")).length,
        );
        return blobs.delete(target);
      },
      maintain: (input) => blobs.maintain(input),
      close: (input) => blobs.close(input),
    };
    const artifacts = createBlobBackedToolResultArtifactStore(metadataRoot, observed);
    await artifacts.init();
    const first = await artifacts.create(params("first", 5));
    if (first.status === "error") throw first.error;
    const second = await artifacts.create({ ...params("last", 5), toolCallId: "call-b" });
    if (second.status === "error") throw second.error;

    expect(second.value.evicted).toBe(1);
    expect(metadataCountsAtDelete).toEqual([0]);
    expect(await artifacts.read(first.value.uri, "scope-a")).toMatchObject({ status: "error" });
    expect(await artifacts.read(second.value.uri, "scope-a")).toMatchObject({
      status: "ok",
      value: { content: "last" },
    });
  });
});
