import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it } from "bun:test";

import { Result } from "better-result";
import type {
  BlobDeleteError,
  BlobHandleV1,
  BlobRefV1,
  BlobRetention,
  BlobStore,
  BlobUpload,
} from "@stanley2058/lilac-blob-storage";
import { BlobInvalidReference } from "@stanley2058/lilac-blob-storage";
import { DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS } from "@stanley2058/lilac-utils";

import {
  appendDiscordAttachmentsToBusContent,
  appendDiscordAttachmentsToStoredContent,
  createDiscordAttachmentState,
  getDiscordRequestBlobHandles,
  takeDiscordCurrentBlobReferences,
  type DiscordBusUserContentPart,
  type DiscordStoredUserContentPart,
} from "../../../src/surface/bridge/request-composition/attachments";
import { prepareStoredMessagesForBus } from "../../../src/surface/bridge/request-composition/prepare-bus-messages";
import type {
  DiscordAttachmentCacheAccess,
  DiscordAttachmentCacheEntry,
  DiscordAttachmentCacheKey,
} from "../../../src/surface/discord/discord-attachment";

const originalFetch = globalThis.fetch;
const PNG_BYTES = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function objectId(index: number): string {
  return `b1_${index.toString(16).padStart(32, "0")}`;
}

function blobRef(
  index: number,
  input: { expiresAt?: number; byteLength?: number } = {},
): BlobRefV1 {
  return {
    version: 1,
    objectId: objectId(index),
    sha256: index.toString(16).padStart(64, "0"),
    byteLength: input.byteLength ?? 5,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

function createCache(): {
  access: DiscordAttachmentCacheAccess;
  entries: Map<string, DiscordAttachmentCacheEntry>;
  cleared: BlobRefV1[];
} {
  const entries = new Map<string, DiscordAttachmentCacheEntry>();
  const cleared: BlobRefV1[] = [];
  const id = (key: DiscordAttachmentCacheKey) =>
    [key.channelId, key.messageId, key.ordinal, key.attachmentId ?? ""].join(":");
  return {
    entries,
    cleared,
    access: {
      get: (key) => entries.get(id(key)) ?? null,
      put: (input) => entries.set(id(input), { blob: input.blob, cachedAt: input.cachedAt }),
      clear: (key) => {
        const entry = entries.get(id(key));
        entries.delete(id(key));
        if (entry) cleared.push(entry.blob);
        return entry?.blob ?? null;
      },
    },
  };
}

function createBlobStore(input: {
  opened?: ReadonlyMap<string, { bytes: Uint8Array; completionOk: boolean }>;
  deleteFailure?: BlobDeleteError;
}) {
  const uploads: Array<{
    retention: BlobRetention;
    source: Uint8Array | ReadableStream<Uint8Array>;
    expectedByteLength?: number;
    upload: BlobUpload;
    complete(ref: BlobRefV1): void;
  }> = [];
  const deleted: Array<BlobHandleV1 | BlobRefV1> = [];
  let nextId = 10;

  const store: BlobStore = {
    async startStagedUpload() {
      throw new Error("Staged uploads are not supported by this test store");
    },
    async adopt() {
      throw new Error("Blob adoption is not supported by this test store");
    },
    async startUpload(start) {
      const handle: BlobHandleV1 = { version: 1, objectId: objectId(nextId++) };
      let complete!: (result: ReturnType<typeof Result.ok<BlobRefV1>>) => void;
      const completion = new Promise<ReturnType<typeof Result.ok<BlobRefV1>>>((resolve) => {
        complete = resolve;
      });
      const upload = { handle, completion };
      uploads.push({
        retention: start.retention,
        source: start.source,
        ...(start.expectedByteLength === undefined
          ? {}
          : { expectedByteLength: start.expectedByteLength }),
        upload,
        complete: (ref) => complete(Result.ok(ref)),
      });
      return Result.ok(upload);
    },
    async resolve(handle) {
      return Result.ok(blobRef(99, { byteLength: handle.objectId.length }));
    },
    async open(ref) {
      const opened = input.opened?.get(ref.objectId);
      if (!opened) return Result.err(new Error("absent") as never);
      return Result.ok({
        ref,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(opened.bytes);
            controller.close();
          },
        }),
        completion: Promise.resolve(
          opened.completionOk
            ? Result.ok({
                sha256: ref.sha256,
                byteLength: opened.bytes.byteLength,
              })
            : Result.err(new Error("integrity") as never),
        ),
      });
    },
    async delete(target) {
      deleted.push(target);
      if (input.deleteFailure) return Result.err(input.deleteFailure);
      return Result.ok("deleted" as const);
    },
    async maintain() {
      return Result.ok({ inspected: 0, deleted: 0, remaining: false });
    },
    async close() {
      return Result.ok({ completedUploads: 0, interruptedUploads: 0 });
    },
  };
  return { store, uploads, deleted };
}

describe("Discord request attachment blob composition", () => {
  it("passes structured resources from stored projections to the request bus unchanged", async () => {
    const resource = {
      type: "resource" as const,
      uri: `resource://r1_${"ab".repeat(16)}`,
      filename: "diagram.png",
      mediaType: "image/png",
      size: 321,
    };
    const prepared = await prepareStoredMessagesForBus({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "inspect" }, resource],
        },
        {
          role: "assistant",
          content: [resource],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "inspect",
              output: { type: "content", value: [resource] },
            },
          ],
        },
      ],
    });

    const value = prepared.match({
      ok: (result) => result,
      err: (error) => {
        throw error;
      },
    });
    expect(value.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "inspect" }, resource],
      },
      { role: "assistant", content: [resource] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "inspect",
            output: { type: "content", value: [resource] },
          },
        ],
      },
    ]);
    expect(value.inputHandles).toEqual([]);
  });

  it("materializes a stored reference into a request handle without awaiting upload completion", async () => {
    const storedRef = blobRef(1, { byteLength: 5 });
    const blobs = createBlobStore({
      opened: new Map([
        [storedRef.objectId, { bytes: new Uint8Array([1, 2, 3, 4, 5]), completionOk: true }],
      ]),
    });

    const prepared = await prepareStoredMessagesForBus({
      blobStore: blobs.store,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "blob",
              blob: storedRef,
              mediaType: "image/png",
              filename: "image.png",
            },
          ],
        },
      ],
    });

    const value = prepared.match({
      ok: (result) => result,
      err: (error) => {
        throw error;
      },
    });
    expect(value.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "blob",
            blob: blobs.uploads[0]!.upload.handle,
            mediaType: "image/png",
            filename: "image.png",
          },
        ],
      },
    ]);
    expect(value.inputHandles).toEqual([blobs.uploads[0]!.upload.handle]);
  });

  it("fences request handles when preparing a later stored reference fails", async () => {
    const readableRef = blobRef(1, { byteLength: 5 });
    const absentRef = blobRef(2, { byteLength: 5 });
    const blobs = createBlobStore({
      opened: new Map([
        [readableRef.objectId, { bytes: new Uint8Array([1, 2, 3, 4, 5]), completionOk: true }],
      ]),
    });

    const prepared = await prepareStoredMessagesForBus({
      blobStore: blobs.store,
      messages: [
        {
          role: "user",
          content: [
            { type: "blob", blob: readableRef, mediaType: "image/png" },
            { type: "blob", blob: absentRef, mediaType: "application/pdf" },
          ],
        },
      ],
    });

    expect(prepared.status).toBe("error");
    expect(blobs.deleted).toEqual([blobs.uploads[0]!.upload.handle]);
  });

  it("reports both stored-reference preparation and request-handle cleanup failures", async () => {
    const readableRef = blobRef(1, { byteLength: 5 });
    const absentRef = blobRef(2, { byteLength: 5 });
    const cleanupFailure = new BlobInvalidReference({
      issues: ["forced cleanup failure"],
      message: "forced cleanup failure",
    });
    const blobs = createBlobStore({
      opened: new Map([
        [readableRef.objectId, { bytes: new Uint8Array([1, 2, 3, 4, 5]), completionOk: true }],
      ]),
      deleteFailure: cleanupFailure,
    });

    const prepared = await prepareStoredMessagesForBus({
      blobStore: blobs.store,
      messages: [
        {
          role: "user",
          content: [
            { type: "blob", blob: readableRef, mediaType: "image/png" },
            { type: "blob", blob: absentRef, mediaType: "application/pdf" },
          ],
        },
      ],
    });

    expect(prepared.status).toBe("error");
    if (prepared.status === "error") {
      expect(prepared.error._tag).toBe("DiscordStoredBlobPreparationAndCleanupFailed");
      if (prepared.error._tag === "DiscordStoredBlobPreparationAndCleanupFailed") {
        expect(prepared.error.primary._tag).toBe("DiscordStoredBlobPreparationFailed");
        expect(prepared.error.cleanup.failures).toEqual([cleanupFailure]);
      }
    }
    expect(blobs.deleted).toEqual([blobs.uploads[0]!.upload.handle]);
  });

  it("publishes a durable handle after reservations and fills the default cache asynchronously", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    const cache = createCache();
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({
      blobStore: blobs.store,
      attachmentCache: cache.access,
      now: () => 1_000,
    });
    const parts: DiscordBusUserContentPart[] = [];

    const appended = await appendDiscordAttachmentsToBusContent(
      parts,
      [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          filename: "image.png",
          mimeType: "image/png",
          size: 5,
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    expect(parts).toEqual([
      {
        type: "blob",
        blob: blobs.uploads[0]!.upload.handle,
        mediaType: "image/png",
        filename: "image.png",
      },
    ]);
    expect(getDiscordRequestBlobHandles(state)).toEqual([blobs.uploads[0]!.upload.handle]);
    expect(blobs.uploads.map((upload) => upload.retention)).toEqual([
      { kind: "durable" },
      { kind: "expires", expiresAt: 1_000 + DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS },
    ]);
    expect(cache.entries.size).toBe(0);

    const completedCacheRef = blobRef(20, {
      expiresAt: 1_000 + DEFAULT_DISCORD_ATTACHMENT_CACHE_TTL_MS,
    });
    blobs.uploads[1]!.complete(completedCacheRef);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.entries.values().next().value).toEqual({
      blob: completedCacheRef,
      cachedAt: 1_000,
    });
  });

  it("stores new cache entries durably when retention is unlimited", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        headers: { "content-type": "image/png" },
      })) as unknown as typeof fetch;
    const cache = createCache();
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({
      blobStore: blobs.store,
      attachmentCache: cache.access,
      attachmentCacheTtl: { kind: "unlimited" },
      now: () => 1_000,
    });

    const appended = await appendDiscordAttachmentsToBusContent(
      [],
      [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          mimeType: "image/png",
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    expect(blobs.uploads.map((upload) => upload.retention)).toEqual([
      { kind: "durable" },
      { kind: "durable" },
    ]);
  });

  it("trusts downloaded bytes over conflicting Discord type and size metadata", async () => {
    globalThis.fetch = (async () =>
      new Response(PNG_BYTES, {
        headers: { "content-type": "image/webp" },
      })) as unknown as typeof fetch;
    const cache = createCache();
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({
      blobStore: blobs.store,
      attachmentCache: cache.access,
    });
    const parts: DiscordBusUserContentPart[] = [];

    const appended = await appendDiscordAttachmentsToBusContent(
      parts,
      [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          filename: "image.png",
          mimeType: "image/webp",
          size: PNG_BYTES.byteLength + 920,
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    expect(parts).toEqual([
      {
        type: "blob",
        blob: blobs.uploads[0]!.upload.handle,
        mediaType: "image/png",
        filename: "image.png",
      },
    ]);
    expect(blobs.uploads.map((upload) => upload.expectedByteLength)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("stops a streaming attachment when observed bytes exceed a dishonest declared size", async () => {
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
    globalThis.fetch = (async () => new Response(oversized)) as unknown as typeof fetch;
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({ blobStore: blobs.store });

    const appended = await appendDiscordAttachmentsToBusContent(
      [],
      [
        {
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          mimeType: "image/png",
          size: 1,
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    const source = blobs.uploads[0]!.source;
    if (!(source instanceof ReadableStream)) throw new Error("expected a streaming upload");
    await expect(new Response(source).arrayBuffer()).rejects.toThrow(
      "Discord attachment exceeds the per-file limit",
    );
  });

  it("enforces the aggregate limit from observed bytes when metadata omits sizes", async () => {
    const chunk = new Uint8Array(20 * 1024 * 1024);
    globalThis.fetch = (async () => new Response(chunk)) as unknown as typeof fetch;
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({ blobStore: blobs.store });

    const appended = await appendDiscordAttachmentsToBusContent(
      [],
      [1, 2, 3].map((id) => ({
        id: String(id),
        url: `https://cdn.discordapp.com/attachments/1/${id}/image.png`,
        mimeType: "image/png",
      })),
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    for (const upload of blobs.uploads.slice(0, 2)) {
      if (!(upload.source instanceof ReadableStream)) throw new Error("expected streaming uploads");
      await new Response(upload.source).arrayBuffer();
    }
    const third = blobs.uploads[2]!.source;
    if (!(third instanceof ReadableStream)) throw new Error("expected a streaming upload");
    await expect(new Response(third).arrayBuffer()).rejects.toThrow(
      "Discord attachments exceed the total download limit",
    );
  });

  it("bounds text materialization from observed bytes when size metadata is missing", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array(25 * 1024 * 1024 + 1), {
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({ blobStore: blobs.store });

    const appended = await appendDiscordAttachmentsToBusContent(
      [],
      [
        {
          url: "https://cdn.discordapp.com/attachments/1/2/note.txt",
          mimeType: "text/plain",
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("error");
    if (appended.status === "error") {
      expect(appended.error.message).toBe("Discord attachment exceeds the per-file limit");
    }
  });

  it("copies a verified cache hit into a separately owned durable request upload", async () => {
    globalThis.fetch = (async () => {
      throw new Error("cache hit must not download from Discord");
    }) as unknown as typeof fetch;
    const cachedRef = blobRef(1, { expiresAt: 100_000, byteLength: 5 });
    const cache = createCache();
    cache.entries.set("c1:m1:0:a1", { blob: cachedRef, cachedAt: 1_000 });
    const blobs = createBlobStore({
      opened: new Map([
        [cachedRef.objectId, { bytes: new Uint8Array([1, 2, 3, 4, 5]), completionOk: true }],
      ]),
    });
    const state = createDiscordAttachmentState({
      blobStore: blobs.store,
      attachmentCache: cache.access,
      now: () => 2_000,
    });
    const parts: DiscordBusUserContentPart[] = [];

    const appended = await appendDiscordAttachmentsToBusContent(
      parts,
      [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          mimeType: "image/png",
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    expect(blobs.uploads).toHaveLength(1);
    expect(blobs.uploads[0]!.retention).toEqual({ kind: "durable" });
    expect(blobs.uploads[0]!.source).toBeInstanceOf(Uint8Array);
    expect((parts[0] as { type: string }).type).toBe("blob");
  });

  it("clears an expired cache reference and redownloads the attachment", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([1, 2, 3, 4, 5]));
    }) as unknown as typeof fetch;
    const cachedRef = blobRef(1, { expiresAt: 999, byteLength: 5 });
    const cache = createCache();
    cache.entries.set("c1:m1:0:a1", { blob: cachedRef, cachedAt: 1 });
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({
      blobStore: blobs.store,
      attachmentCache: cache.access,
      now: () => 1_000,
    });

    const appended = await appendDiscordAttachmentsToBusContent(
      [],
      [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          mimeType: "image/png",
          size: 5,
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    expect(fetchCalls).toBe(1);
    expect(cache.cleared).toEqual([cachedRef]);
    expect(blobs.deleted).toEqual([cachedRef]);
    expect(blobs.uploads.map((upload) => upload.retention.kind)).toEqual(["durable", "expires"]);
  });

  it("clears a durable entry after a newly configured finite TTL elapses", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array([1, 2, 3, 4, 5]));
    }) as unknown as typeof fetch;
    const cachedRef = blobRef(1, { byteLength: 5 });
    const cache = createCache();
    cache.entries.set("c1:m1:0:a1", { blob: cachedRef, cachedAt: 1_000 });
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({
      blobStore: blobs.store,
      attachmentCache: cache.access,
      attachmentCacheTtl: { kind: "bounded", value: 1_000 },
      now: () => 2_000,
    });

    const appended = await appendDiscordAttachmentsToBusContent(
      [],
      [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          mimeType: "image/png",
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );

    expect(appended.status).toBe("ok");
    expect(fetchCalls).toBe(1);
    expect(cache.cleared).toEqual([cachedRef]);
    expect(blobs.deleted).toEqual([cachedRef]);
  });

  it("waits for a separate durable reference before returning projection content", async () => {
    globalThis.fetch = (async () =>
      new Response(PNG_BYTES, {
        headers: { "content-type": "image/webp" },
      })) as unknown as typeof fetch;
    const cache = createCache();
    const blobs = createBlobStore({});
    const state = createDiscordAttachmentState({
      blobStore: blobs.store,
      attachmentCache: cache.access,
      now: () => 1_000,
      ownStoredBlob: ({ blob, mediaType, filename }) =>
        Result.ok({ ownerId: "projection-owner-1", blob, mediaType, filename }),
    });
    const parts: DiscordStoredUserContentPart[] = [];
    const pending = appendDiscordAttachmentsToStoredContent(
      parts,
      [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/attachments/1/2/image.png",
          filename: "image.png",
          mimeType: "image/webp",
          size: PNG_BYTES.byteLength + 920,
        },
      ],
      state,
      { channelId: "c1", messageId: "m1" },
    );
    while (blobs.uploads.length < 2) await Promise.resolve();
    const storedRef = blobRef(30, { byteLength: PNG_BYTES.byteLength });
    blobs.uploads[1]!.complete(storedRef);
    const appended = await pending;

    expect(appended.status).toBe("ok");
    expect(blobs.uploads.map((upload) => upload.retention.kind)).toEqual(["expires", "durable"]);
    expect(parts).toEqual([
      {
        type: "blob",
        blob: storedRef,
        mediaType: "image/png",
        filename: "image.png",
      },
    ]);
    expect(getDiscordRequestBlobHandles(state)).toEqual([]);
    expect(takeDiscordCurrentBlobReferences(state)).toEqual([
      {
        ownerId: "projection-owner-1",
        blob: storedRef,
        mediaType: "image/png",
        filename: "image.png",
      },
    ]);
  });
});
