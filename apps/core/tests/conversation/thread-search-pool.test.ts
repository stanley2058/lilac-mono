import { expect, test } from "bun:test";
import { Panic } from "better-result";
import {
  ConversationThreadSearchPool,
  type ThreadSearchTransport,
} from "../../src/conversation/thread-search-pool";
import type {
  ThreadSearchRequest,
  ThreadSearchResponse,
} from "../../src/conversation/thread-search-protocol";

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
