import { Result, type Result as ResultType } from "better-result";
import type { ResponsesServerEvent } from "openai/resources/responses/responses";
import type { OpenAIResponsesConnectionOptions } from "@stanley2058/lilac-utils/openai-responses-connection";
import { AgentAdapterFailure } from "../../agent-adapter";
import { resultOutcome } from "../../agent-runtime-support";
import {
  captureAgentOperation,
  captureAgentPromise,
  rethrowAgentPanic,
  type OpaqueAgentValue,
} from "../../failure-adapters";
import {
  createOpenAIResponsesConnect,
  type OpenAIResponsesConnect,
  type OpenAIResponsesSocket,
} from "./socket";

type SocketEvent = ResultType<ResponsesServerEvent, AgentAdapterFailure>;
type Read =
  | { kind: "event"; event: SocketEvent }
  | { kind: "failure"; cause: OpaqueAgentValue }
  | { kind: "done" };
type Consumer = {
  queue: Read[];
  pending: Array<(read: Read) => void>;
  released: boolean;
  ended: boolean;
};
type Connection = {
  id: number;
  key: string;
  socket: OpenAIResponsesSocket;
  healthy: boolean;
  consumer?: Consumer;
};

export interface OpenAIResponsesLease extends OpenAIResponsesSocket {
  readonly connectionId: number;
  readonly reusable: boolean;
  release(options: { reusable: boolean }): void;
}

export function createOpenAIResponsesConnectionPool(options?: {
  idleTimeoutMs?: number;
  connect?: (options: OpenAIResponsesConnectionOptions) => OpenAIResponsesConnect;
  scheduleIdleClose?: (close: () => void, milliseconds: number) => () => void;
}) {
  const connections = new Set<Connection>();
  const connecting = new Set<AbortController>();
  let nextId = 0;
  let reusable: Connection | undefined;
  let busy = false;
  let disposed = false;
  let cancelIdleClose: (() => void) | undefined;
  const idleTimeoutMs = options?.idleTimeoutMs ?? 30_000;

  function clearIdleClose() {
    cancelIdleClose?.();
    cancelIdleClose = undefined;
  }

  function closeConnection(connection: Connection) {
    connection.healthy = false;
    connections.delete(connection);
    if (reusable === connection) reusable = undefined;
    releaseConsumer(connection);
    const closed = resultOutcome(captureAgentOperation(() => connection.socket.close()));
    if (!closed.ok) rethrowAgentPanic(closed.error);
  }

  function scheduleIdleClose(connection: Connection) {
    clearIdleClose();
    if (idleTimeoutMs <= 0) {
      closeConnection(connection);
      return;
    }
    const schedule = options?.scheduleIdleClose ?? scheduleTimer;
    cancelIdleClose = schedule(() => {
      cancelIdleClose = undefined;
      if (!busy && reusable === connection) closeConnection(connection);
    }, idleTimeoutMs);
  }

  function lease(connection: Connection, pooled: boolean): OpenAIResponsesLease {
    const consumer: Consumer = { queue: [], pending: [], released: false, ended: false };
    connection.consumer = consumer;
    const release = (reuse: boolean) => {
      if (consumer.released) return;
      releaseConsumer(connection);
      if (pooled) busy = false;
      if (!reuse || !pooled || !connection.healthy || disposed) {
        closeConnection(connection);
        return;
      }
      scheduleIdleClose(connection);
    };
    return {
      connectionId: connection.id,
      reusable: pooled,
      events: {
        [Symbol.asyncIterator]() {
          return {
            next: () => readConsumer(consumer),
            return: async () => ({ done: true, value: undefined }),
          };
        },
      },
      send(payload) {
        if (consumer.released || !connection.healthy) return Result.err(unavailable());
        const sent = connection.socket.send(payload);
        const outcome = resultOutcome(sent);
        if (!outcome.ok) connection.healthy = false;
        return sent;
      },
      isOpen: () => !consumer.released && isOpen(connection),
      close: () => release(false),
      release: ({ reusable: reuse }) => release(reuse),
    };
  }

  async function connect(
    settings: OpenAIResponsesConnectionOptions,
    signal: AbortSignal,
  ): Promise<ResultType<OpenAIResponsesLease, AgentAdapterFailure>> {
    if (disposed || signal.aborted) {
      const reason: OpaqueAgentValue = signal.reason;
      rethrowAgentPanic(reason);
      return Result.err(unavailable("safe"));
    }
    const pooled = !busy;
    if (pooled) {
      busy = true;
      clearIdleClose();
    }
    const key = connectionKey(settings);
    if (pooled && reusable && reusable.key === key && isOpen(reusable)) {
      return Result.ok(lease(reusable, true));
    }
    if (pooled && reusable) {
      const previous = reusable;
      const closed = resultOutcome(captureAgentOperation(() => closeConnection(previous)));
      if (!closed.ok) {
        busy = false;
        rethrowAgentPanic(closed.error);
      }
    }
    const controller = new AbortController();
    connecting.add(controller);
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const captured = resultOutcome(
      await captureAgentPromise(() =>
        (options?.connect ?? createOpenAIResponsesConnect)(settings)(controller.signal),
      ),
    );
    signal.removeEventListener("abort", abort);
    connecting.delete(controller);
    if (!captured.ok) {
      if (pooled) busy = false;
      rethrowAgentPanic(captured.error);
      return Result.err(unavailable("safe", captured.error));
    }
    const opened = resultOutcome(captured.value);
    if (!opened.ok) {
      if (pooled) busy = false;
      return Result.err(opened.error);
    }
    const connection: Connection = {
      id: ++nextId,
      key,
      socket: opened.value,
      healthy: true,
    };
    if (disposed || controller.signal.aborted) {
      if (pooled) busy = false;
      const closed = resultOutcome(captureAgentOperation(() => closeConnection(connection)));
      const reason: OpaqueAgentValue = controller.signal.reason;
      rethrowAgentPanic(reason);
      if (!closed.ok) rethrowAgentPanic(closed.error);
      return Result.err(unavailable("safe"));
    }
    connections.add(connection);
    if (pooled) reusable = connection;
    const result = lease(connection, pooled);
    void pump(connection);
    return Result.ok(result);
  }

  function close() {
    if (disposed) return;
    disposed = true;
    clearIdleClose();
    for (const controller of connecting) controller.abort();
    const failures: OpaqueAgentValue[] = [];
    for (const connection of connections) {
      const closed = resultOutcome(captureAgentOperation(() => closeConnection(connection)));
      if (!closed.ok) failures.push(closed.error);
    }
    for (const failure of failures) rethrowAgentPanic(failure);
  }

  return { connect, close };
}

function connectionKey(settings: OpenAIResponsesConnectionOptions): string {
  const headers = [...new Headers(settings.headers).entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify([settings.websocketUrl, headers]);
}

function isOpen(connection: Connection): boolean {
  return connection.healthy && (connection.socket.isOpen?.() ?? true);
}

function scheduleTimer(close: () => void, milliseconds: number): () => void {
  const timer = setTimeout(close, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
}

function releaseConsumer(connection: Connection) {
  const consumer = connection.consumer;
  connection.consumer = undefined;
  if (!consumer) return;
  consumer.released = true;
  consumer.queue = [];
  for (const resolve of consumer.pending.splice(0)) resolve({ kind: "done" });
}

function publish(connection: Connection, read: Read) {
  const consumer = connection.consumer;
  if (!consumer || consumer.released) return;
  if (read.kind !== "event" || !resultOutcome(read.event).ok) consumer.ended = true;
  const resolve = consumer.pending.shift();
  if (resolve) resolve(read);
  else consumer.queue.push(read);
  if (consumer.ended) {
    for (const pending of consumer.pending.splice(0)) pending({ kind: "done" });
  }
}

async function pump(connection: Connection) {
  const created = resultOutcome(
    captureAgentOperation(() => connection.socket.events[Symbol.asyncIterator]()),
  );
  if (!created.ok) {
    connection.healthy = false;
    publish(connection, { kind: "failure", cause: created.error });
    return;
  }
  const iterator = created.value;
  while (connection.healthy) {
    const received = resultOutcome(await captureAgentPromise(() => iterator.next()));
    if (!connection.healthy) return;
    if (!received.ok) {
      connection.healthy = false;
      publish(connection, { kind: "failure", cause: received.error });
      return;
    }
    if (received.value.done) {
      connection.healthy = false;
      publish(connection, { kind: "done" });
      return;
    }
    const event = received.value.value;
    const outcome = resultOutcome(event);
    if (!outcome.ok) connection.healthy = false;
    publish(connection, { kind: "event", event });
  }
}

async function readConsumer(consumer: Consumer): Promise<IteratorResult<SocketEvent>> {
  if (consumer.released) return { done: true, value: undefined };
  const queued = consumer.queue.shift();
  if (!queued && consumer.ended) return { done: true, value: undefined };
  const read =
    queued ??
    (await new Promise<Read>((resolve) => {
      consumer.pending.push(resolve);
    }));
  if (read.kind === "done") return { done: true, value: undefined };
  if (read.kind === "failure") {
    rethrowAgentPanic(read.cause);
    return { done: false, value: Result.err(unavailable("reconcile", read.cause)) };
  }
  return { done: false, value: read.event };
}

function unavailable(
  replaySafety: "safe" | "reconcile" = "reconcile",
  cause?: OpaqueAgentValue,
): AgentAdapterFailure {
  return new AgentAdapterFailure({
    reason: "unavailable",
    message: "OpenAI WebSocket connection is unavailable",
    replaySafety,
    cause,
  });
}
