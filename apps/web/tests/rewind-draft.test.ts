import { createDraftStore } from "../src/draft-store";
import { afterEach, expect, spyOn, test } from "bun:test";
import { rewindDraft, prepareRewindDraft } from "../src/rewind-draft";
import { resolveComposerAttachments } from "../src/components/composer-editor";
import { draftAttachments } from "../src/attachment-reference";
import { resolveAttachmentIds } from "../src/uploads";
import type { LocalAttachment } from "../src/types";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const parts: DisplayPart[] = [
  {
    type: "data-resource",
    id: "old",
    data: {
      resourceId: "old",
      name: "photo.png",
      mediaType: "image/png",
      state: "ready",
      size: 11,
    },
  },
];
const rewindReply = (text: string) => ({
  text,
  checkpoint: {
    protocolVersion: 1 as const,
    historyGeneration: 7,
    projectionRevision: 3,
    cursor: "cursor",
  },
});
function fixture() {
  const attachments: LocalAttachment[] = [];
  const calls: string[] = [];
  const generations: (number | undefined)[] = [];
  const errors: string[] = [];
  const options = {
    parts,
    threadId: "thread",
    pool: {
      signal: new AbortController().signal,
      get: () => attachments,
      add: (_thread: string, file: File, generation?: number) => {
        generations.push(generation);
        calls.push("reserve-new");
        attachments.push({
          key: "new-key",
          file,
          progress: 0,
          state: "reserving",
          reservation: Promise.resolve("new-resource"),
        });
        return "new-key";
      },
    },
    rewind: async () => {
      calls.push("rewind");
      return rewindReply("Look [photo.png](/api/resources/old)");
    },
    onError: (message: string) => errors.push(message),
  };
  return { options, attachments, calls, errors, generations };
}

test("rewind keeps the original upload ID without downloading or reserving a file", async () => {
  const f = fixture();
  const fetch = spyOn(globalThis, "fetch");
  const restored = (await rewindDraft(f.options))!;
  expect(f.calls).toEqual(["rewind"]);
  expect(fetch).not.toHaveBeenCalled();
  const key = restored.attachments[0]!;
  expect(restored.attachmentReferences).toEqual([
    { key, resourceId: "old", name: "photo.png", type: "image/png", size: 11 },
  ]);
  expect(restored.text).toContain(`attachment:${key}`);
  const attachments = draftAttachments(restored.attachments, restored.attachmentReferences, []);
  const ids = await resolveAttachmentIds(
    { ...f.options.pool, retry() {} },
    "thread",
    attachments,
    false,
  );
  expect(ids).toEqual(["old"]);
  expect(resolveComposerAttachments(restored.text, new Map([[key, ids[0]!]]))).toContain(
    "/api/resources/old",
  );
});

test("a rejected rewind does not reserve replacement uploads", async () => {
  const f = fixture();
  expect(await rewindDraft({ ...f.options, rewind: async () => undefined })).toBeUndefined();
  expect(f.attachments).toEqual([]);
});

test("attachments without inline links are restored as composer chips", async () => {
  const f = fixture();
  const result = await rewindDraft({ ...f.options, rewind: async () => rewindReply("") });
  expect(result?.text).toContain(`attachment:${result?.attachments[0]}`);
});

test("text-only rewinds preserve the server text without a Markdown round trip", async () => {
  const f = fixture();
  const text = "plain  text\n\n[editable](https://example.com)  ";
  const fetch = spyOn(globalThis, "fetch");
  expect(
    await rewindDraft({ ...f.options, parts: [], rewind: async () => rewindReply(text) }),
  ).toEqual({
    text,
    attachments: [],
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("a canceled unfinished attachment restores the prompt with a reattachment marker", async () => {
  const f = fixture();
  const fetch = spyOn(globalThis, "fetch");
  const canceled: DisplayPart[] = parts.map((part) =>
    part.type === "data-resource" ? { ...part, data: { ...part.data, state: "canceled" } } : part,
  );
  const result = await rewindDraft({ ...f.options, parts: canceled });
  expect(f.calls).toEqual(["rewind"]);
  expect(fetch).not.toHaveBeenCalled();
  expect(result?.attachments).toEqual([]);
  expect(result?.text).toContain("Reattach: photo.png");
  expect(result?.text).not.toContain("/api/resources/old");
  expect(f.errors).toEqual(["Reattach missing files: photo.png"]);
});

test("rewind reuses locally retained bytes from an unfinished upload", async () => {
  const f = fixture();
  f.attachments.push({
    key: "local",
    resourceId: "old",
    file: new File(["local bytes"], "photo.png", { type: "image/png" }),
    progress: 0,
    state: "failed",
    reservation: Promise.resolve("old"),
  });
  const fetch = spyOn(globalThis, "fetch");
  const canceled: DisplayPart[] = parts.map((part) =>
    part.type === "data-resource" ? { ...part, data: { ...part.data, state: "canceled" } } : part,
  );
  const result = await rewindDraft({ ...f.options, parts: canceled });
  expect(fetch).not.toHaveBeenCalled();
  expect(result?.attachments).toEqual(["new-key"]);
  expect(await f.attachments[1]!.file.text()).toBe("local bytes");
  expect(f.generations).toEqual([7]);
  expect(f.errors).toEqual([]);
});

test("available attachments survive alongside an unavailable file", async () => {
  const f = fixture();
  const result = await rewindDraft({
    ...f.options,
    parts: [
      ...parts,
      {
        type: "data-resource",
        id: "missing",
        data: {
          resourceId: "missing",
          size: 1,
          name: "report.pdf",
          state: "failed",
          mediaType: "application/pdf",
        },
      },
    ],
  });
  expect(result?.attachments).toHaveLength(1);
  expect(result?.attachmentReferences?.[0]?.resourceId).toBe("old");
  expect(result?.text).toContain(`attachment:${result?.attachments[0]}`);
  expect(result?.text).toContain("Reattach: report.pdf");
});

test("prepared upload references survive a failed RPC and are reused on retry", async () => {
  const f = fixture();
  const fetch = spyOn(globalThis, "fetch");
  let calls = 0;
  const store = createDraftStore();
  const callbacks = {
    onError: f.options.onError,
    rewind: async () => {
      calls++;
      if (calls === 1) return undefined;
      return rewindReply("Look [photo.png](/api/resources/old)");
    },
  };
  const finish = await prepareRewindDraft(f.options);
  const request = {
    threadId: "dm",
    commandId: "rewind",
    historyGeneration: 0,
    expectedRevision: 1,
    turnId: "turn",
  };
  const claim = store.getState().claimRewind("dm", "turn")!;
  store.getState().setRewind("dm", claim.owner, {
    ...claim,
    prepared: { request, finish: finish! },
    running: false,
  });
  expect(await store.getState().rewinds.get("dm")!.prepared!.finish(callbacks)).toBeUndefined();
  expect(store.getState().rewinds.get("other")).toBeUndefined();
  const resumed = store.getState().rewinds.get("dm")!;
  expect(resumed.prepared!.request).toBe(request);
  const result = await resumed.prepared!.finish(callbacks);
  store.getState().setRewind("dm", claim.owner);
  expect(store.getState().rewinds.has("dm")).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(result?.attachmentReferences?.[0]?.resourceId).toBe("old");
  expect(f.attachments).toEqual([]);
});
