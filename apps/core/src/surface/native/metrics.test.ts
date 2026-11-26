import { expect, test } from "bun:test";
import { createNativeMetrics, type NativeMetricSink } from "./metrics";

const checkpoint = {
  protocolVersion: 1,
  historyGeneration: 0,
  projectionRevision: 3,
  cursor: "n_0_3",
};

test("native transport metrics correlate byte counts and commits without logging payloads", () => {
  const events: { event: string; fields: Parameters<NativeMetricSink>[1] }[] = [];
  let time = 10;
  const metrics = createNativeMetrics(
    (event, fields) => events.push({ event, fields }),
    () => time,
  );
  const connection = metrics.connection();
  const request = JSON.stringify({
    i: "private-rpc-id",
    p: {
      u: "/threads/watch",
      h: { authorization: "private-token" },
      b: { json: { threadId: "thread_1", checkpoint, text: "private-input" } },
    },
  });
  connection.received(request);
  metrics.committed("thread_1", 3, 0, "request_1");
  time = 14;
  metrics.committed("thread_1", 3, 0, "request_1");
  const reply = JSON.stringify({
    i: "private-rpc-id",
    t: 3,
    p: {
      e: "message",
      d: {
        json: {
          kind: "replay",
          reply: { kind: "window", checkpoint, slots: [{ text: "private-output" }] },
        },
      },
    },
  });
  connection.sent(reply, -1);
  connection.closed(1000);
  expect(events.find((item) => item.event === "replay.enqueue")?.fields).toMatchObject({
    threadId: "thread_1",
    requestId: "request_1",
    bytes: Buffer.byteLength(reply),
    cacheReset: true,
    commitToSocketEnqueueMs: 4,
  });
  expect(events.find((item) => item.event === "connection.close")?.fields).toMatchObject({
    receivedBytes: Buffer.byteLength(request),
    sentBytes: Buffer.byteLength(reply),
    durationMs: 4,
  });
  expect(events.map((item) => item.event)).not.toContain("connection.send");
  expect(events.map((item) => item.event)).not.toContain("connection.request");
  const serialized = JSON.stringify(events);
  for (const secret of ["private-rpc-id", "private-token", "private-input", "private-output"])
    expect(serialized).not.toContain(secret);
});

test("mismatched replay revisions and rejected sends never report commit latency", () => {
  const events: { event: string; fields: Parameters<NativeMetricSink>[1] }[] = [];
  const metrics = createNativeMetrics((event, fields) => events.push({ event, fields }));
  const connection = metrics.connection();
  connection.received(
    JSON.stringify({ i: "1", p: { u: "/threads/sync", b: { json: { threadId: "thread_1" } } } }),
  );
  metrics.committed("thread_1", 4, 0, "newer_request");
  const reply = JSON.stringify({ i: "1", p: { b: { json: { kind: "window", checkpoint } } } });
  connection.sent(reply, 0);
  expect(events.some((item) => item.event === "replay.enqueue")).toBe(false);
  connection.received(
    JSON.stringify({ i: "1", p: { u: "/threads/sync", b: { json: { threadId: "thread_1" } } } }),
  );
  connection.sent(reply, 12);
  const replay = events.find((item) => item.event === "replay.enqueue")?.fields;
  expect(replay?.commitToSocketEnqueueMs).toBeUndefined();
  expect(replay?.requestId).toBeUndefined();
  expect(replay?.cacheReset).toBe(false);
});

test("queue and handoff metrics have fixed labels and numeric pressure", () => {
  const events: { event: string; fields: Parameters<NativeMetricSink>[1] }[] = [];
  const metrics = createNativeMetrics((event, fields) => events.push({ event, fields }));
  metrics.queue("thread_1", 1, 2, 3);
  metrics.handoffFailure("admission", "thread_1", "request_1");
  metrics.bootstrap(7, 401);
  expect(events).toEqual([
    {
      event: "queue.pressure",
      fields: { threadId: "thread_1", uploading: 1, queued: 2, admitted: 3 },
    },
    {
      event: "handoff.failed",
      fields: { stage: "admission", threadId: "thread_1", requestId: "request_1" },
    },
    { event: "bootstrap.complete", fields: { durationMs: 7, status: 401 } },
  ]);
});
