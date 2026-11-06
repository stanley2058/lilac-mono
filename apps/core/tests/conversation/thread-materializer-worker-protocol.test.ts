import { describe, expect, it } from "bun:test";

import {
  decodeThreadMaterializerWorkerRequest,
  decodeThreadMaterializerWorkerResponse,
  type ThreadMaterializerWorkerRequest,
} from "../../src/conversation/thread-materializer-worker-protocol";
import {
  startConversationThreadMaterializer,
  type ThreadMaterializerWorkerHost,
} from "../../src/conversation/thread-materializer-worker";

class FakeMaterializerWorker implements ThreadMaterializerWorkerHost {
  readonly requests: ThreadMaterializerWorkerRequest[] = [];
  terminated = false;
  postFailure: unknown;
  private messageHandler: ((event: MessageEvent<unknown>) => void) | null = null;
  private readonly requestWaiters = new Map<
    number,
    (request: ThreadMaterializerWorkerRequest) => void
  >();

  setMessageHandler(handler: (event: MessageEvent<unknown>) => void): void {
    this.messageHandler = handler;
  }

  setErrorHandler(handler: (event: ErrorEvent) => void): void {
    void handler;
  }

  postMessage(request: Parameters<ThreadMaterializerWorkerHost["postMessage"]>[0]): void {
    if (this.postFailure !== undefined) throw this.postFailure;
    this.requests.push(request);
    this.requestWaiters.get(this.requests.length - 1)?.(request);
    this.requestWaiters.delete(this.requests.length - 1);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    this.messageHandler?.(new MessageEvent("message", { data }));
  }

  waitForRequest(index: number): Promise<ThreadMaterializerWorkerRequest> {
    const request = this.requests[index];
    if (request) return Promise.resolve(request);
    return new Promise((resolve) => this.requestWaiters.set(index, resolve));
  }
}

async function expectWorkerRestart(response: (requestId: string) => unknown): Promise<void> {
  const workers: FakeMaterializerWorker[] = [];
  const materializer = startConversationThreadMaterializer({
    searchDbPath: "/tmp/search.db",
    workerFactory: () => {
      const worker = new FakeMaterializerWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = workers[0];
  if (!first) throw new Error("Initial materializer worker was not created");
  expect(first.requests).toEqual([]);
  materializer.markDirty({ channelId: "active", kind: "content", messageId: "m1" });
  const flushed = materializer.flush();
  const firstRequest = await first.waitForRequest(0);

  first.emitMessage(response(firstRequest.id));
  expect(first.terminated).toBe(true);
  expect(workers).toHaveLength(2);
  await flushed;
  const replacement = workers[1]!;
  expect(replacement.requests).toEqual([]);
  materializer.markDirty({ channelId: "active", kind: "content", messageId: "m1" });
  const refreshed = materializer.flush();
  const replacementRequest = await replacement.waitForRequest(0);
  expect(replacementRequest).toMatchObject({
    type: "repair-channel",
    channelId: "active",
    kind: "topology",
  });
  replacement.emitMessage({ id: replacementRequest.id, ok: true, type: "repair-channel" });
  await refreshed;
  await materializer.stop();
}

describe("thread materializer worker protocol", () => {
  it("decodes complete request and response envelopes", () => {
    expect(
      decodeThreadMaterializerWorkerRequest({
        id: "request",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "content",
        messageIds: ["message"],
      }).status,
    ).toBe("ok");
    expect(
      decodeThreadMaterializerWorkerRequest({
        id: "topology-request",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "topology",
      }).status,
    ).toBe("ok");
    expect(
      decodeThreadMaterializerWorkerResponse({
        id: "request",
        ok: true,
        type: "repair-channel",
      }).status,
    ).toBe("ok");
  });

  it("rejects corrupt wire payloads without admitting partial envelopes", () => {
    const request = decodeThreadMaterializerWorkerRequest({
      id: "request",
      type: "repair-channel",
      searchDbPath: "/tmp/search.db",
      kind: "content",
    });
    const response = decodeThreadMaterializerWorkerResponse({
      id: "request",
      ok: true,
      type: "list-channels",
      channelIds: [1],
    });

    expect(request.status).toBe("error");
    expect(response.status).toBe("error");
  });

  it("rejects unknown fields and empty response values", () => {
    const requests = [
      {
        id: "request",
        type: "list-channels",
        searchDbPath: "/tmp/search.db",
        extra: true,
      },
      {
        id: "request",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "topology",
        extra: true,
      },
    ];
    const responses = [
      { id: "request", ok: false, error: "" },
      { id: "request", ok: false, error: "failed", extra: true },
      { id: "request", ok: true, type: "list-channels", channelIds: [""] },
      { id: "request", ok: true, type: "repair-channel", extra: true },
    ];

    for (const request of requests) {
      expect(decodeThreadMaterializerWorkerRequest(request).status).toBe("error");
    }
    for (const response of responses) {
      expect(decodeThreadMaterializerWorkerResponse(response).status).toBe("error");
    }
  });

  it("requires content message ids and forbids them for topology repair", () => {
    const invalidRequests = [
      {
        id: "missing-content-message-ids",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "content",
      },
      {
        id: "empty-content-message-ids",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "content",
        messageIds: [],
      },
      {
        id: "topology-message-ids",
        type: "repair-channel",
        searchDbPath: "/tmp/search.db",
        channelId: "channel",
        kind: "topology",
        messageIds: ["message"],
      },
    ];

    for (const request of invalidRequests) {
      expect(decodeThreadMaterializerWorkerRequest(request).status).toBe("error");
    }
  });

  it("restarts and settles pending work after a malformed response", async () => {
    await expectWorkerRestart((requestId) => ({
      id: requestId,
      ok: true,
      type: "list-channels",
      channelIds: [],
      unexpected: true,
    }));
  });

  it("restarts and settles pending work after an unknown response id", async () => {
    await expectWorkerRestart(() => ({
      id: "unknown-request",
      ok: true,
      type: "list-channels",
      channelIds: [],
    }));
  });

  it("waits for activity after a correlated wrong response type", async () => {
    await expectWorkerRestart((id) => ({ id, ok: true, type: "list-channels", channelIds: [] }));
  });

  it("starts idle, repairs on first edit, and invalidates lazily", async () => {
    const worker = new FakeMaterializerWorker();
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/tmp/search.db",
      workerFactory: () => worker,
    });
    await materializer.flush();
    expect(worker.requests).toEqual([]);
    for (const [index, kind] of ["topology", "content", "topology"].entries()) {
      materializer.markDirty({ channelId: "active", kind: "content", messageId: "m1" });
      const flushed = materializer.flush();
      const request = await worker.waitForRequest(index);
      expect(request).toMatchObject({ type: "repair-channel", channelId: "active", kind });
      worker.emitMessage({ id: request.id, ok: true, type: "repair-channel" });
      await flushed;
      if (index === 1) {
        materializer.invalidate();
        await materializer.flush();
        expect(worker.requests).toHaveLength(2);
      }
    }
    await materializer.stop();
  });

  it("does not let an in-flight repair acknowledge a later invalidation", async () => {
    const worker = new FakeMaterializerWorker();
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/tmp/search.db",
      workerFactory: () => worker,
    });
    materializer.markDirty({ channelId: "active", kind: "topology" });
    const flushed = materializer.flush();
    const first = await worker.waitForRequest(0);
    materializer.invalidate();
    materializer.markDirty({ channelId: "active", kind: "content", messageId: "m1" });
    worker.emitMessage({ id: first.id, ok: true, type: "repair-channel" });
    const second = await worker.waitForRequest(1);
    expect(second).toMatchObject({ type: "repair-channel", kind: "topology" });
    worker.emitMessage({ id: second.id, ok: true, type: "repair-channel" });
    await flushed;
    await materializer.stop();
  });

  it("leaves a failed channel for its next activity without sweeping history", async () => {
    const worker = new FakeMaterializerWorker();
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/tmp/search.db",
      workerFactory: () => worker,
    });
    materializer.markDirty({ channelId: "active", kind: "topology" });
    const failed = materializer.flush();
    const request = await worker.waitForRequest(0);
    worker.emitMessage({ id: request.id, ok: false, error: "repair failed" });
    await failed;
    expect(worker.requests).toHaveLength(1);
    materializer.markDirty({ channelId: "active", kind: "content", messageId: "m1" });
    const retried = materializer.flush();
    const retry = await worker.waitForRequest(1);
    expect(retry).toMatchObject({ type: "repair-channel", kind: "topology" });
    worker.emitMessage({ id: retry.id, ok: true, type: "repair-channel" });
    await retried;
    await materializer.stop();
  });

  it("handles an Error thrown by postMessage as the original operation failure", async () => {
    const worker = new FakeMaterializerWorker();
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/tmp/search.db",
      workerFactory: () => worker,
    });
    const failure = new Error("post failed");
    worker.postFailure = failure;
    materializer.markDirty({ channelId: "channel-a", kind: "topology" });

    await expect(materializer.flush()).rejects.toBe(failure);
    worker.postFailure = undefined;
    await expect(materializer.stop()).rejects.toBe(failure);
  });
});
