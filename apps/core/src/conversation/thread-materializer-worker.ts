import { createLogger } from "@stanley2058/lilac-utils/logging";
import { formatTaggedErrorForLog } from "@stanley2058/lilac-utils/tagged-error-log";
import { Panic, Result } from "better-result";

import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  createThreadMaterializer,
  ThreadMaterializerOperationFailed,
  type ThreadMaterializer,
  type ThreadMaterializerErrorContext,
} from "./thread-materializer";
import {
  decodeThreadMaterializerWorkerResponse,
  type ThreadMaterializerWorkerRequest,
  type ThreadMaterializerWorkerResponse,
} from "./thread-materializer-worker-protocol";
import {
  createWorkerMemoryTracker,
  DEFAULT_MATERIALIZER_WORKER_MAX_ISOLATE_BYTES,
  type WorkerMemoryDiagnostics,
} from "./worker-memory-watchdog";

type PendingRequest =
  | {
      type: "list-channels";
      resolve: (channelIds: readonly string[]) => void;
      reject: (error: Error) => void;
    }
  | {
      type: "repair-channel";
      resolve: () => void;
      reject: (error: Error) => void;
    };

export type ConversationThreadMaterializer = ThreadMaterializer & {
  invalidate(): void;
  getMemoryDiagnostics(): WorkerMemoryDiagnostics;
};

export type ThreadMaterializerWorkerHost = {
  setMessageHandler(handler: (event: MessageEvent<unknown>) => void): void;
  setErrorHandler(handler: (event: ErrorEvent) => void): void;
  postMessage(request: ThreadMaterializerWorkerRequest): void;
  terminate(): void;
};

function createThreadMaterializerWorkerHost(): ThreadMaterializerWorkerHost {
  const worker = new Worker(new URL("./thread-materializer-worker-isolate.ts", import.meta.url), {
    type: "module",
  });
  return {
    setMessageHandler(handler) {
      worker.onmessage = handler;
    },
    setErrorHandler(handler) {
      worker.onerror = handler;
    },
    postMessage(request) {
      worker.postMessage(request);
    },
    terminate() {
      worker.terminate();
    },
  };
}

export function startConversationThreadMaterializer(params: {
  searchDbPath: string;
  surfaceDbPath?: string;
  debounceMs?: number;
  workerFactory?: () => ThreadMaterializerWorkerHost;
}): ConversationThreadMaterializer {
  const logger = createLogger({ module: "conversation-thread-materializer-worker-client" });
  const createWorker = params.workerFactory ?? createThreadMaterializerWorkerHost;
  let worker: ThreadMaterializerWorkerHost | null = createWorker();
  const pending = new Map<string, PendingRequest>();
  let stopped = false;
  const refreshedChannels = new Set<string>();
  let refreshGeneration = 0;
  const memoryTracker = createWorkerMemoryTracker(DEFAULT_MATERIALIZER_WORKER_MAX_ISOLATE_BYTES);
  const invalidate = () => {
    refreshGeneration += 1;
    refreshedChannels.clear();
  };

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const spawnReplacementWorker = (): Result<
    ThreadMaterializerWorkerHost,
    ThreadMaterializerOperationFailed
  > => {
    const created = Result.try({
      try: () => createWorker(),
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    if (created.isErr()) {
      const cause = created.error.restoreCause();
      if (Panic.is(cause)) return adaptToolResultToHost(Result.err(cause));
      return Result.err(
        new ThreadMaterializerOperationFailed({
          operation: "worker-watchdog",
          message:
            cause instanceof Error
              ? cause.message
              : "conversation thread materializer worker restart failed",
        }),
      );
    }
    worker = created.value;
    configureWorker(worker);
    return Result.ok(worker);
  };

  const restartWorker = (error: Error, restartReason: string = error.message) => {
    rejectPending(error);
    if (stopped) return;
    const retired = worker;
    worker = null;
    retired?.terminate();
    memoryTracker.recordRestart(restartReason);
    invalidate();

    const replaced = spawnReplacementWorker();
    if (replaced.isErr()) {
      logger.error(
        "conversation thread materializer worker replacement failed",
        formatTaggedErrorForLog(replaced.error),
      );
    }
  };

  function handleWorkerResponse(response: ThreadMaterializerWorkerResponse): void {
    if ("type" in response && response.type === "worker-memory") {
      memoryTracker.recordSample(response);
      return;
    }
    if ("type" in response && response.type === "worker-watchdog-exceeded") {
      memoryTracker.recordSample(response);
      logger.warn(
        "conversation thread materializer worker exceeded memory watchdog limit; restarting worker",
        { reason: response.reason, memory: response.memory, limitBytes: response.limitBytes },
      );
      restartWorker(
        new ThreadMaterializerOperationFailed({
          operation: "worker-watchdog",
          message: response.reason,
        }),
      );
      return;
    }
    const request = pending.get(response.id);
    if (!request) {
      const error = new ThreadMaterializerOperationFailed({
        operation: "worker-protocol",
        message: "conversation thread materializer worker response had no pending request",
      });
      logger.warn("conversation thread materializer worker response had no pending request", {
        requestId: response.id,
      });
      restartWorker(error);
      return;
    }
    pending.delete(response.id);

    if (!response.ok) {
      request.reject(
        new ThreadMaterializerOperationFailed({
          operation: request.type === "list-channels" ? "list-channels" : "repair-channel",
          message: response.error,
        }),
      );
      return;
    }
    if (request.type === "list-channels" && response.type === "list-channels") {
      request.resolve(response.channelIds);
      return;
    }
    if (request.type === "repair-channel" && response.type === "repair-channel") {
      request.resolve();
      return;
    }

    const error = new ThreadMaterializerOperationFailed({
      operation: "worker-protocol",
      message: "conversation thread materializer worker response type mismatch",
    });
    request.reject(error);
    restartWorker(error);
  }

  function configureWorker(target: ThreadMaterializerWorkerHost): void {
    target.setMessageHandler((event) => {
      if (target !== worker) return;
      const decoded = decodeThreadMaterializerWorkerResponse(event.data);
      const outcome = decoded.match<
        | { readonly ok: true; readonly response: ThreadMaterializerWorkerResponse }
        | { readonly ok: false }
      >({
        ok: (response) => ({ ok: true, response }),
        err: () => ({ ok: false }),
      });
      if (!outcome.ok) {
        const error = new ThreadMaterializerOperationFailed({
          operation: "worker-protocol",
          message: "conversation thread materializer worker sent an invalid response",
        });
        logger.error(
          "conversation thread materializer worker protocol error",
          formatTaggedErrorForLog(error),
        );
        restartWorker(error);
        return;
      }
      handleWorkerResponse(outcome.response);
    });

    target.setErrorHandler((event) => {
      if (target !== worker) return;
      const error = new Error(event.message || "conversation thread materializer worker failed");
      logger.error("conversation thread materializer worker error", error);
      restartWorker(error, "conversation thread materializer worker error");
    });
  }
  configureWorker(worker);

  const postRequest = (
    request: ThreadMaterializerWorkerRequest,
    pendingRequest: PendingRequest,
  ) => {
    if (stopped) {
      pendingRequest.reject(
        new ThreadMaterializerOperationFailed({
          operation: "worker-stopped",
          message: "conversation thread materializer worker stopped",
        }),
      );
      return;
    }
    let activeWorker = worker;
    if (!activeWorker) {
      const respawned = spawnReplacementWorker();
      if (respawned.isErr()) {
        pendingRequest.reject(respawned.error);
        return;
      }
      activeWorker = respawned.value;
    }
    pending.set(request.id, pendingRequest);
    const posted = Result.try({
      try: () => activeWorker.postMessage(request),
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    if (posted.isErr()) {
      const error = posted.error.restoreCause();
      pending.delete(request.id);
      if (Panic.is(error)) return adaptToolResultToHost(Result.err(error));
      if (!(error instanceof Error)) {
        return adaptToolResultToHost(
          Result.err(
            new Panic({
              message: "Conversation thread materializer worker postMessage defect",
              cause: error,
            }),
          ),
        );
      }
      pendingRequest.reject(error);
    }
  };

  const listChannelIds = () =>
    new Promise<readonly string[]>((resolve, reject) => {
      const request = {
        id: crypto.randomUUID(),
        type: "list-channels",
        searchDbPath: params.searchDbPath,
        surfaceDbPath: params.surfaceDbPath,
      } satisfies ThreadMaterializerWorkerRequest;
      postRequest(request, { type: request.type, resolve, reject });
    });

  const repairChannel = (
    requested:
      | { channelId: string; kind: "topology" }
      | { channelId: string; kind: "content"; messageIds: readonly string[] },
  ) => {
    const generation = refreshGeneration;
    const input = refreshedChannels.has(requested.channelId)
      ? requested
      : { channelId: requested.channelId, kind: "topology" as const };
    return new Promise<void>((resolve, reject) => {
      let request: Extract<ThreadMaterializerWorkerRequest, { type: "repair-channel" }>;
      switch (input.kind) {
        case "content":
          request = {
            id: crypto.randomUUID(),
            type: "repair-channel",
            searchDbPath: params.searchDbPath,
            surfaceDbPath: params.surfaceDbPath,
            channelId: input.channelId,
            kind: "content",
            messageIds: [...input.messageIds],
          };
          break;
        case "topology":
          request = {
            id: crypto.randomUUID(),
            type: "repair-channel",
            searchDbPath: params.searchDbPath,
            surfaceDbPath: params.surfaceDbPath,
            channelId: input.channelId,
            kind: "topology",
          };
          break;
      }
      postRequest(request, { type: request.type, resolve, reject });
    }).then(() => {
      if (generation === refreshGeneration) refreshedChannels.add(input.channelId);
    });
  };

  const onError = (error: Error, context: ThreadMaterializerErrorContext) => {
    if (context.operation === "repair-channel") refreshedChannels.delete(context.channelId);
    logger.error("conversation thread materialization failed", context, error);
  };

  const startedCoalescer = createThreadMaterializer({
    repairChannel,
    listChannelIds,
    debounceMs: params.debounceMs,
    onError,
  });

  let stopPromise: Promise<void> | null = null;
  return {
    invalidate,
    getMemoryDiagnostics() {
      return memoryTracker.snapshot(stopped || !worker ? "stopped" : "running");
    },
    markDirty: (input) => startedCoalescer.markDirty(input),
    markAllDirty: () => startedCoalescer.markAllDirty(),
    flush: () => startedCoalescer.flush(),
    hasIncompleteWork: () => startedCoalescer.hasIncompleteWork(),
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = startedCoalescer.stop().finally(() => {
        stopped = true;
        const retired = worker;
        worker = null;
        retired?.terminate();
        rejectPending(
          new ThreadMaterializerOperationFailed({
            operation: "worker-stopped",
            message: "conversation thread materializer worker stopped",
          }),
        );
        logger.debug("conversation thread materializer worker stopped");
      });
      return stopPromise;
    },
  };
}
