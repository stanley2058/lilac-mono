import { afterEach, describe, expect, test } from "bun:test";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/bun-ws";
import { nativeSyncContract } from "../src/rpc.ts";

const checkpoint = {
  protocolVersion: 1 as const,
  historyGeneration: 0,
  projectionRevision: 4,
  cursor: "opaque-proof-cursor",
};
const unchanged = { kind: "unchanged" as const, checkpoint };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function framedBytes(message: string, masked: boolean): number {
  const bytes = Buffer.byteLength(message);
  const lengthBytes = bytes < 126 ? 0 : bytes < 65536 ? 2 : 8;
  return bytes + 2 + lengthBytes + (masked ? 4 : 0);
}

function connect(
  options: { invalidOutput?: boolean; unavailable?: boolean; checkpoint?: typeof checkpoint } = {},
) {
  const reply = { kind: "unchanged" as const, checkpoint: options.checkpoint ?? checkpoint };
  const received: string[] = [];
  const sent: string[] = [];
  const subscribed = Promise.withResolvers<void>();
  const canceled = Promise.withResolvers<void>();
  const api = implement(nativeSyncContract);
  const router = api.router({
    threads: {
      sync: api.threads.sync.handler(({ errors }) => {
        if (options.unavailable)
          throw errors.NOT_READY({ data: { message: "Native recovery pending" } });
        if (options.invalidOutput)
          return { ...reply, checkpoint: { ...reply.checkpoint, cursor: "" } };
        return reply;
      }),
      watch: api.threads.watch.handler(async function* ({ signal }) {
        subscribed.resolve();
        yield reply;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        canceled.resolve();
      }),
    },
  });
  const handler = new RPCHandler(router);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, message) {
        if (typeof message !== "string") throw new Error("Expected JSON text frame");
        received.push(message);
        return handler.message(ws, message);
      },
      close(ws) {
        handler.close(ws);
      },
    },
  });
  cleanup.push(() => server.stop(true));
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  cleanup.push(() => socket.close());
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") throw new Error("Expected JSON text frame");
    sent.push(event.data);
  });
  const client: ContractRouterClient<typeof nativeSyncContract> = createORPCClient(
    new RPCLink({ websocket: socket }),
  );
  return {
    client,
    socket,
    received,
    sent,
    subscribed: subscribed.promise,
    canceled: canceled.promise,
  };
}

describe("Bun oRPC transport proof", () => {
  test("unchanged reconciliation stays below 1 KiB including masked request framing", async () => {
    const connection = connect();
    expect(await connection.client.threads.sync({ threadId: "thread-1", checkpoint })).toEqual(
      unchanged,
    );
    const bytes =
      connection.received.reduce((n, frame) => n + framedBytes(frame, true), 0) +
      connection.sent.reduce((n, frame) => n + framedBytes(frame, false), 0);
    expect(connection.received.length).toBeGreaterThan(0);
    expect(connection.sent.length).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1024);
    console.info(`native unchanged reconciliation: ${bytes} bytes including WebSocket framing`);
  });

  test("maximum-length identifiers and revisions also fit the unchanged byte budget", async () => {
    const largestCheckpoint = {
      protocolVersion: 1 as const,
      historyGeneration: Number.MAX_SAFE_INTEGER,
      projectionRevision: Number.MAX_SAFE_INTEGER,
      cursor: "c".repeat(128),
    };
    const connection = connect({ checkpoint: largestCheckpoint });
    await connection.client.threads.sync({
      threadId: "t".repeat(128),
      checkpoint: largestCheckpoint,
    });
    const bytes =
      connection.received.reduce((n, frame) => n + framedBytes(frame, true), 0) +
      connection.sent.reduce((n, frame) => n + framedBytes(frame, false), 0);
    expect(bytes).toBeLessThan(1024);
    console.info(
      `native max-length unchanged reconciliation: ${bytes} bytes including WebSocket framing`,
    );
  });

  test("preserves declared domain failures without converting them to a signed-out response", async () => {
    const connection = connect({ unavailable: true });
    await expect(connection.client.threads.sync({ threadId: "thread-1" })).rejects.toMatchObject({
      code: "NOT_READY",
      status: 503,
      data: { message: "Native recovery pending" },
    });
  });

  test("validates inputs and outputs at runtime", async () => {
    const connection = connect({ invalidOutput: true });
    await expect(connection.client.threads.sync({ threadId: "" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(connection.client.threads.sync({ threadId: "thread-1" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  test("cancellation ends subscription", async () => {
    const connection = connect();
    const controller = new AbortController();
    const stream = await connection.client.threads.watch(
      { threadId: "thread-1" },
      { signal: controller.signal },
    );
    await connection.subscribed;
    expect((await stream.next()).value).toEqual(unchanged);
    controller.abort();
    await connection.canceled;
  });

  test("socket loss disposes a subscription", async () => {
    const connection = connect();
    const stream = await connection.client.threads.watch({ threadId: "thread-1" });
    expect((await stream.next()).value).toEqual(unchanged);
    connection.socket.close();
    await connection.canceled;
  });
});
