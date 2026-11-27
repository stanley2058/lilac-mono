import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Panic } from "better-result";

import {
  normalizeConversationThreadWorkerPanic,
  startConversationThreadSummarizationWorker,
  type ConversationThreadWorkerFatalReporter,
  type ConversationThreadSummarizationWorkerTransport,
} from "../../src/conversation/thread-worker";
import type {
  ThreadSummarizationParentMessage,
  ThreadSummarizationResult,
  ThreadSummarizationWorkerRequest,
} from "../../src/conversation/thread-summarization-worker-protocol";
import { Result } from "better-result";

class FakeWorker implements ConversationThreadSummarizationWorkerTransport {
  readonly requests: ThreadSummarizationParentMessage[] = [];
  terminated = false;
  postFailure: unknown;
  onPost: (message: ThreadSummarizationParentMessage) => void = () => {};
  private messageListener: (event: MessageEvent<unknown>) => void = () => {};
  private errorListener: (panic: Panic) => void = () => {};

  postMessage(request: ThreadSummarizationParentMessage): void {
    this.requests.push(request);
    this.onPost(request);
    if (this.postFailure !== undefined) throw this.postFailure;
  }

  terminate(): void {
    this.terminated = true;
  }

  onMessage(listener: (event: MessageEvent<unknown>) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (panic: Panic) => void): void {
    this.errorListener = listener;
  }

  emitMessage(data: unknown): void {
    this.messageListener(new MessageEvent("message", { data }));
  }

  emitError(panic: Panic): void {
    this.errorListener(panic);
  }

  lastRequest(): ThreadSummarizationWorkerRequest {
    const request = this.requests.findLast(
      (item): item is ThreadSummarizationWorkerRequest => !("type" in item),
    );
    if (!request) throw new Error("Expected the fake worker to receive a request");
    return request;
  }
}

function resultFixture(): ThreadSummarizationResult {
  return {
    dryRun: false,
    refreshed: { channels: 1, threads: 2, messages: 3 },
    eligible: 1,
    eligibleTotal: 1,
    eligibility: { summary: 1, embeddingOnly: 0, reasons: { "never-summarized": 1 } },
    cleared: 0,
    summarized: 1,
    failed: 0,
    failures: [],
    threadIds: ["thread-1"],
  };
}

function startClient(
  worker: FakeWorker,
  reportFatalPanic: ConversationThreadWorkerFatalReporter = () => {},
  adapter?: Parameters<typeof startConversationThreadSummarizationWorker>[0]["adapter"],
) {
  return startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.sqlite",
    surfaceDbPath: "/data/surface.sqlite",
    createWorker: () => worker,
    reportFatalPanic,
    adapter,
    idleTimeoutMs: 0,
  });
}

afterEach(() => {
  spyOn(console, "error").mockRestore();
  spyOn(console, "warn").mockRestore();
});

describe("conversation thread summarization worker client", () => {
  it("hydrates worker attachment requests through the surface adapter", async () => {
    const worker = new FakeWorker();
    const readStarted = Promise.withResolvers<void>();
    const responsePosted = Promise.withResolvers<void>();
    worker.onPost = (message) => {
      if ("type" in message) responsePosted.resolve();
    };
    const readResponse =
      Promise.withResolvers<
        Awaited<ReturnType<NonNullable<Parameters<typeof startClient>[2]>["readMsg"]>>
      >();
    const client = startClient(worker, () => {}, {
      async readMsg() {
        readStarted.resolve();
        return await readResponse.promise;
      },
    });

    const pending = client.runSummarization({ wait: true });
    worker.emitMessage({
      type: "hydrate-discord-attachments",
      id: "hydrate-1",
      refs: [{ channelId: "c1", messageId: "m1" }],
    });
    await readStarted.promise;
    readResponse.resolve(
      Result.ok({
        ref: { platform: "discord", channelId: "c1", messageId: "m1" },
        session: { platform: "discord", channelId: "c1" },
        userId: "u1",
        text: "",
        ts: 1,
        raw: {
          attachments: [
            {
              id: "a1",
              url: "https://cdn.discordapp.com/attachments/1/2/image.png",
              filename: "image.png",
              mimeType: "image/png",
              size: 123,
            },
          ],
        },
      }),
    );
    await responsePosted.promise;

    expect(worker.requests.at(-1)).toEqual({
      type: "hydrate-discord-attachments-result",
      id: "hydrate-1",
      results: [
        {
          ref: { channelId: "c1", messageId: "m1" },
          ok: true,
          attachments: [
            {
              id: "a1",
              url: "https://cdn.discordapp.com/attachments/1/2/image.png",
              filename: "image.png",
              mimeType: "image/png",
              size: 123,
            },
          ],
        },
      ],
    });
    worker.emitMessage({ id: worker.lastRequest().id, ok: true, result: resultFixture() });
    await pending;
    await client.stop();
  });

  it("returns queued and completed successes without changing the wire request", async () => {
    const worker = new FakeWorker();
    const client = startClient(worker);

    const queued = await client.runSummarization({ limit: 4 });
    expect(queued.status).toBe("ok");
    const queuedRequest = worker.lastRequest();
    expect(queuedRequest).toEqual({
      id: queuedRequest.id,
      input: { limit: 4 },
      searchDbPath: "/data/search.sqlite",
      surfaceDbPath: "/data/surface.sqlite",
    });
    if (queued.status === "ok") {
      expect(queued.value).toMatchObject({ jobId: queuedRequest.id, status: "queued" });
    }

    const completedOperation = client.runSummarization({ wait: true, threadId: "thread-1" });
    const completedRequest = worker.lastRequest();
    worker.emitMessage({ id: completedRequest.id, ok: true, result: resultFixture() });
    const completed = await completedOperation;

    expect(completed.status).toBe("ok");
    if (completed.status === "ok") {
      expect(completed.value).toEqual({
        ...resultFixture(),
        jobId: completedRequest.id,
        status: "completed",
      });
    }
    await client.stop();
  });

  it("returns an owned remote failure", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const operation = client.runSummarization({ wait: true });
    const request = worker.lastRequest();

    worker.emitMessage({ id: request.id, ok: false, error: "provider unavailable" });
    const result = await operation;

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("ConversationThreadSummarizationRemoteError");
      if (result.error._tag === "ConversationThreadSummarizationRemoteError") {
        expect(result.error.jobId).toBe(request.id);
        expect(result.error.remoteMessage).toBe("provider unavailable");
      }
    }
    await client.stop();
  });

  it("settles all pending jobs when any response is malformed", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const first = client.runSummarization({ wait: true, threadId: "thread-1" });
    const second = client.runSummarization({ wait: true, threadId: "thread-2" });

    worker.emitMessage({ id: worker.lastRequest().id, ok: true, result: { eligible: "one" } });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("error");
    expect(secondResult.status).toBe("error");
    if (firstResult.status === "error" && secondResult.status === "error") {
      expect(firstResult.error._tag).toBe("ThreadSummarizationWorkerMessageDecodeError");
      expect(secondResult.error._tag).toBe("ThreadSummarizationWorkerMessageDecodeError");
    }
    const requestCount = worker.requests.length;
    const futureResult = await client.runSummarization({ wait: true });
    expect(worker.terminated).toBe(true);
    expect(worker.requests).toHaveLength(requestCount);
    expect(futureResult.status).toBe("error");
    if (firstResult.status === "error" && futureResult.status === "error") {
      expect(futureResult.error._tag).toBe("ThreadSummarizationWorkerMessageDecodeError");
      expect(futureResult.error).toBe(firstResult.error);
    }
    await client.stop();
  });

  it("ignores valid responses with unknown IDs", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const operation = client.runSummarization({ wait: true });
    const request = worker.lastRequest();

    worker.emitMessage({ id: "unknown-job", ok: true, result: resultFixture() });
    worker.emitMessage({ id: request.id, ok: true, result: resultFixture() });
    const result = await operation;

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.value.jobId).toBe(request.id);
    await client.stop();
  });

  it("rejects pending and future operations with Panic after a worker defect", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const first = client.runSummarization({ wait: true });
    const second = client.runSummarization({ wait: true });

    worker.emitError(new Panic({ message: "worker crashed" }));
    const [firstPanic, secondPanic] = await Promise.all([
      first.then(
        () => null,
        (error: unknown) => error,
      ),
      second.then(
        () => null,
        (error: unknown) => error,
      ),
    ]);

    expect(Panic.is(firstPanic)).toBe(true);
    expect(firstPanic).toBe(secondPanic);
    await expect(client.runSummarization({ wait: true })).rejects.toBe(firstPanic);
    expect(worker.terminated).toBe(true);
    expect(worker.requests).toHaveLength(2);
    await client.stop();
  });

  it("reports a worker Panic immediately when no jobs are waiting", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const panic = new Panic({ message: "idle worker invariant failed" });
    const reported: Panic[] = [];
    const client = startClient(worker, (fatalPanic) => reported.push(fatalPanic));
    const initial = client.runSummarization({ wait: true });
    worker.emitMessage({ id: worker.lastRequest().id, ok: true, result: resultFixture() });
    await initial;

    worker.emitError(panic);

    expect(reported).toEqual([panic]);
    expect(worker.terminated).toBe(true);
    await client.stop();
  });

  it("normalizes and reports an opaque worker error message", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const reported: Panic[] = [];
    const client = startClient(worker, (fatalPanic) => reported.push(fatalPanic));
    const initial = client.runSummarization({ wait: true });
    worker.emitMessage({ id: worker.lastRequest().id, ok: true, result: resultFixture() });
    await initial;

    const normalized = normalizeConversationThreadWorkerPanic(
      "Conversation thread summarization worker failed with an opaque error",
    );
    worker.emitError(normalized);

    expect(normalized.message).toBe(
      "Conversation thread summarization worker failed with an opaque error",
    );
    expect(reported).toEqual([normalized]);
    expect(worker.terminated).toBe(true);
    await client.stop();
  });

  it("reports a worker Panic immediately for a wait:false job", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const worker = new FakeWorker();
    const panic = new Panic({ message: "queued worker invariant failed" });
    const reported: Panic[] = [];
    const client = startClient(worker, (fatalPanic) => reported.push(fatalPanic));
    const queued = await client.runSummarization({ wait: false });

    expect(queued.status).toBe("ok");
    worker.emitError(panic);

    expect(reported).toEqual([panic]);
    expect(worker.terminated).toBe(true);
    await client.stop();
  });

  it("returns postMessage failures and remains usable after bookkeeping is removed", async () => {
    const worker = new FakeWorker();
    const client = startClient(worker);
    const postFailure = new Error("structured clone failed");
    worker.postFailure = postFailure;

    const failed = await client.runSummarization({ wait: true });

    expect(failed.status).toBe("error");
    if (
      failed.status === "error" &&
      failed.error._tag === "ConversationThreadSummarizationTransportError"
    ) {
      expect(failed.error.operation).toBe("post-message");
      expect(failed.error.cause).toBe(postFailure);
    }

    const failedRequest = worker.lastRequest();
    worker.postFailure = undefined;
    worker.emitMessage({ id: failedRequest.id, ok: true, result: resultFixture() });
    const recoveredOperation = client.runSummarization({ wait: true });
    const recoveredRequest = worker.lastRequest();
    worker.emitMessage({ id: recoveredRequest.id, ok: true, result: resultFixture() });
    expect((await recoveredOperation).status).toBe("ok");
    await client.stop();
  });

  it("settles pending operations on stop and returns stopped Results for later runs", async () => {
    const worker = new FakeWorker();
    const client = startClient(worker);
    const pending = client.runSummarization({ wait: true });

    await client.stop();
    const pendingResult = await pending;
    const stoppedResult = await client.runSummarization();

    expect(worker.terminated).toBe(true);
    for (const result of [pendingResult, stoppedResult]) {
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error._tag).toBe("ConversationThreadSummarizationTransportError");
      }
      if (
        result.status === "error" &&
        result.error._tag === "ConversationThreadSummarizationTransportError"
      ) {
        expect(result.error.operation).toBe("stopped");
      }
    }
  });

  it("preserves Panic thrown by postMessage and removes its bookkeeping", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const worker = new FakeWorker();
    const client = startClient(worker);
    const panic = new Panic({ message: "worker transport invariant failed" });
    worker.postFailure = panic;

    await expect(client.runSummarization({ wait: true })).rejects.toBe(panic);

    const failedRequest = worker.lastRequest();
    worker.postFailure = undefined;
    worker.emitMessage({ id: failedRequest.id, ok: true, result: resultFixture() });
    const recoveredOperation = client.runSummarization({ wait: true });
    const recoveredRequest = worker.lastRequest();
    worker.emitMessage({ id: recoveredRequest.id, ok: true, result: resultFixture() });
    expect((await recoveredOperation).status).toBe("ok");
    await client.stop();
  });
});

it("hydrates native resources through the shared worker bridge without losing bytes", async () => {
  const worker = new FakeWorker();
  const bytes = new Uint8Array([1, 2, 3]);
  const response = Promise.withResolvers<ThreadSummarizationParentMessage>();
  worker.onPost = (message) => {
    if ("type" in message) response.resolve(message);
  };
  const client = startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.db",
    nativeDbPath: "/data/native.db",
    createWorker: () => worker,
    attachmentHydrator: async ({ refs }) =>
      Result.ok(
        refs.map((ref) => ({ ref, attachments: [{ url: "resource://r1_test", data: bytes }] })),
      ),
  });
  const pending = client.runSummarization({ wait: true });
  expect(worker.lastRequest().nativeDbPath).toBe("/data/native.db");
  worker.emitMessage({
    type: "hydrate-discord-attachments",
    id: "hydrate-native",
    refs: [{ surface: "native", channelId: "thread", messageId: "message" }],
  });
  expect(await response.promise).toMatchObject({
    results: [{ ok: true, ref: { surface: "native" }, attachments: [{ data: bytes }] }],
  });
  worker.emitMessage({ id: worker.lastRequest().id, ok: true, result: resultFixture() });
  await pending;
  await client.stop();
});

it("spawns lazily on demand, tears down when idle, and respawns cleanly on the next job", async () => {
  const workers: FakeWorker[] = [];
  let idleTask: (() => void | Promise<void>) | null = null;
  const client = startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.db",
    createWorker: () => {
      const created = new FakeWorker();
      workers.push(created);
      return created;
    },
    idleTimeoutMs: 1_000,
    scheduleIdle: (task) => {
      idleTask = task;
      return () => {
        if (idleTask === task) idleTask = null;
      };
    },
  });

  expect(workers).toHaveLength(0);
  expect(client.getMemoryDiagnostics().status).toBe("idle");

  const first = client.runSummarization({ wait: true });
  expect(workers).toHaveLength(1);
  expect(client.getMemoryDiagnostics().status).toBe("running");
  workers[0]!.emitMessage({ id: workers[0]!.lastRequest().id, ok: true, result: resultFixture() });
  expect((await first).status).toBe("ok");

  expect(idleTask).not.toBeNull();
  await idleTask!();
  expect(workers[0]!.terminated).toBe(true);
  expect(client.getMemoryDiagnostics().status).toBe("idle");

  const second = client.runSummarization({ wait: true });
  expect(workers).toHaveLength(2);
  workers[1]!.emitMessage({ id: workers[1]!.lastRequest().id, ok: true, result: resultFixture() });
  expect((await second).status).toBe("ok");
  await client.stop();
});

it("restarts the summarization worker after a memory watchdog kill without fatal panic", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  const workers: FakeWorker[] = [];
  const reportedPanics: Panic[] = [];
  const client = startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.db",
    createWorker: () => {
      const created = new FakeWorker();
      workers.push(created);
      return created;
    },
    reportFatalPanic: (panic) => reportedPanics.push(panic),
    idleTimeoutMs: 0,
  });

  const first = client.runSummarization({ wait: true });
  workers[0]!.emitMessage({
    type: "worker-memory",
    at: 1000,
    limitBytes: 768 * 1024 * 1024,
    streak: 1,
    memory: {
      rss: 900 * 1024 * 1024,
      heapUsed: 780 * 1024 * 1024,
      heapTotal: 800 * 1024 * 1024,
      external: 20 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });
  expect(client.getMemoryDiagnostics()).toMatchObject({
    status: "running",
    restarts: 0,
    streak: 1,
  });

  workers[0]!.emitMessage({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 768 * 1024 * 1024,
    streak: 3,
    reason: "thread-summarization-worker isolate memory exceeded limit",
    memory: {
      rss: 1024 * 1024 * 1024,
      heapUsed: 800 * 1024 * 1024,
      heapTotal: 820 * 1024 * 1024,
      external: 20 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });

  const firstResult = await first;
  expect(firstResult.status).toBe("error");
  if (
    firstResult.status === "error" &&
    firstResult.error._tag === "ConversationThreadSummarizationTransportError"
  ) {
    expect(firstResult.error.operation).toBe("memory-watchdog");
  }
  expect(workers[0]!.terminated).toBe(true);
  expect(reportedPanics).toEqual([]);
  expect(client.getMemoryDiagnostics()).toMatchObject({
    status: "idle",
    restarts: 1,
    lastRestartReason: "thread-summarization-worker isolate memory exceeded limit",
  });

  // Next job transparently boots a fresh worker.
  const second = client.runSummarization({ wait: true });
  expect(workers).toHaveLength(2);
  workers[1]!.emitMessage({ id: workers[1]!.lastRequest().id, ok: true, result: resultFixture() });
  expect((await second).status).toBe("ok");
  await client.stop();
});

it("ignores late hydration rejection from a retired worker without killing its replacement", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  const workers: FakeWorker[] = [];
  const reportedPanics: Panic[] = [];
  const staleHydration = Promise.withResolvers<never>();
  const client = startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.db",
    createWorker: () => {
      const created = new FakeWorker();
      workers.push(created);
      return created;
    },
    attachmentHydrator: () => staleHydration.promise,
    reportFatalPanic: (panic) => reportedPanics.push(panic),
    idleTimeoutMs: 0,
  });

  const first = client.runSummarization({ wait: true });
  workers[0]!.emitMessage({
    type: "hydrate-discord-attachments",
    id: "hydrate-stale",
    refs: [{ channelId: "c1", messageId: "m1" }],
  });
  workers[0]!.emitMessage({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 768 * 1024 * 1024,
    streak: 3,
    reason: "thread-summarization-worker isolate memory exceeded limit",
    memory: {
      rss: 1024 * 1024 * 1024,
      heapUsed: 800 * 1024 * 1024,
      heapTotal: 820 * 1024 * 1024,
      external: 20 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });
  expect((await first).status).toBe("error");

  const second = client.runSummarization({ wait: true });
  expect(workers).toHaveLength(2);

  // Reject stale hydration from worker 0 after worker 1 is active.
  staleHydration.reject(new Error("adapter closed during stale hydration"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  expect(reportedPanics).toEqual([]);
  expect(workers[1]!.terminated).toBe(false);
  workers[1]!.emitMessage({ id: workers[1]!.lastRequest().id, ok: true, result: resultFixture() });
  expect((await second).status).toBe("ok");
  await client.stop();
});

it("still reports a host-side hydration Panic even if the requesting worker was retired", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  const workers: FakeWorker[] = [];
  const reportedPanics: Panic[] = [];
  const panicReported = Promise.withResolvers<Panic>();
  const staleHydration = Promise.withResolvers<never>();
  const client = startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.db",
    createWorker: () => {
      const created = new FakeWorker();
      workers.push(created);
      return created;
    },
    attachmentHydrator: () => staleHydration.promise,
    reportFatalPanic: (panic) => {
      reportedPanics.push(panic);
      panicReported.resolve(panic);
    },
    idleTimeoutMs: 0,
  });

  const first = client.runSummarization({ wait: true });
  workers[0]!.emitMessage({
    type: "hydrate-discord-attachments",
    id: "hydrate-panic",
    refs: [{ channelId: "c1", messageId: "m1" }],
  });
  workers[0]!.emitMessage({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 768 * 1024 * 1024,
    streak: 3,
    reason: "thread-summarization-worker isolate memory exceeded limit",
    memory: {
      rss: 1024 * 1024 * 1024,
      heapUsed: 800 * 1024 * 1024,
      heapTotal: 820 * 1024 * 1024,
      external: 20 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });
  expect((await first).status).toBe("error");

  const panic = new Panic({ message: "host hydration invariant failed" });
  staleHydration.reject(panic);
  expect(await panicReported.promise).toBe(panic);

  expect(reportedPanics).toEqual([panic]);
  expect(client.getMemoryDiagnostics().status).toBe("stopped");
  await client.stop();
});

it("cleans up bookkeeping when lazy worker creation fails and still schedules idle teardown", async () => {
  const workers: FakeWorker[] = [];
  let idleTask: (() => void | Promise<void>) | null = null;
  let attempts = 0;
  const client = startConversationThreadSummarizationWorker({
    searchDbPath: "/data/search.db",
    createWorker: () => {
      attempts += 1;
      if (attempts === 1) throw new Error("spawn temporarily unavailable");
      const created = new FakeWorker();
      workers.push(created);
      return created;
    },
    idleTimeoutMs: 1_000,
    scheduleIdle: (task) => {
      idleTask = task;
      return () => {
        if (idleTask === task) idleTask = null;
      };
    },
  });

  const failed = await client.runSummarization({ wait: true });
  expect(failed.status).toBe("error");
  expect(client.getMemoryDiagnostics().status).toBe("idle");

  const succeeded = client.runSummarization({ wait: true });
  expect(workers).toHaveLength(1);
  workers[0]!.emitMessage({ id: workers[0]!.lastRequest().id, ok: true, result: resultFixture() });
  expect((await succeeded).status).toBe("ok");

  expect(idleTask).not.toBeNull();
  await idleTask!();
  expect(workers[0]!.terminated).toBe(true);
  expect(client.getMemoryDiagnostics().status).toBe("idle");
  await client.stop();
});

it("reports stopped diagnostics after a terminal decode failure", async () => {
  spyOn(console, "warn").mockImplementation(() => {});
  const worker = new FakeWorker();
  const client = startClient(worker);
  const pending = client.runSummarization({ wait: true });
  worker.emitMessage({ bad: true });
  expect((await pending).status).toBe("error");
  expect(client.getMemoryDiagnostics().status).toBe("stopped");
  await client.stop();
});
