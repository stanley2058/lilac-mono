import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
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
} from "./thread-materializer-worker-protocol";

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
  let worker = createWorker();
  const pending = new Map<string, PendingRequest>();
  let stopped = false;
  const refreshedChannels = new Set<string>();
  let refreshGeneration = 0;
  const invalidate = () => {
    refreshGeneration += 1;
    refreshedChannels.clear();
  };

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  const restartWorker = (error: Error) => {
    rejectPending(error);
    if (stopped) return;
    worker.terminate();
    worker = createWorker();
    configureWorker(worker);
    invalidate();
  };

  function configureWorker(target: ThreadMaterializerWorkerHost): void {
    target.setMessageHandler((event) => {
      if (target !== worker) return;
      const decoded = decodeThreadMaterializerWorkerResponse(event.data);
      decoded.match({
        err: () => {
          const error = new ThreadMaterializerOperationFailed({
            operation: "worker-protocol",
            message: "conversation thread materializer worker sent an invalid response",
          });
          logger.error(
            "conversation thread materializer worker protocol error",
            formatTaggedErrorForLog(error),
          );
          restartWorker(error);
        },
        ok: (response) => {
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
        },
      });
    });

    target.setErrorHandler((event) => {
      if (target !== worker) return;
      const error = new Error(event.message || "conversation thread materializer worker failed");
      logger.error("conversation thread materializer worker error", error);
      restartWorker(error);
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
    pending.set(request.id, pendingRequest);
    const posted = Result.try({
      try: () => worker.postMessage(request),
      catch: (cause) => ({ restoreCause: () => cause }),
    });
    posted.match({
      ok: () => () => undefined,
      err:
        ({ restoreCause }) =>
        () => {
          const error = restoreCause();
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
        },
    })();
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
    markDirty: (input) => startedCoalescer.markDirty(input),
    markAllDirty: () => startedCoalescer.markAllDirty(),
    flush: () => startedCoalescer.flush(),
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = startedCoalescer.stop().finally(() => {
        stopped = true;
        worker.terminate();
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
