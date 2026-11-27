import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Panic } from "better-result";
import {
  ConversationThreadSearchPool,
  createThreadSearchTransport,
  type ThreadSearchTransport,
} from "../../src/conversation/thread-search-pool";
import type {
  ThreadSearchRequest,
  ThreadSearchResponse,
} from "../../src/conversation/thread-search-protocol";
import { ConversationThreadStore } from "../../src/conversation/thread-store";

class Transport implements ThreadSearchTransport {
  requests: ThreadSearchRequest[] = [];
  stopped = false;
  message: (event: MessageEvent<unknown>) => void = () => {};
  error: (error: Error) => void = () => {};
  postMessage(request: ThreadSearchRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.stopped = true;
  }
  onMessage(listener: (event: MessageEvent<unknown>) => void) {
    this.message = listener;
  }
  onError(listener: (error: Error) => void) {
    this.error = listener;
  }
  respond(response: ThreadSearchResponse) {
    this.message(new MessageEvent("message", { data: response }));
  }
}
function setup() {
  const transports: Transport[] = [];
  const pool = new ConversationThreadSearchPool({ searchDbPath: "unused" }, () => {
    const transport = new Transport();
    transports.push(transport);
    return transport;
  });
  return { pool, transports };
}
test("dispatches concurrent searches over three workers and correlates out-of-order replies", async () => {
  const { pool, transports } = setup();
  const requests = Array.from({ length: 6 }, () => pool.strings({ type: "prepare" }));
  expect(transports.map((t) => t.requests.length)).toEqual([2, 2, 2]);
  for (const transport of transports.toReversed()) {
    for (const request of transport.requests.toReversed())
      transport.respond({ id: request.id, type: "strings", strings: [request.id] });
  }
  const results = await Promise.all(requests);
  expect(results.map((r) => r[0])).toEqual(
    [0, 1, 2, 0, 1, 2].map((worker, i) => transports[worker]!.requests[Math.floor(i / 3)]!.id),
  );
  pool.close();
  expect(transports.every((t) => t.stopped)).toBe(true);
});
test("shutdown settles in-flight work and rejects subsequent requests", async () => {
  const { pool } = setup();
  const pending = Promise.allSettled([
    pool.strings({ type: "prepare" }),
    pool.strings({ type: "corpus" }),
  ]);
  pool.close();
  pool.close();
  expect((await pending).map((r) => r.status)).toEqual(["rejected", "rejected"]);
  await expect(pool.strings({ type: "prepare" })).rejects.toThrow("stopped");
});
test("worker defects retain Panic identity and stop all workers", async () => {
  const { pool, transports } = setup();
  const pending = pool.strings({ type: "prepare" });
  const check = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  const defect = new Panic({ message: "worker invariant failed" });
  transports[0]!.error(defect);
  expect(await check).toBe(defect);
  await expect(pool.strings({ type: "prepare" })).rejects.toBe(defect);
  expect(transports.every((t) => t.stopped)).toBe(true);
});
test("invalid worker messages reject outstanding requests", async () => {
  const { pool, transports } = setup();
  const check = pool.strings({ type: "prepare" }).then(
    () => undefined,
    (error: Error) => error,
  );
  transports[0]!.message(new MessageEvent("message", { data: { bad: true } }));
  expect((await check)?.message).toBe("Invalid thread search worker response");
  expect(transports.every((t) => t.stopped)).toBe(true);
});
test("persistence failures survive the worker boundary as typed errors", async () => {
  const { pool, transports } = setup();
  const pending = pool.hits({ type: "lexical", query: "test" });
  transports[0]!.respond({
    id: transports[0]!.requests[0]!.id,
    type: "persisted-error",
    error: {
      _tag: "CorruptPersistedFields",
      table: "conversation_thread_summaries",
      field: "topics_json",
      version: 1,
      recordId: "thread",
      issueCode: "invalid-string-array",
      message: "corrupt topics",
    },
  });
  const result = await pending;
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error._tag).toBe("CorruptPersistedFields");
  pool.close();
});
test("startup failure terminates workers already created", () => {
  const transport = new Transport();
  const defect = new Panic({ message: "startup defect" });
  let count = 0;
  let caught: unknown;
  try {
    new ConversationThreadSearchPool({ searchDbPath: "unused" }, () => {
      if (count++ === 0) return transport;
      throw defect;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(defect);
  expect(transport.stopped).toBe(true);
});

test("dispatch defects retain Panic identity", async () => {
  const { pool, transports } = setup();
  const defect = new Panic({ message: "dispatch defect" });
  transports[0]!.postMessage = () => {
    throw defect;
  };
  await expect(pool.strings({ type: "prepare" })).rejects.toBe(defect);
  expect(transports.every((t) => t.stopped)).toBe(true);
});

test("restarts only the slot that trips its memory watchdog and keeps other slots healthy", async () => {
  const { pool, transports } = setup();
  const first = pool.strings({ type: "prepare" });
  const second = pool.strings({ type: "prepare" });
  const third = pool.strings({ type: "prepare" });

  transports[0]!.respond({
    type: "worker-memory",
    at: 1000,
    limitBytes: 512 * 1024 * 1024,
    streak: 1,
    memory: {
      rss: 600 * 1024 * 1024,
      heapUsed: 520 * 1024 * 1024,
      heapTotal: 540 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });
  expect(pool.getMemoryDiagnostics()[0]).toMatchObject({
    status: "running",
    restarts: 0,
    streak: 1,
    lastSampleAt: 1000,
  });

  transports[0]!.respond({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 512 * 1024 * 1024,
    streak: 3,
    reason: "thread-search-worker isolate memory exceeded limit",
    memory: {
      rss: 700 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      heapTotal: 620 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });

  await expect(first).rejects.toThrow("Thread search worker restarted");
  expect(transports).toHaveLength(4);
  expect(transports[0]!.stopped).toBe(true);
  expect(transports[1]!.stopped).toBe(false);
  expect(transports[2]!.stopped).toBe(false);
  expect(transports[3]!.stopped).toBe(false);

  // In-flight requests on unaffected slots still complete cleanly.
  transports[1]!.respond({
    id: transports[1]!.requests[0]!.id,
    type: "strings",
    strings: ["slot-1-ok"],
  });
  transports[2]!.respond({
    id: transports[2]!.requests[0]!.id,
    type: "strings",
    strings: ["slot-2-ok"],
  });
  expect(await second).toEqual(["slot-1-ok"]);
  expect(await third).toEqual(["slot-2-ok"]);

  // A new request routes cleanly to the restarted replacement slot.
  const next = pool.strings({ type: "prepare" });
  const replacementReq = transports[3]!.requests[0]!;
  expect(replacementReq).toBeDefined();
  transports[3]!.respond({ id: replacementReq.id, type: "strings", strings: ["slot-0-restarted"] });
  expect(await next).toEqual(["slot-0-restarted"]);

  expect(pool.getMemoryDiagnostics()[0]).toMatchObject({
    status: "running",
    restarts: 1,
    lastRestartReason: "thread-search-worker isolate memory exceeded limit",
  });
  pool.close();
});

test("keeps surviving slots healthy when restarting one watchdog-killed slot fails", async () => {
  const transports: Transport[] = [];
  let created = 0;
  const pool = new ConversationThreadSearchPool({ searchDbPath: "unused" }, () => {
    created += 1;
    if (created === 4) throw new Error("replacement worker unavailable");
    const transport = new Transport();
    transports.push(transport);
    return transport;
  });

  const first = pool.strings({ type: "prepare" });
  const second = pool.strings({ type: "prepare" });

  transports[0]!.respond({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 512 * 1024 * 1024,
    streak: 3,
    reason: "slot 0 exceeded limit",
    memory: {
      rss: 700 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      heapTotal: 620 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });

  await expect(first).rejects.toThrow("Thread search worker restarted");
  expect(transports[0]!.stopped).toBe(true);
  expect(transports[1]!.stopped).toBe(false);
  expect(transports[2]!.stopped).toBe(false);
  expect(pool.getMemoryDiagnostics().map((entry) => entry.status)).toEqual([
    "stopped",
    "running",
    "running",
  ]);

  transports[1]!.respond({
    id: transports[1]!.requests[0]!.id,
    type: "strings",
    strings: ["slot-1-survived"],
  });
  expect(await second).toEqual(["slot-1-survived"]);

  const followUp = pool.strings({ type: "prepare" });
  const req = transports[1]!.requests.at(-1)!;
  expect(req).toBeDefined();
  transports[1]!.respond({ id: req.id, type: "strings", strings: ["slot-1-follow-up"] });
  expect(await followUp).toEqual(["slot-1-follow-up"]);

  pool.close();
});

test("propagates a Panic from a replacement factory instead of swallowing it", async () => {
  const transports: Transport[] = [];
  const defect = new Panic({ message: "replacement invariant failed" });
  let created = 0;
  const pool = new ConversationThreadSearchPool({ searchDbPath: "unused" }, () => {
    created += 1;
    if (created === 4) throw defect;
    const transport = new Transport();
    transports.push(transport);
    return transport;
  });

  const first = pool.strings({ type: "prepare" });
  transports[0]!.respond({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 512 * 1024 * 1024,
    streak: 3,
    reason: "slot 0 exceeded limit",
    memory: {
      rss: 700 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      heapTotal: 620 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });

  await expect(first).rejects.toThrow("Thread search worker restarted");
  await expect(pool.strings({ type: "prepare" })).rejects.toBe(defect);
  expect(transports.every((t) => t.stopped)).toBe(true);
});

test("retires only the failing replacement slot on ordinary async startup error even after initial memory sample", async () => {
  const { pool, transports } = setup();
  const first = pool.strings({ type: "prepare" });
  const second = pool.strings({ type: "prepare" });

  transports[0]!.respond({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 512 * 1024 * 1024,
    streak: 3,
    reason: "slot 0 exceeded limit",
    memory: {
      rss: 700 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      heapTotal: 620 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });
  await expect(first).rejects.toThrow("Thread search worker restarted");
  expect(transports).toHaveLength(4);

  // Initial watchdog memory sample does not end startup before the first correlated search response.
  transports[3]!.respond({
    type: "worker-memory",
    at: 2500,
    limitBytes: 512 * 1024 * 1024,
    streak: 0,
    memory: {
      rss: 40 * 1024 * 1024,
      heapUsed: 12 * 1024 * 1024,
      heapTotal: 16 * 1024 * 1024,
      external: 0,
      arrayBuffers: 0,
    },
  });

  // Replacement fails with an ordinary startup error before serving its first search response.
  transports[3]!.error(new Error("replacement sqlite open failed"));
  expect(transports[3]!.stopped).toBe(true);
  expect(transports[1]!.stopped).toBe(false);
  expect(transports[2]!.stopped).toBe(false);
  expect(pool.getMemoryDiagnostics().map((entry) => entry.status)).toEqual([
    "stopped",
    "running",
    "running",
  ]);

  transports[1]!.respond({
    id: transports[1]!.requests[0]!.id,
    type: "strings",
    strings: ["slot-1-ok"],
  });
  expect(await second).toEqual(["slot-1-ok"]);
  pool.close();
});

test("stops the pool and preserves Panic identity if a replacement reports a Panic during startup", async () => {
  const { pool, transports } = setup();
  const first = pool.strings({ type: "prepare" });
  transports[0]!.respond({
    type: "worker-watchdog-exceeded",
    at: 2000,
    limitBytes: 512 * 1024 * 1024,
    streak: 3,
    reason: "slot 0 exceeded limit",
    memory: {
      rss: 700 * 1024 * 1024,
      heapUsed: 600 * 1024 * 1024,
      heapTotal: 620 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 0,
    },
  });
  await expect(first).rejects.toThrow("Thread search worker restarted");

  const defect = new Panic({ message: "replacement worker invariant failed" });
  transports[3]!.error(defect);
  await expect(pool.strings({ type: "prepare" })).rejects.toBe(defect);
  expect(transports.every((t) => t.stopped)).toBe(true);
});

test("retires only a real replacement Bun worker whose SQLite open fails with SQLITE_CANTOPEN", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "lilac-search-pool-real-"));
  const realDir = join(rootDir, "real");
  const aliasDir = join(rootDir, "alias");
  mkdirSync(realDir, { recursive: true });
  symlinkSync(realDir, aliasDir, "dir");

  const realDbPath = join(realDir, "search.db");
  const aliasDbPath = join(aliasDir, "search.db");
  const seedStore = new ConversationThreadStore(realDbPath);
  seedStore.close();

  const messageListeners: Array<(event: MessageEvent<unknown>) => void> = [];
  const pool = new ConversationThreadSearchPool({ searchDbPath: aliasDbPath }, () => {
    const transport = createThreadSearchTransport();
    return {
      postMessage: (request) => transport.postMessage(request),
      terminate: () => transport.terminate(),
      onError: (listener) => transport.onError(listener),
      onMessage: (listener) => {
        messageListeners.push(listener);
        transport.onMessage(listener);
      },
    };
  });

  try {
    // Warm all 3 real Bun workers so each opens SQLite and leaves startup state.
    const warmed = await Promise.all([
      pool.strings({ type: "prepare" }),
      pool.strings({ type: "prepare" }),
      pool.strings({ type: "prepare" }),
    ]);
    expect(warmed).toHaveLength(3);
    expect(pool.getMemoryDiagnostics().map((entry) => entry.status)).toEqual([
      "running",
      "running",
      "running",
    ]);

    // Remove the symlinked directory so a freshly spawned replacement hits SQLITE_CANTOPEN.
    unlinkSync(aliasDir);

    // Trip the watchdog on slot 0 so the pool spawns real replacement worker #4.
    messageListeners[0]!(
      new MessageEvent("message", {
        data: {
          type: "worker-watchdog-exceeded",
          at: Date.now(),
          limitBytes: 512 * 1024 * 1024,
          streak: 3,
          reason: "slot 0 exceeded limit",
          memory: {
            rss: 700 * 1024 * 1024,
            heapUsed: 600 * 1024 * 1024,
            heapTotal: 620 * 1024 * 1024,
            external: 10 * 1024 * 1024,
            arrayBuffers: 0,
          },
        },
      }),
    );
    expect(messageListeners).toHaveLength(4);

    // Next search lands on replacement slot 0, fails with SQLITE_CANTOPEN, and retires only slot 0.
    await expect(pool.strings({ type: "prepare" })).rejects.toThrow("SQLITE_CANTOPEN");
    expect(pool.getMemoryDiagnostics().map((entry) => entry.status)).toEqual([
      "stopped",
      "running",
      "running",
    ]);

    // Healthy warmed slots 1 and 2 continue serving searches.
    const followUp = await Promise.all([
      pool.strings({ type: "prepare" }),
      pool.strings({ type: "prepare" }),
    ]);
    expect(followUp).toHaveLength(2);
  } finally {
    pool.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
