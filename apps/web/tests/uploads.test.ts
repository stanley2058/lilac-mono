import { expect, it } from "bun:test";
import { resolveAttachmentIds } from "../src/uploads";
import type { Attachment } from "../src/types";
import { canUseStagedUpload, readyUploadReference } from "../src/attachment-reference";
it("retries a failed reservation from a pending message without retaining the obsolete promise", async () => {
  const sentAttachment: Attachment = {
    key: "attachment",
    file: new File(["x"], "x.txt"),
    progress: 0,
    state: "failed",
    reservation: Promise.resolve(undefined),
  };
  let current = sentAttachment;
  let retries = 0;
  const pool = {
    get: () => [current],
    retry: (_threadId: string, key: string) => {
      expect(key).toBe(sentAttachment.key);
      retries++;
      current = {
        ...current,
        state: "uploading",
        resourceId: "resource",
        reservation: Promise.resolve("resource"),
      };
    },
  };
  expect(await resolveAttachmentIds(pool, "thread", [sentAttachment], false)).toEqual([undefined]);
  expect(await resolveAttachmentIds(pool, "thread", [sentAttachment], true)).toEqual(["resource"]);
  expect(retries).toBe(1);
  expect(await sentAttachment.reservation).toBeUndefined();
});

import { UploadPool } from "../src/uploads";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";

type Reservation = NativeRpcOutputs["resources"]["reserve"];
function resource(): Reservation {
  return { id: "resource", name: "x.txt", size: 1, mediaType: "text/plain", state: "pending" };
}

it("reports readiness without a composer subscription and reserves a fresh ID for a restored key", async () => {
  const commands: string[] = [];
  const pool = new UploadPool(
    {
      rpc: {
        resources: {
          reserve: async ({ commandId }) => {
            commands.push(commandId);
            return { ...resource(), id: `resource-${commands.length}` };
          },
        },
      },
    },
    async () => {},
  );
  const file = new File(["x"], "x.txt");
  const first = Promise.withResolvers<Attachment>();
  const stop = pool.subscribeReady((threadId, attachment) => {
    expect(threadId).toBe("thread");
    first.resolve(attachment);
  });
  const key = pool.add("thread", file, 1);
  expect(readyUploadReference(await first.promise)).toMatchObject({
    key,
    resourceId: "resource-1",
  });
  stop();
  pool.remove("thread", key);
  const restored = Promise.withResolvers<Attachment>();
  pool.subscribeReady((_threadId, attachment) => restored.resolve(attachment));
  pool.add("thread", file, 2, key);
  expect(readyUploadReference(await restored.promise)).toMatchObject({
    key,
    resourceId: "resource-2",
  });
  expect(new Set(commands).size).toBe(2);
  pool.dispose();
});

it("rejects staged references from discarded history and expired uploads", () => {
  const staging = { threadId: "thread", historyGeneration: 1, expiresAt: Date.now() + 60_000 };
  expect(canUseStagedUpload(staging, "thread", 1)).toBe(true);
  expect(canUseStagedUpload(staging, "thread", 2)).toBe(false);
  expect(canUseStagedUpload(staging, "other", 1)).toBe(false);
  expect(canUseStagedUpload({ ...staging, expiresAt: Date.now() }, "thread", 1)).toBe(false);
});

it("does not start transfer when a reservation completes after session disposal", async () => {
  const pending = Promise.withResolvers<Reservation>();
  let transfers = 0;
  const pool = new UploadPool(
    { rpc: { resources: { reserve: () => pending.promise } } },
    async () => {
      transfers++;
    },
  );
  pool.add("thread", new File(["x"], "x.txt"));
  const reservation = pool.get("thread")[0]!.reservation;
  pool.dispose();
  pending.resolve(resource());
  expect(await reservation).toBeUndefined();
  expect(transfers).toBe(0);
  expect(pool.get("thread")).toEqual([]);
});

it("aborts active transfers on removal and disposal and never repopulates their entries", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const finished = Promise.withResolvers<void>();
  const pool = new UploadPool(
    { rpc: { resources: { reserve: async () => resource() } } },
    async (_id, _file, progress, signal) => {
      if (!signal) throw new Error("Missing lifetime signal");
      started.resolve(signal);
      await finished.promise;
      progress(1);
    },
  );
  const key = pool.add("thread", new File(["x"], "x.txt"));
  const signal = await started.promise;
  pool.remove("thread", key);
  expect(signal.aborted).toBe(true);
  pool.dispose();
  finished.resolve();
  expect(pool.get("thread")).toEqual([]);
});

it("releases accepted attachment files after their upload finishes", async () => {
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const pool = new UploadPool(
    { rpc: { resources: { reserve: async () => resource() } } },
    async () => {
      started.resolve();
      await finished.promise;
    },
  );
  const key = pool.add("thread", new File(["x"], "x.txt"));
  await started.promise;
  pool.release("thread", key);
  expect(pool.get("thread")).toHaveLength(1);
  const unsubscribe = pool.subscribe("thread", () => {
    if (!pool.get("thread").length) released.resolve();
  });
  finished.resolve();
  await released.promise;
  expect(pool.get("thread")).toEqual([]);
  unsubscribe();
  pool.dispose();
});

it("retries a failed reservation after Send using the same attachment command identity", async () => {
  const commands: string[] = [];
  const started = Promise.withResolvers<string>();
  const pool = new UploadPool(
    {
      rpc: {
        resources: {
          reserve: async (input) => {
            commands.push(input.commandId);
            if (commands.length === 1) throw new Error("Reservation unavailable");
            return resource();
          },
        },
      },
    },
    async (resourceId) => {
      started.resolve(resourceId);
    },
  );
  pool.add("thread", new File(["x"], "x.txt"));
  const sentAttachments = pool.get("thread");
  expect(await resolveAttachmentIds(pool, "thread", sentAttachments, false)).toEqual([undefined]);
  expect(await resolveAttachmentIds(pool, "thread", sentAttachments, true)).toEqual(["resource"]);
  expect(await started.promise).toBe("resource");
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(commands[1]);
  pool.dispose();
});

it("aborts an in-flight HTTP upload when the session is disposed", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const finished = Promise.withResolvers<void>();
  const pool = new UploadPool(
    { rpc: { resources: { reserve: async () => resource() } } },
    async (_id, _file, _progress, signal) => {
      if (!signal) throw new Error("Missing lifetime signal");
      started.resolve(signal);
      await finished.promise;
    },
  );
  pool.add("thread", new File(["x"], "x.txt"));
  const signal = await started.promise;
  pool.dispose();
  expect(signal.aborted).toBe(true);
  finished.resolve();
  expect(pool.get("thread")).toEqual([]);
});
