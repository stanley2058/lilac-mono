import { buildThreadSummaryModelMessages } from "../../../src/conversation/thread-service";
import { hydrateNativeConversationAttachments } from "../../../src/surface/native/conversation-attachments";
import { NativeSurfaceStore } from "../../../src/surface/native/store-surface";
import { nativeUserDisplay } from "../../../src/surface/native/identity";
import { authFailure } from "../../../src/surface/native/auth";
import { nativeFailure } from "../../../src/surface/native/errors";
import { describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import { Result, type Result as ResultType } from "better-result";
import { NativeStore } from "../../../src/surface/native/store";
import {
  NativeResourceService,
  NativeUploadSettlementFailed,
} from "../../../src/surface/native/resources";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { CoreResourceService, consumeVerifiedResourceRead } from "../../../src/resource/service";
import { ResourceOriginAdapterRegistry } from "../../../src/resource/origin";

function value<T, E>(result: ResultType<T, E>): T {
  return result.match({
    ok: (item) => item,
    err: (error) => {
      throw error;
    },
  });
}

async function fixture() {
  const db = new Database(":memory:");
  let clock = Date.now();
  const native = new NativeStore(db, () => clock);
  value(native.initialize());
  for (const [id, role] of [
    ["owner", "owner"],
    ["alice", "participant"],
    ["bob", "participant"],
  ] as const)
    value(native.upsertUser({ id, role, providerId: id, displayName: id, toolMode: "full" }));
  const thread = value(native.createThread("alice", { commandId: "thread" }));
  value(native.shareThread("owner", { threadId: thread.id, userId: "bob", grant: "read" }));
  const resources = new SqliteTranscriptStore(":memory:");
  const blobs = value(await createMemoryBlobStore());
  const access = new CoreResourceService({
    store: resources,
    blobStore: blobs,
    originAdapters: new ResourceOriginAdapterRegistry([]),
  });
  const progress: number[] = [];
  const service = new NativeResourceService({
    native,
    resources,
    access,
    blobs,
    now: () => clock++,
    onProgress: (event) => progress.push(event.transferred),
  });
  const bytes = new TextEncoder().encode("hello world");
  const reserve = () =>
    value(
      service.reserve("alice", {
        threadId: thread.id,
        filename: "notes.txt",
        mediaType: "text/plain",
        size: bytes.byteLength,
      }),
    );
  const source = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  const publish = (id: string) =>
    value(
      native.acceptInput("alice", {
        threadId: thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        mode: "prompt",
        text: "inspect",
        attachmentIds: [id],
        skillIds: [],
      }),
    );
  return {
    db,
    native,
    thread,
    resources,
    blobs,
    access,
    service,
    reserve,
    source,
    bytes,
    publish,
    progress,
    advanceClock: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

describe("native resources", () => {
  test("rejects first admission of an expired upload and preserves an accepted command retry", async () => {
    const f = await fixture();
    const acceptedUpload = value(await f.service.upload("alice", f.reserve().id, f.source()));
    const unsent = value(await f.service.upload("alice", f.reserve().id, f.source()));
    const input = {
      threadId: f.thread.id,
      historyGeneration: 0,
      commandId: "send-upload",
      mode: "prompt" as const,
      text: "",
      attachmentIds: [acceptedUpload.id],
      skillIds: [],
    };
    const receipt = value(f.native.acceptInput("alice", input));
    f.advanceClock(25 * 60 * 60_000);
    expect(value(f.service.reconcileReferences())).toBe(1);
    expect(value(await f.access.maintain({ limit: 10 })).deleted).toBe(1);
    expect(value(f.native.acceptInput("alice", input))).toEqual(receipt);
    expect(
      f.native
        .acceptInput("alice", {
          ...input,
          commandId: "send-expired-upload",
          attachmentIds: [unsent.id],
        })
        .match({ ok: () => undefined, err: (error) => error.message }),
    ).toBe("Attachment expired. Reattach the file to send it.");
  });

  for (const deliverFirst of [false, true]) {
    test(`deferred attachments survive staging expiry and release on deletion, delivered=${deliverFirst}`, async () => {
      const f = await fixture();
      const ready = value(await f.service.upload("alice", f.reserve().id, f.source()));
      value(
        f.native.queueSurfaceSend(
          "alice",
          f.thread.id,
          "heartbeat:attachment",
          {
            id: "deferred-file",
            role: "assistant",
            parts: [
              {
                type: "data-resource",
                id: ready.id,
                data: {
                  resourceId: ready.id,
                  name: ready.filename,
                  mediaType: ready.mediaType,
                  size: ready.size,
                  state: "ready",
                },
              },
            ],
          },
          true,
        ),
      );
      f.advanceClock(48 * 60 * 60_000);
      expect(value(f.native.hasDeferredUpload(ready.id))).toBe(true);
      expect(value(f.service.reconcileReferences())).toBe(0);
      expect(value(f.resources.listNativeResourceReferences())).toHaveLength(1);
      expect(value(await f.access.maintain({ limit: 10 })).deleted).toBe(0);
      expect(value(f.native.getUpload(ready.id)).published).toBe(false);
      if (deliverFirst) {
        value(f.native.settleSurfaceSends("heartbeat:attachment"));
        const delivered = value(f.native.deliverSurfaceSends());
        expect(delivered.requestIds).toEqual(["heartbeat:attachment"]);
        expect(delivered.notifications).toEqual([]);
        expect(value(f.native.hasDeferredUpload(ready.id))).toBe(false);
        expect(value(f.native.getUpload(ready.id)).published).toBe(true);
        expect(value(f.service.reconcileReferences())).toBe(0);
      }
      const deletion = value(
        f.native.deleteThread("alice", { threadId: f.thread.id, commandId: "delete-deferred" }),
      );
      value(f.native.finishMutation(f.thread.id, deletion.historyGeneration!));
      expect(value(f.native.hasDeferredUpload(ready.id))).toBe(false);
      expect(value(f.service.reconcileReferences())).toBe(1);
      expect(value(f.resources.listNativeResourceReferences())).toEqual([]);
      expect(value(await f.access.maintain({ limit: 10 })).deleted).toBe(1);
    });
  }

  test("physical thread cleanup releases orphaned native resource ownership", async () => {
    const f = await fixture();
    const ready = value(await f.service.upload("alice", f.reserve().id, f.source()));
    f.publish(ready.id);
    const deletion = value(
      f.native.deleteThread("alice", { threadId: f.thread.id, commandId: "delete-upload-origin" }),
    );
    value(f.native.finishMutation(f.thread.id, deletion.historyGeneration!));
    expect(f.native.getUpload(ready.id).status).toBe("error");
    expect(value(f.service.reconcileReferences())).toBe(1);
    expect(value(f.resources.listNativeResourceReferences())).toEqual([]);
    expect(value(await f.access.maintain({ limit: 10 })).deleted).toBe(1);
  });

  test("reports both upload and failed-state persistence errors", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const storageFailure = nativeFailure("sqlite", "Failed-state write failed");
    const settle = spyOn(f.native, "settleUpload").mockReturnValue(Result.err(storageFailure));
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const result = await f.service.upload("alice", upload.id, short);
    settle.mockRestore();
    const error = result.match({ ok: () => null, err: (failure) => failure });
    expect(error).toBeInstanceOf(NativeUploadSettlementFailed);
    if (!(error instanceof NativeUploadSettlementFailed))
      throw new Error("Expected settlement failure");
    expect(error.uploadFailure).toMatchObject({ code: "invalid" });
    expect(error.settlementFailure).toBe(storageFailure);
  });

  test("shutdown aborts transfers and waits for cancellation and state persistence", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const cancelStarted = Promise.withResolvers<void>();
    const releaseCancel = Promise.withResolvers<void>();
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted.resolve();
        return releaseCancel.promise;
      },
    });
    const uploading = f.service.upload("alice", upload.id, source);
    let stopped = false;
    const stopping = f.service.stop().then((result) => {
      stopped = true;
      return result;
    });
    await cancelStarted.promise;
    expect(stopped).toBe(false);
    releaseCancel.resolve();
    value(await stopping);
    expect((await uploading).status).toBe("error");
    expect(value(f.native.getUpload(upload.id)).state).toBe("failed");
    expect((await f.service.upload("alice", upload.id, f.source())).status).toBe("error");
  });

  test("shutdown propagates failed-state persistence failures", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const settle = spyOn(f.native, "settleUpload").mockReturnValue(
      Result.err(nativeFailure("sqlite", "State unavailable")),
    );
    const uploading = f.service.upload("alice", upload.id, new ReadableStream<Uint8Array>());
    const result = await f.service.stop();
    expect(result.match({ ok: () => null, err: (error) => error._tag })).toBe(
      "NativeUploadSettlementFailed",
    );
    expect((await uploading).status).toBe("error");
    settle.mockRestore();
  });

  test("thread deletion fences an in-flight upload before bytes can be published", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        started.resolve();
        await finish.promise;
        controller.enqueue(f.bytes);
        controller.close();
      },
    });
    const pending = f.service.upload("alice", upload.id, source);
    await started.promise;
    value(f.native.deleteThread("alice", { threadId: f.thread.id, commandId: "delete" }));
    finish.resolve();
    expect((await pending).status).toBe("error");
    expect(value(f.resources.listNativeResourceReferences())).toEqual([]);
    expect(value(f.native.getUpload(upload.id)).resourceUri).toBeUndefined();
  });

  test("completed PUT retries return the same resource without replacing bytes", async () => {
    const f = await fixture();
    const upload = f.reserve();
    const first = value(await f.service.upload("alice", upload.id, f.source()));
    const second = value(await f.service.upload("alice", upload.id, f.source()));
    expect(second.resourceUri).toBe(first.resourceUri);
    expect(value(f.resources.listNativeResourceReferences())).toHaveLength(1);
  });

  test("upload verifies bytes and preserves origin authority before and after publication", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    expect(f.service.get("bob", reserved.id).status).toBe("error");
    const ready = value(await f.service.upload("alice", reserved.id, f.source()));
    expect(ready.state).toBe("ready");
    expect(f.service.authorize("bob", ready.resourceUri!).status).toBe("error");
    expect(value(f.service.authorize("owner", ready.resourceUri!)).origin).toMatchObject({
      threadId: f.thread.id,
      uploaderId: "alice",
    });
    f.publish(ready.id);
    expect(
      new TextDecoder().decode(
        value(
          await consumeVerifiedResourceRead(value(await f.service.open("bob", ready.resourceUri!))),
        ),
      ),
    ).toBe("hello world");
    value(f.native.shareThread("owner", { threadId: f.thread.id, userId: "bob", grant: null }));
    expect(
      (await f.service.scopedAccess("bob").open(ready.resourceUri!, { maxBytes: 100 })).status,
    ).toBe("error");
    expect(f.progress).toEqual([11]);
    expect(value(f.resources.listUnretained({ limit: 100 }))).toEqual([]);
  });

  test("sending while uploading publishes pending state and does not admit partial bytes", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    const receipt = f.publish(reserved.id);
    expect(receipt.state).toBe("uploading");
    expect(value(f.native.prepareInput(receipt.inputId))).toBeNull();
    const ready = value(await f.service.upload("alice", reserved.id, f.source()));
    expect(ready.state).toBe("ready");
    expect(value(f.native.prepareInput(receipt.inputId))?.state).toBe("queued");
  });

  test("rejects foreign handle, oversize and truncated content without resource publication", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    expect((await f.service.upload("bob", reserved.id, f.source())).status).toBe("error");
    const short = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2));
        controller.close();
      },
    });
    expect((await f.service.upload("alice", reserved.id, short)).status).toBe("error");
    expect(value(f.native.getUpload(reserved.id)).state).toBe("failed");
    expect(value(await f.service.upload("alice", reserved.id, f.source())).state).toBe("ready");
    const huge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(12));
        controller.close();
      },
    });
    expect((await f.service.upload("alice", f.reserve().id, huge)).status).toBe("error");
  });

  test("HTTP preview supports bounded ranges and forces unsafe media to download", async () => {
    const f = await fixture();
    const reserved = f.reserve();
    value(await f.service.upload("alice", reserved.id, f.source()));
    f.publish(reserved.id);
    const response = (await f.service.handle(
      new Request(`http://local/api/resources/${reserved.id}`, { headers: { range: "bytes=1-4" } }),
      "bob",
    ))!;
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 1-4/11");
    expect(await response.text()).toBe("ello");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const invalid = (await f.service.handle(
      new Request(`http://local/api/resources/${reserved.id}`, { headers: { range: "bytes=99-" } }),
      "bob",
    ))!;
    expect(invalid.status).toBe(416);
  });

  test("native ownership cannot reparent resources and release permits existing maintenance", async () => {
    const f = await fixture();
    const upload = value(await f.service.upload("alice", f.reserve().id, f.source()));
    const record = value(f.service.authorize("alice", upload.resourceUri!));
    expect(
      f.resources.retainNativeResource({
        uploadId: upload.id,
        threadId: "different",
        resourceId: record.resourceId,
      }).status,
    ).toBe("error");
    value(f.resources.releaseNativeResource(upload.id));
    expect(value(f.resources.getRetained(record.resourceId))).toBeNull();
    expect(value(await f.access.maintain({ limit: 10 })).deleted).toBe(1);
  });
});

describe("native identity and text previews", () => {
  test("owner identity survives persisted reads and avatar is readable outside origin threads", async () => {
    const f = await fixture();
    value(
      f.native.upsertUser({
        id: "lilac",
        providerId: "service:lilac",
        displayName: "Lilac",
        role: "service",
        toolMode: "full",
      }),
    );
    expect(f.native.setAgentIdentity("alice", { displayName: "Forged" }).status).toBe("error");
    value(f.native.setAgentIdentity("owner", { displayName: "Garden" }));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    );
    const request = () =>
      new Request("http://native/api/identity/avatar", {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: png,
      });
    expect((await f.service.handle(request(), "alice"))?.status).toBe(403);
    const uploaded = await f.service.handle(request(), "owner");
    expect(uploaded?.status).toBe(200);
    expect(await uploaded?.json()).toMatchObject({
      id: "lilac",
      displayName: "Garden",
      avatarUrl: expect.stringContaining("/api/identity/avatar?revision="),
    });
    const read = await f.service.handle(new Request("http://native/api/identity/avatar"), "bob");
    expect(read?.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await read!.arrayBuffer())).toEqual(png);
    const avatar = value(f.native.getUser("lilac")).avatar!;
    const cached = await f.service.handle(
      new Request(`http://native/api/identity/avatar?revision=${avatar.blob.sha256}`),
      "bob",
    );
    expect(cached?.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    const unchanged = await f.service.handle(
      new Request("http://native/api/identity/avatar", {
        headers: { "if-none-match": `"${avatar.blob.sha256}"` },
      }),
      "bob",
    );
    expect(unchanged?.status).toBe(304);
    expect(
      (
        await f.service.handle(
          new Request("http://native/api/identity/avatar", {
            headers: { "if-none-match": `"${avatar.blob.sha256}"` },
          }),
          "unknown",
        )
      )?.status,
    ).toBe(404);
    expect(value(f.native.getUser("lilac")).avatar?.blob.byteLength).toBe(png.length);
    expect(
      (
        await f.service.handle(
          new Request("http://native/api/identity/avatar", { method: "DELETE" }),
          "bob",
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await f.service.handle(
          new Request("http://native/api/identity/avatar", { method: "DELETE" }),
          "owner",
        )
      )?.status,
    ).toBe(200);
    expect(
      (await f.service.handle(new Request("http://native/api/identity/avatar"), "bob"))?.status,
    ).toBe(404);
  });

  test("avatar size and bytes are validated instead of trusting the content type", async () => {
    const f = await fixture();
    value(
      f.native.upsertUser({
        id: "lilac",
        providerId: "service:lilac",
        displayName: "Lilac",
        role: "service",
        toolMode: "full",
      }),
    );
    for (const body of ["<svg></svg>", new Uint8Array(2_097_153)]) {
      const response = await f.service.handle(
        new Request("http://native/api/identity/avatar", {
          method: "PUT",
          headers: { "content-type": "image/png" },
          body,
        }),
        "owner",
      );
      expect(response?.status).toBe(400);
    }
    expect(value(f.native.getUser("lilac")).avatar).toBeUndefined();
  });

  test("text preview caps bytes, preserves UTF-8 and applies the origin thread ACL", async () => {
    const f = await fixture();
    const text = "a".repeat(65_535) + "🙂";
    const ready = value(
      await f.service.ingest("alice", f.thread.id, {
        filename: "long.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode(text),
      }),
    );
    f.publish(ready.id);
    const request = () =>
      new Request(`http://native/api/resources/${ready.id}/preview?limit=9999999`);
    const response = await f.service.handle(request(), "bob");
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      text: "a".repeat(65_535),
      truncated: true,
      byteLength: 65_539,
    });
    value(f.native.shareThread("owner", { threadId: f.thread.id, userId: "bob", grant: null }));
    expect((await f.service.handle(request(), "bob"))?.status).toBe(403);
  });

  test("binary preview returns a displayable error", async () => {
    const f = await fixture();
    const ready = value(
      await f.service.ingest("alice", f.thread.id, {
        filename: "data.bin",
        mediaType: "application/octet-stream",
        bytes: new Uint8Array([0, 1, 2]),
      }),
    );
    f.publish(ready.id);
    const response = await f.service.handle(
      new Request(`http://native/api/resources/${ready.id}/preview`),
      "bob",
    );
    expect(response?.status).toBe(422);
    expect(await response?.json()).toEqual({
      error: "Text preview is unavailable for this binary file",
    });
  });
});

test("participants upload and remove only their own public avatar", async () => {
  const f = await fixture();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await f.service.handle(
    new Request("http://native/api/profile/avatar", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: png,
    }),
    "alice",
  );
  expect(uploaded?.status).toBe(200);
  expect(await uploaded?.json()).toMatchObject({
    id: "alice",
    avatarUrl: expect.stringContaining("/api/users/alice/avatar?revision="),
  });
  expect(value(f.native.getUser("bob")).avatar).toBeUndefined();
  const read = await f.service.handle(new Request("http://native/api/users/alice/avatar"), "bob");
  expect(Buffer.from(await read!.arrayBuffer())).toEqual(png);
  expect(
    await f.service.handle(
      new Request("http://native/api/users/alice/avatar", { method: "DELETE" }),
      "bob",
    ),
  ).toBeUndefined();
  const invalid = await f.service.handle(
    new Request("http://native/api/profile/avatar", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: "not an image",
    }),
    "alice",
  );
  expect(invalid?.status).toBe(400);
  const deleted = await f.service.handle(
    new Request("http://native/api/profile/avatar", { method: "DELETE" }),
    "alice",
  );
  expect(deleted?.status).toBe(200);
  expect(value(f.native.getUser("alice")).avatar).toBeUndefined();
  expect(
    (await f.service.handle(new Request("http://native/api/users/alice/avatar"), "bob"))?.status,
  ).toBe(404);
});

test("Clerk avatars are validated, saved in the provider, and projected without local blobs", async () => {
  const f = await fixture();
  const calls: Array<{ id: string; file: File | null }> = [];
  let fail = false;
  const service = new NativeResourceService({
    ...f.service.dependencies,
    profileProvider: {
      updateAvatar: async (id, file) => {
        calls.push({ id, file });
        if (fail) return Result.err(authFailure("unavailable", "Clerk unavailable"));
        return Result.ok({
          providerUserId: id,
          displayName: "Alice",
          ...(file ? { avatarUrl: "https://img.clerk.com/alice.png" } : {}),
        });
      },
    },
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await service.handle(
    new Request("http://native/api/profile/avatar", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: png,
    }),
    "alice",
  );
  expect(uploaded?.status).toBe(200);
  expect(await uploaded?.json()).toMatchObject({ avatarUrl: "https://img.clerk.com/alice.png" });
  expect(calls[0]?.id).toBe("alice");
  expect(calls[0]?.file?.type).toBe("image/png");
  expect(Buffer.from(await calls[0]!.file!.arrayBuffer())).toEqual(png);
  expect(value(f.native.getUser("alice")).avatar).toBeUndefined();
  fail = true;
  expect(
    (
      await service.handle(
        new Request("http://native/api/profile/avatar", { method: "DELETE" }),
        "alice",
      )
    )?.status,
  ).toBe(503);
  expect(value(f.native.getUser("alice")).providerAvatarUrl).toBe(
    "https://img.clerk.com/alice.png",
  );
  fail = false;
  expect(
    (
      await service.handle(
        new Request("http://native/api/profile/avatar", { method: "DELETE" }),
        "alice",
      )
    )?.status,
  ).toBe(200);
  expect(value(f.native.getUser("alice")).providerAvatarUrl).toBeUndefined();
  const invalid = await service.handle(
    new Request("http://native/api/profile/avatar", { method: "PUT", body: "fake image" }),
    "alice",
  );
  expect(invalid?.status).toBe(400);
  expect(calls).toHaveLength(3);
});

test("public avatar URLs round-trip encoded user IDs and reject malformed encoding", async () => {
  const f = await fixture();
  const id = "owner@example.com";
  value(
    f.native.upsertUser({
      id,
      providerId: id,
      displayName: "Owner",
      role: "participant",
      toolMode: "restricted",
    }),
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  await f.service.handle(
    new Request("http://native/api/profile/avatar", { method: "PUT", body: png }),
    id,
  );
  const url = nativeUserDisplay(value(f.native.getUser(id))).avatarUrl!;
  expect((await f.service.handle(new Request(`http://native${url}`), "bob"))?.status).toBe(200);
  expect(
    (await f.service.handle(new Request("http://native/api/users/%ZZ/avatar"), "bob"))?.status,
  ).toBe(400);
});

test("external Discord resources use retained bytes, keep owner authorization, and fail explicitly when missing", async () => {
  const f = await fixture();
  const id = `r1_${"a".repeat(32)}` as const;
  value(
    f.resources.registerOrGet({
      candidateResourceId: id,
      origin: {
        version: 1,
        kind: "discord-attachment",
        channelId: "123",
        messageId: "456",
        ordinal: 0,
      },
      filename: "image.png",
      declaredMediaType: "image/png",
      createdAt: 1,
    }),
  );
  value(
    f.resources.retainNativeResource({
      uploadId: "external-test",
      threadId: f.thread.id,
      resourceId: id,
    }),
  );
  const upload = value(
    await f.blobs.startUpload({ source: f.bytes, retention: { kind: "durable" } }),
  );
  const blob = value(await upload.completion);
  value(f.resources.compareAndSwapCache({ resourceId: id, next: { blob, cachedAt: 1 } }));
  const request = () => new Request(`http://local/api/resources/${id}`);
  expect((await f.service.handle(request(), "alice"))?.status).toBe(403);
  const response = (await f.service.handle(request(), "owner"))!;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("hello world");
  value(await f.blobs.delete(blob));
  expect((await f.service.handle(request(), "owner"))?.status).toBe(404);
});

test("retained transcript files support previews and ranges without exposing blob references", async () => {
  const f = await fixture();
  const upload = value(
    await f.blobs.startUpload({ source: f.bytes, retention: { kind: "durable" } }),
  );
  const blob = value(await upload.completion);
  const service = new NativeResourceService({
    native: f.native,
    resources: f.resources,
    access: f.access,
    blobs: f.blobs,
    externalFile: (actorId, id) =>
      actorId === "owner" && id === "xo_test"
        ? Result.ok({
            type: "pending-blob",
            blob: upload.handle,
            filename: "notes.txt",
            mediaType: "text/plain",
          })
        : Result.err(nativeFailure("forbidden", "Only the owner can read external threads")),
  });
  expect(
    (await service.handle(new Request("http://local/api/resources/xo_test"), "alice"))?.status,
  ).toBe(403);
  const response = (await service.handle(
    new Request("http://local/api/resources/xo_test", { headers: { range: "bytes=1-4" } }),
    "owner",
  ))!;
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("ello");
  const preview = (await service.handle(
    new Request("http://local/api/resources/xo_test/preview"),
    "owner",
  ))!;
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ text: "hello world" });
  value(await f.blobs.delete(blob));
  expect(
    (await service.handle(new Request("http://local/api/resources/xo_test"), "owner"))?.status,
  ).toBe(404);
});

test("conversation summary hydration reads verified native upload bytes", async () => {
  const f = await fixture();
  const upload = (await f.service.upload("alice", f.reserve().id, f.source())).unwrap();
  f.publish(upload.id);
  const surface = new NativeSurfaceStore(f.db, f.native);
  surface.initialize().unwrap();
  const message = surface.listMessages("alice", f.thread.id, { limit: 10 }).unwrap()[0]!;
  const ref = { surface: "native" as const, channelId: f.thread.id, messageId: message.message.id };
  const result = await hydrateNativeConversationAttachments(
    { store: f.native, surface, resources: f.service },
    ref,
    1024,
  );
  expect(result.unwrap().attachments[0]).toMatchObject({ filename: "notes.txt", data: f.bytes });
  const open = spyOn(f.service, "scopedAccess");
  const oversized = (
    await hydrateNativeConversationAttachments(
      { store: f.native, surface, resources: f.service },
      ref,
      1,
    )
  ).unwrap();
  expect(oversized.attachments[0]?.data).toBeUndefined();
  expect(oversized.attachments[0]?.filename).toBe("notes.txt");
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
  value(f.resources.releaseNativeResource(upload.id));
  value(await f.access.maintain({ limit: 10 }));
  const unavailable = (
    await hydrateNativeConversationAttachments(
      { store: f.native, surface, resources: f.service },
      ref,
      1024,
    )
  ).unwrap();
  expect(unavailable.attachments[0]?.data).toBeUndefined();
  expect(unavailable.attachments[0]?.filename).toBe("notes.txt");
  const modelMessages = await buildThreadSummaryModelMessages({
    previous: "",
    promptContextSection: null,
    omittedMessages: 0,
    messages: [
      {
        surface: "native",
        channelId: f.thread.id,
        messageId: ref.messageId,
        ordinal: 0,
        userId: "alice",
        text: "Keep this useful conversation text",
        ts: Date.now(),
        attachments: unavailable.attachments,
      },
    ],
  });
  const content = JSON.stringify(modelMessages);
  expect(content).toContain("Keep this useful conversation text");
  expect(content).toContain("native_attachment");
  expect(content).toContain("content unavailable");
});
