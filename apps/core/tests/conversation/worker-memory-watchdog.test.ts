import { describe, expect, it, spyOn } from "bun:test";

import {
  startConversationThreadMaterializer,
  type ThreadMaterializerWorkerHost,
} from "../../src/conversation/thread-materializer-worker";
import type { ThreadMaterializerWorkerRequest } from "../../src/conversation/thread-materializer-worker-protocol";
import {
  startWorkerMemoryWatchdog,
  type WorkerMemoryUsage,
  type WorkerMemoryWatchdogEvent,
} from "../../src/conversation/worker-memory-watchdog";

const MiB = 1024 * 1024;

function mem(heapUsedMiB: number, rssMiB = heapUsedMiB + 50): WorkerMemoryUsage {
  return {
    rss: rssMiB * MiB,
    heapUsed: heapUsedMiB * MiB,
    heapTotal: heapUsedMiB * MiB,
    external: 0,
    arrayBuffers: 0,
  };
}

class FakeMaterializerWorkerHost implements ThreadMaterializerWorkerHost {
  readonly requests: ThreadMaterializerWorkerRequest[] = [];
  terminated = false;
  private onMessage: (event: MessageEvent<unknown>) => void = () => {};
  private onError: (event: ErrorEvent) => void = () => {};

  setMessageHandler(handler: (event: MessageEvent<unknown>) => void): void {
    this.onMessage = handler;
  }

  setErrorHandler(handler: (event: ErrorEvent) => void): void {
    this.onError = handler;
  }

  postMessage(request: ThreadMaterializerWorkerRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    this.onMessage(new MessageEvent("message", { data }));
  }

  emitError(message: string): void {
    this.onError(new ErrorEvent("error", { message }));
  }
}

describe("worker memory watchdog", () => {
  it("tracks consecutive isolate breaches, resets on recovery, and triggers once at threshold", () => {
    const events: WorkerMemoryWatchdogEvent[] = [];
    let exceededCount = 0;
    let current = mem(200);
    let tick = 1000;

    const watchdog = startWorkerMemoryWatchdog({
      workerName: "test-worker",
      maxIsolateBytes: 512 * MiB,
      intervalMs: 60_000,
      failureThreshold: 3,
      sampleMemory: () => current,
      now: () => tick,
      emit: (event) => events.push(event),
      onExceeded: () => {
        exceededCount += 1;
      },
    });

    // Initial sample is healthy.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "worker-memory", streak: 0 });

    // Two breaches followed by recovery resets streak.
    current = mem(600);
    tick = 2000;
    watchdog.sampleNow();
    tick = 3000;
    watchdog.sampleNow();
    current = mem(300);
    tick = 4000;
    watchdog.sampleNow();
    expect(exceededCount).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "worker-memory", streak: 0 });

    // Three consecutive breaches trigger exceeded and stop further sampling.
    current = mem(512);
    tick = 5000;
    watchdog.sampleNow();
    tick = 6000;
    watchdog.sampleNow();
    tick = 7000;
    watchdog.sampleNow();
    expect(exceededCount).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "worker-watchdog-exceeded",
      streak: 3,
      limitBytes: 512 * MiB,
    });

    const countAfterExceeded = events.length;
    watchdog.sampleNow();
    expect(events).toHaveLength(countAfterExceeded);
    watchdog.stop();
  });

  it("restarts the materializer worker when its memory watchdog trips and records diagnostics", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    const hosts: FakeMaterializerWorkerHost[] = [];
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/data/search.db",
      debounceMs: 0,
      workerFactory: () => {
        const host = new FakeMaterializerWorkerHost();
        hosts.push(host);
        return host;
      },
    });

    hosts[0]!.emit({
      type: "worker-memory",
      at: 1000,
      limitBytes: 512 * MiB,
      streak: 1,
      memory: mem(520),
    });
    expect(materializer.getMemoryDiagnostics()).toMatchObject({
      status: "running",
      restarts: 0,
      streak: 1,
      lastSampleAt: 1000,
    });

    materializer.markDirty({ channelId: "c1", kind: "topology" });
    const flushed = materializer.flush();
    // Wait a microtask so the request is posted to hosts[0].
    await Promise.resolve();
    expect(hosts[0]!.requests).toHaveLength(1);

    hosts[0]!.emit({
      type: "worker-watchdog-exceeded",
      at: 2000,
      limitBytes: 512 * MiB,
      streak: 3,
      reason: "thread-materializer-worker isolate memory exceeded limit",
      memory: mem(600),
    });

    await flushed;
    expect(hosts).toHaveLength(2);
    expect(hosts[0]!.terminated).toBe(true);
    expect(hosts[1]!.terminated).toBe(false);
    expect(materializer.hasIncompleteWork()).toBe(true);
    expect(materializer.getMemoryDiagnostics()).toMatchObject({
      status: "running",
      restarts: 1,
      lastRestartReason: "thread-materializer-worker isolate memory exceeded limit",
    });

    // Subsequent repairs succeed on the replacement worker.
    materializer.markDirty({ channelId: "c1", kind: "topology" });
    const retryFlush = materializer.flush();
    await Promise.resolve();
    const retryReq = hosts[1]!.requests.at(-1)!;
    hosts[1]!.emit({ id: retryReq.id, ok: true, type: "repair-channel" });
    await retryFlush;
    expect(materializer.hasIncompleteWork()).toBe(false);

    await materializer.stop();
    expect(materializer.getMemoryDiagnostics().status).toBe("stopped");
  });

  it("keeps hasIncompleteWork true if channel listing fails during a watchdog restart", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    const hosts: FakeMaterializerWorkerHost[] = [];
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/data/search.db",
      debounceMs: 0,
      workerFactory: () => {
        const host = new FakeMaterializerWorkerHost();
        hosts.push(host);
        return host;
      },
    });

    materializer.markAllDirty();
    const flushed = materializer.flush();
    await Promise.resolve();
    expect(hosts[0]!.requests[0]?.type).toBe("list-channels");

    hosts[0]!.emit({
      type: "worker-watchdog-exceeded",
      at: 2000,
      limitBytes: 512 * 1024 * 1024,
      streak: 3,
      reason: "materializer exceeded limit while listing",
      memory: mem(600),
    });

    await flushed;
    expect(materializer.hasIncompleteWork()).toBe(true);
    await materializer.stop();
  });

  it("keeps hasIncompleteWork true when a watchdog trip happens after stop begins", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    const hosts: FakeMaterializerWorkerHost[] = [];
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/data/search.db",
      debounceMs: 0,
      workerFactory: () => {
        const host = new FakeMaterializerWorkerHost();
        hosts.push(host);
        return host;
      },
    });

    materializer.markDirty({ channelId: "c1", kind: "topology" });
    const flushed = materializer.flush();
    await Promise.resolve();
    expect(hosts[0]!.requests).toHaveLength(1);

    const stopping = materializer.stop();
    hosts[0]!.emit({
      type: "worker-watchdog-exceeded",
      at: 2000,
      limitBytes: 512 * 1024 * 1024,
      streak: 3,
      reason: "materializer exceeded limit during shutdown",
      memory: mem(600),
    });

    await flushed;
    expect(materializer.hasIncompleteWork()).toBe(true);
    await stopping;
  });

  it("recovers cleanly when materializer replacement spawn fails transiently after a watchdog trip", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    const hosts: FakeMaterializerWorkerHost[] = [];
    let attempts = 0;
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/data/search.db",
      debounceMs: 0,
      workerFactory: () => {
        attempts += 1;
        if (attempts === 2) throw new Error("spawn temporarily unavailable");
        const host = new FakeMaterializerWorkerHost();
        hosts.push(host);
        return host;
      },
    });

    materializer.markDirty({ channelId: "c1", kind: "topology" });
    const firstFlush = materializer.flush();
    await Promise.resolve();
    expect(hosts[0]!.requests).toHaveLength(1);

    // Watchdog trip triggers replacement, which fails once without throwing or leaving hosts[0] active.
    hosts[0]!.emit({
      type: "worker-watchdog-exceeded",
      at: 2000,
      limitBytes: 512 * 1024 * 1024,
      streak: 3,
      reason: "materializer exceeded limit",
      memory: mem(600),
    });
    await firstFlush;
    expect(hosts[0]!.terminated).toBe(true);
    expect(materializer.getMemoryDiagnostics().status).toBe("stopped");

    // Next repair spawns a fresh worker (attempt 3) and succeeds.
    materializer.markDirty({ channelId: "c1", kind: "topology" });
    const secondFlush = materializer.flush();
    await Promise.resolve();
    expect(hosts).toHaveLength(2);
    expect(materializer.getMemoryDiagnostics().status).toBe("running");
    const nextReq = hosts[1]!.requests.at(-1)!;
    hosts[1]!.emit({ id: nextReq.id, ok: true, type: "repair-channel" });
    await secondFlush;
    expect(materializer.hasIncompleteWork()).toBe(false);
    await materializer.stop();
  });

  it("preserves Panic identity when materializer replacement factory throws a Panic", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const { Panic } = await import("better-result");
    const defect = new Panic({ message: "materializer replacement invariant failed" });
    const hosts: FakeMaterializerWorkerHost[] = [];
    let attempts = 0;
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/data/search.db",
      debounceMs: 0,
      workerFactory: () => {
        attempts += 1;
        if (attempts === 2) throw defect;
        const host = new FakeMaterializerWorkerHost();
        hosts.push(host);
        return host;
      },
    });

    let caught: unknown;
    try {
      hosts[0]!.emit({
        type: "worker-watchdog-exceeded",
        at: 2000,
        limitBytes: 512 * 1024 * 1024,
        streak: 3,
        reason: "materializer exceeded limit",
        memory: mem(600),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(defect);
    await materializer.stop();
  });

  it("uses a fixed restart reason for raw materializer worker errors instead of exposing raw error text", async () => {
    spyOn(console, "error").mockImplementation(() => {});
    const hosts: FakeMaterializerWorkerHost[] = [];
    const materializer = startConversationThreadMaterializer({
      searchDbPath: "/data/search.db",
      debounceMs: 0,
      workerFactory: () => {
        const host = new FakeMaterializerWorkerHost();
        hosts.push(host);
        return host;
      },
    });

    hosts[0]!.emitError(
      "Error: boom\n    at /home/secret/project/apps/core/src/conversation/thread-materializer-worker-isolate.ts:42:9",
    );
    expect(hosts).toHaveLength(2);
    expect(materializer.getMemoryDiagnostics()).toMatchObject({
      status: "running",
      restarts: 1,
      lastRestartReason: "conversation thread materializer worker error",
    });
    expect(materializer.getMemoryDiagnostics().lastRestartReason).not.toContain("/home/secret/");
    await materializer.stop();
  });

  it("emits worker-watchdog-exceeded cleanly from a real Bun Worker without throwing", async () => {
    const watchdogModule = new URL(
      "../../src/conversation/worker-memory-watchdog.ts",
      import.meta.url,
    ).href;
    const script = `
      import { startWorkerMemoryWatchdog } from ${JSON.stringify(watchdogModule)};
      self.addEventListener("message", () => {});
      startWorkerMemoryWatchdog({
        workerName: "real-bun-worker-test",
        maxIsolateBytes: 1,
        intervalMs: 1,
        failureThreshold: 2,
        emit: (event) => postMessage(event),
      });
    `;
    const workerUrl = URL.createObjectURL(new Blob([script], { type: "application/typescript" }));
    const worker = new Worker(workerUrl, { type: "module" });
    const errors: unknown[] = [];
    const exceeded = Promise.withResolvers<WorkerMemoryWatchdogEvent>();
    worker.onerror = (event) => {
      errors.push(event.error ?? event.message);
      exceeded.reject(new Error(event.message || "worker error"));
    };
    worker.onmessage = (event: MessageEvent<WorkerMemoryWatchdogEvent>) => {
      if (event.data.type === "worker-watchdog-exceeded") {
        exceeded.resolve(event.data);
      }
    };
    try {
      const event = await exceeded.promise;
      expect(event.type).toBe("worker-watchdog-exceeded");
      expect(event.streak).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  });
});
