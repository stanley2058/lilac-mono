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
import { UPLOAD_ALREADY_ACTIVE_ERROR, UPLOAD_INTERRUPTED_ERROR } from "../src/http";
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

function reconnectClient(
  reserve?: (input: { commandId: string; name: string }) => Promise<Reservation>,
) {
  const listeners = new Set<
    (event: { kind: "connection"; state: "connecting" | "online" | "offline" }) => void
  >();
  let checks = 0;
  const client: {
    rpc:
      | {
          resources: {
            reserve: (input: { commandId: string; name: string }) => Promise<Reservation>;
          };
        }
      | undefined;
    subscribe: (
      listener: (event: { kind: "connection"; state: "connecting" | "online" | "offline" }) => void,
    ) => () => void;
    checkConnection: () => Promise<void>;
    emitOnline: () => void;
    listenerCount: () => number;
    checks: () => number;
  } = {
    rpc: reserve ? { resources: { reserve } } : undefined,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async checkConnection() {
      checks++;
    },
    emitOnline() {
      for (const listener of listeners) listener({ kind: "connection", state: "online" });
    },
    listenerCount: () => listeners.size,
    checks: () => checks,
  };
  return client;
}

it("does not subscribe until start() and auto-retries a disconnected reservation on reconnect", async () => {
  const commands: string[] = [];
  const ready = Promise.withResolvers<Attachment>();
  const client = reconnectClient();
  const pool = new UploadPool(client, async () => {});
  expect(client.listenerCount()).toBe(0);
  const stopConnection = pool.start();
  expect(client.listenerCount()).toBe(1);
  const stopReady = pool.subscribeReady((_threadId, attachment) => ready.resolve(attachment));
  const key = pool.add("thread", new File(["x"], "x.txt"));
  expect(await pool.get("thread")[0]!.reservation).toBeUndefined();
  expect(pool.get("thread")[0]).toMatchObject({
    key,
    state: "failed",
    error: "Connect to upload this file",
  });

  client.rpc = {
    resources: {
      reserve: async ({ commandId }) => {
        commands.push(commandId);
        return resource();
      },
    },
  };
  client.emitOnline();

  expect(await ready.promise).toMatchObject({ key, resourceId: "resource", state: "ready" });
  expect(await pool.get("thread")[0]!.reservation).toBe("resource");
  expect(commands).toHaveLength(1);
  stopReady();
  stopConnection();
  expect(client.listenerCount()).toBe(0);
  pool.dispose();
});

it("auto-retries connection failures on reconnect but not permanent reservation rejections", async () => {
  let transientAttempts = 0;
  let permanentAttempts = 0;
  const ready = Promise.withResolvers<Attachment>();
  const client = reconnectClient(async (input) => {
    if (input.name === "huge.bin") {
      permanentAttempts++;
      throw new Error("File exceeds the upload size limit");
    }
    transientAttempts++;
    if (transientAttempts === 1) throw new Error("Cannot send message, WebSocket is not open");
    return { ...resource(), id: "recovered" };
  });
  const pool = new UploadPool(client, async () => {});
  const stopConnection = pool.start();
  const stopReady = pool.subscribeReady((_threadId, attachment) => ready.resolve(attachment));

  const transientKey = pool.add("thread", new File(["x"], "photo.png"));
  const permanentKey = pool.add("thread", new File(["x"], "huge.bin"));
  expect(
    await pool.get("thread").find((item) => item.key === transientKey)!.reservation,
  ).toBeUndefined();
  expect(
    await pool.get("thread").find((item) => item.key === permanentKey)!.reservation,
  ).toBeUndefined();
  expect(client.checks()).toBe(1);

  client.emitOnline();

  expect(await ready.promise).toMatchObject({
    key: transientKey,
    resourceId: "recovered",
    state: "ready",
  });
  expect(transientAttempts).toBe(2);
  expect(permanentAttempts).toBe(1);
  expect(pool.get("thread").find((item) => item.key === transientKey)?.state).toBe("ready");
  expect(pool.get("thread").find((item) => item.key === permanentKey)?.state).toBe("failed");
  stopReady();
  stopConnection();
  pool.dispose();
});

it("auto-retries browser-interrupted transfers on reconnect but not generic HTTP rejections", async () => {
  const attempts = new Map<string, number>();
  const interruptedFailed = Promise.withResolvers<void>();
  const httpFailed = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<Attachment>();
  const client = reconnectClient(async (input) => ({ ...resource(), id: `res-${input.name}` }));
  const pool = new UploadPool(client, async (resourceId) => {
    const count = (attempts.get(resourceId) ?? 0) + 1;
    attempts.set(resourceId, count);
    if (resourceId === "res-rejected.txt") throw new Error("Upload failed. Retry this file.");
    if (count === 1) throw new Error("Upload interrupted. Retry this file.");
  });
  const stopConnection = pool.start();
  const stopReady = pool.subscribeReady((_threadId, attachment) => recovered.resolve(attachment));
  const stop = pool.subscribe("thread", () => {
    for (const item of pool.get("thread")) {
      if (item.state !== "failed") continue;
      if (item.file.name === "interrupted.txt") interruptedFailed.resolve();
      if (item.file.name === "rejected.txt") httpFailed.resolve();
    }
  });

  pool.add("thread", new File(["x"], "interrupted.txt"));
  pool.add("thread", new File(["x"], "rejected.txt"));
  await Promise.all([interruptedFailed.promise, httpFailed.promise]);
  expect(client.checks()).toBe(1);

  client.emitOnline();
  expect(await recovered.promise).toMatchObject({
    resourceId: "res-interrupted.txt",
    state: "ready",
  });
  expect(attempts.get("res-interrupted.txt")).toBe(2);
  expect(attempts.get("res-rejected.txt")).toBe(1);
  stop();
  stopReady();
  stopConnection();
  pool.dispose();
});

it("retries immediately when an in-flight reservation or transfer fails after online already fired", async () => {
  const firstReserve = Promise.withResolvers<Reservation>();
  const firstTransfer = Promise.withResolvers<void>();
  let reserveCalls = 0;
  let transferCalls = 0;
  const ready = Promise.withResolvers<Attachment>();
  const client = reconnectClient(async () => {
    reserveCalls++;
    if (reserveCalls === 1) return firstReserve.promise;
    return resource();
  });
  const pool = new UploadPool(client, async () => {
    transferCalls++;
    if (transferCalls === 1) return firstTransfer.promise;
  });
  const stopConnection = pool.start();
  const stopReady = pool.subscribeReady((_threadId, attachment) => ready.resolve(attachment));

  const key = pool.add("thread", new File(["x"], "late.txt"));
  const reservation = pool.get("thread")[0]!.reservation;

  // Replacement socket emits online before the stale reservation rejects.
  client.emitOnline();
  firstReserve.reject(new Error("Cannot send message, WebSocket is not open"));

  expect(await reservation).toBe("resource");
  expect(reserveCalls).toBe(2);

  // Replacement socket emits online again before the stale transfer rejects.
  client.emitOnline();
  firstTransfer.reject(new Error("Upload interrupted. Retry this file."));

  expect(await ready.promise).toMatchObject({ key, resourceId: "resource", state: "ready" });
  expect(transferCalls).toBe(2);
  expect(client.checks()).toBe(0);
  stopReady();
  stopConnection();
  pool.dispose();
});

it("removes a released reservation on failure instead of retrying it on reconnect", async () => {
  const pending = Promise.withResolvers<Reservation>();
  let reserveCalls = 0;
  const client = reconnectClient(async () => {
    reserveCalls++;
    return pending.promise;
  });
  const pool = new UploadPool(client, async () => {});
  const stopConnection = pool.start();

  const key = pool.add("thread", new File(["x"], "discarded.txt"));
  const reservation = pool.get("thread")[0]!.reservation;
  pool.release("thread", key);

  pending.reject(new Error("Cannot send message, WebSocket is not open"));
  expect(await reservation).toBeUndefined();
  expect(pool.get("thread")).toEqual([]);
  expect(client.checks()).toBe(0);

  client.emitOnline();
  expect(reserveCalls).toBe(1);
  stopConnection();
  pool.dispose();
});

it("keeps reconnect retry eligibility when a recovery transfer hits an active-upload conflict", async () => {
  let attempts = 0;
  const firstFailed = Promise.withResolvers<void>();
  const conflictFailed = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<Attachment>();
  const client = reconnectClient(async () => resource());
  const pool = new UploadPool(client, async () => {
    attempts++;
    if (attempts === 1) throw new Error(UPLOAD_INTERRUPTED_ERROR);
    if (attempts === 2) throw new Error(UPLOAD_ALREADY_ACTIVE_ERROR);
  });
  const stopConnection = pool.start();
  const stopReady = pool.subscribeReady((_threadId, attachment) => recovered.resolve(attachment));
  const stop = pool.subscribe("thread", () => {
    const item = pool.get("thread")[0];
    if (item?.state !== "failed") return;
    if (item.error === UPLOAD_INTERRUPTED_ERROR) firstFailed.resolve();
    if (item.error === UPLOAD_ALREADY_ACTIVE_ERROR) conflictFailed.resolve();
  });

  const key = pool.add("thread", new File(["x"], "overlap.txt"));
  await firstFailed.promise;

  client.emitOnline();
  await conflictFailed.promise;
  expect(attempts).toBe(2);

  client.emitOnline();
  expect(await recovered.promise).toMatchObject({ key, resourceId: "resource", state: "ready" });
  expect(attempts).toBe(3);
  stop();
  stopReady();
  stopConnection();
  pool.dispose();
});

it("preserves reconnect eligibility when Send retries a queued transfer into an active-upload conflict", async () => {
  let attempts = 0;
  const firstFailed = Promise.withResolvers<void>();
  const conflictFailed = Promise.withResolvers<void>();
  const recovered = Promise.withResolvers<Attachment>();
  const client = reconnectClient(async () => resource());
  const pool = new UploadPool(client, async () => {
    attempts++;
    if (attempts === 1) throw new Error(UPLOAD_INTERRUPTED_ERROR);
    if (attempts === 2) throw new Error(UPLOAD_ALREADY_ACTIVE_ERROR);
  });
  const stopConnection = pool.start();
  const stopReady = pool.subscribeReady((_threadId, attachment) => recovered.resolve(attachment));
  const stop = pool.subscribe("thread", () => {
    const item = pool.get("thread")[0];
    if (item?.state !== "failed") return;
    if (item.error === UPLOAD_INTERRUPTED_ERROR) firstFailed.resolve();
    if (item.error === UPLOAD_ALREADY_ACTIVE_ERROR) conflictFailed.resolve();
  });

  const key = pool.add("thread", new File(["x"], "send-overlap.txt"));
  await firstFailed.promise;

  // Send retries the interrupted transfer before reconnect; server still holds the first PUT.
  expect(await resolveAttachmentIds(pool, "thread", pool.get("thread"), true)).toEqual([
    "resource",
  ]);
  await conflictFailed.promise;
  expect(attempts).toBe(2);

  client.emitOnline();
  expect(await recovered.promise).toMatchObject({ key, resourceId: "resource", state: "ready" });
  expect(attempts).toBe(3);
  stop();
  stopReady();
  stopConnection();
  pool.dispose();
});
