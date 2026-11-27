import { captureError } from "../shared/error-capture.js";
import {
  createLogger,
  formatTaggedErrorForLog,
  isPanic,
  opaqueErrorMessage,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  decodeThreadSummarizationWorkerMessage,
  ThreadSummarizationWorkerMessageDecodeError,
  type ThreadSummarizationParentMessage,
  type ThreadSummarizationResult,
  type ThreadSummarizationHydrationRequest,
  type ThreadSummarizationHydrationResponse,
  type ThreadSummarizationWorkerMessage,
  type ThreadSummarizationWorkerRequest,
  type ThreadSummarizationWorkerResponse,
} from "./thread-summarization-worker-protocol";
import {
  ConversationThreadOperationFailed,
  type ConversationThreadAttachmentHydrator,
  type ConversationThreadRunSummarizationInput,
} from "./thread-service";
import type { SurfaceAdapter } from "../surface/adapter";
import { toReplyChainMessage } from "../surface/bridge/request-composition/reply-chain";
import {
  createWorkerMemoryTracker,
  DEFAULT_SUMMARIZATION_WORKER_MAX_ISOLATE_BYTES,
  type WorkerMemoryDiagnostics,
  type WorkerMemoryUsage,
} from "./worker-memory-watchdog";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 10_000;
const DEFAULT_SUMMARIZATION_WORKER_IDLE_TIMEOUT_MS = 60_000;

export type ConversationThreadWorkerScheduler = (
  task: () => void | Promise<void>,
  delayMs: number,
) => () => void;

export type ConversationThreadWorkerFatalReporter = (panic: Panic) => void;

const fatalReportOwners = new WeakSet<Panic>();

function reportConversationThreadWorkerPanicOnce(
  panic: Panic,
  reportFatalPanic: ConversationThreadWorkerFatalReporter,
): void {
  if (fatalReportOwners.has(panic)) return;
  fatalReportOwners.add(panic);
  reportFatalPanic(panic);
}

function defaultScheduler(task: () => void | Promise<void>, delayMs: number): () => void {
  const timer = setTimeout(task, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function signalConversationThreadWorkerPanicToProcess(panic: Panic): void {
  queueMicrotask(() => {
    throw panic;
  });
}

export type ConversationThreadSummarizationRunner = {
  runSummarization(
    input?: ConversationThreadRunSummarizationInput,
  ): Promise<ResultType<ThreadSummarizationResult, ConversationThreadSummarizationError>>;
};

export class ConversationThreadSummarizationRemoteError extends TaggedError(
  "ConversationThreadSummarizationRemoteError",
)<{
  readonly jobId: string;
  readonly remoteMessage: string;
  readonly message: string;
}> {}

export type ConversationThreadSummarizationTransportOperation =
  | "post-message"
  | "stopped"
  | "memory-watchdog";

export class ConversationThreadSummarizationTransportError extends TaggedError(
  "ConversationThreadSummarizationTransportError",
)<{
  readonly operation: ConversationThreadSummarizationTransportOperation;
  readonly cause?: unknown;
  readonly message: string;
}> {}

export type ConversationThreadSummarizationRuntimeOperation =
  | "materializer-flush"
  | "configuration"
  | "in-process";

export class ConversationThreadSummarizationRuntimeError extends TaggedError(
  "ConversationThreadSummarizationRuntimeError",
)<{
  readonly operation: ConversationThreadSummarizationRuntimeOperation;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type ConversationThreadSummarizationWorkerError =
  | ThreadSummarizationWorkerMessageDecodeError
  | ConversationThreadSummarizationRemoteError
  | ConversationThreadSummarizationTransportError;

export type ConversationThreadSummarizationError =
  | ConversationThreadSummarizationWorkerError
  | ConversationThreadSummarizationRuntimeError;

export type ConversationThreadSummarizationWorkerTransport = {
  postMessage(request: ThreadSummarizationParentMessage): void;
  terminate(): void;
  onMessage(listener: (event: MessageEvent<unknown>) => void): void;
  onError(listener: (panic: Panic) => void): void;
};

export function rethrowConversationThreadWorkerPanic(
  cause: Panic | null,
  beforeRethrow?: (panic: Panic) => void,
): void {
  if (!cause) return;
  beforeRethrow?.(cause);
  throw cause;
}

export function normalizeConversationThreadWorkerPanic(cause: Panic | string): Panic {
  if (Panic.is(cause)) return cause;
  return new Panic({
    message: cause || "Conversation thread summarization worker failed with an opaque error",
  });
}

function createSummarizationWorkerTransport(): ConversationThreadSummarizationWorkerTransport {
  const worker = new Worker(new URL("./thread-summarization-worker.ts", import.meta.url), {
    type: "module",
  });
  return {
    postMessage(request) {
      worker.postMessage(request);
    },
    terminate() {
      worker.terminate();
    },
    onMessage(listener) {
      worker.onmessage = listener;
    },
    onError(listener) {
      worker.onerror = (event) => {
        const cause = Panic.is(event.error) ? event.error : event.message;
        listener(normalizeConversationThreadWorkerPanic(cause));
      };
    },
  };
}

function queuedResult(jobId: string): ThreadSummarizationResult {
  return {
    dryRun: false,
    refreshed: { channels: 0, threads: 0, messages: 0 },
    eligible: 0,
    eligibleTotal: 0,
    eligibility: { summary: 0, embeddingOnly: 0, reasons: {} },
    cleared: 0,
    summarized: 0,
    failed: 0,
    failures: [],
    threadIds: [],
    jobId,
    status: "queued",
  };
}

export function startConversationThreadSummarizationWorker(params: {
  searchDbPath: string;
  surfaceDbPath?: string;
  nativeDbPath?: string;
  adapter?: Pick<SurfaceAdapter, "readMsg">;
  attachmentHydrator?: ConversationThreadAttachmentHydrator;
  createWorker?: () => ConversationThreadSummarizationWorkerTransport;
  reportFatalPanic?: ConversationThreadWorkerFatalReporter;
  idleTimeoutMs?: number;
  scheduleIdle?: ConversationThreadWorkerScheduler;
}): ConversationThreadSummarizationRunner & {
  stop(): Promise<void>;
  getMemoryDiagnostics(): WorkerMemoryDiagnostics;
} {
  const logger = createLogger({ module: "conversation-thread-worker-client" });
  const createWorker = params.createWorker ?? createSummarizationWorkerTransport;
  const reportFatalPanic = params.reportFatalPanic ?? signalConversationThreadWorkerPanicToProcess;
  const idleTimeoutMs = params.idleTimeoutMs ?? DEFAULT_SUMMARIZATION_WORKER_IDLE_TIMEOUT_MS;
  const scheduleIdle = params.scheduleIdle ?? defaultScheduler;
  logger.debug("conversation thread summarization worker client started", {
    idleTimeoutMs,
  });
  const pending = new Map<
    string,
    {
      resolve: (
        result: ResultType<ThreadSummarizationResult, ConversationThreadSummarizationWorkerError>,
      ) => void;
      reject: (panic: Panic) => void;
    }
  >();
  const jobs = new Map<
    string,
    {
      startedAt: number;
      wait: boolean;
      dryRun: boolean;
      clear: boolean;
      threadId?: string;
    }
  >();
  let activeWorker: ConversationThreadSummarizationWorkerTransport | null = null;
  let cancelIdleTimer: (() => void) | null = null;
  let stopped = false;
  let terminalFailure: ThreadSummarizationWorkerMessageDecodeError | null = null;
  let terminalPanic: Panic | null = null;
  const memoryTracker = createWorkerMemoryTracker(DEFAULT_SUMMARIZATION_WORKER_MAX_ISOLATE_BYTES);

  const clearIdleTimer = () => {
    cancelIdleTimer?.();
    cancelIdleTimer = null;
  };

  const terminateWorker = () => {
    clearIdleTimer();
    const current = activeWorker;
    if (!current) return;
    activeWorker = null;
    memoryTracker.clearSample();
    current.terminate();
  };

  const scheduleIdleTeardown = () => {
    clearIdleTimer();
    if (stopped || terminalFailure || terminalPanic || !activeWorker) return;
    if (idleTimeoutMs <= 0 || pending.size > 0 || jobs.size > 0) return;
    cancelIdleTimer = scheduleIdle(() => {
      cancelIdleTimer = null;
      if (stopped || pending.size > 0 || jobs.size > 0 || !activeWorker) return;
      logger.debug("conversation thread summarization worker idle teardown");
      terminateWorker();
    }, idleTimeoutMs);
  };

  const settlePending = (error: ConversationThreadSummarizationWorkerError) => {
    const waiters = [...pending.values()];
    pending.clear();
    jobs.clear();
    for (const waiter of waiters) waiter.resolve(Result.err(error));
  };

  const rejectPending = (panic: Panic) => {
    const waiters = [...pending.values()];
    pending.clear();
    jobs.clear();
    for (const waiter of waiters) waiter.reject(panic);
  };

  const handleWorkerPanic = (panic: Panic) => {
    if (stopped || terminalFailure || terminalPanic) return;
    terminalPanic = panic;
    rejectPending(terminalPanic);
    terminateWorker();
    reportConversationThreadWorkerPanicOnce(terminalPanic, reportFatalPanic);
    logger.error("conversation thread worker defect", formatTaggedErrorForLog(terminalPanic));
  };

  const ensureWorker = (): ConversationThreadSummarizationWorkerTransport => {
    clearIdleTimer();
    if (activeWorker) return activeWorker;
    const created = createWorker();
    activeWorker = created;
    configureWorker(created);
    return created;
  };

  const postRequest = (
    request: ThreadSummarizationParentMessage,
  ): ResultType<void, ConversationThreadSummarizationTransportError> => {
    const captured = Result.try({
      try: () => {
        const targetWorker = ensureWorker();
        targetWorker.postMessage(request);
        return Result.ok(undefined);
      },
      catch: captureError,
    });
    if (captured.isErr()) {
      const cause = captured.error.cause;
      pending.delete(request.id);
      jobs.delete(request.id);
      scheduleIdleTeardown();
      if (Panic.is(cause)) rethrowConversationThreadWorkerPanic(cause);
      return Result.err(
        new ConversationThreadSummarizationTransportError({
          operation: "post-message",
          cause,
          message: "Could not post conversation thread summarization worker request",
        }),
      );
    }
    return captured.value;
  };

  const postHydrationReply = (
    targetWorker: ConversationThreadSummarizationWorkerTransport,
    response: ThreadSummarizationHydrationResponse,
  ): ResultType<void, ConversationThreadSummarizationTransportError> => {
    const captured = Result.try({
      try: () => {
        targetWorker.postMessage(response);
        return Result.ok(undefined);
      },
      catch: captureError,
    });
    if (captured.isErr()) {
      const cause = captured.error.cause;
      if (Panic.is(cause)) rethrowConversationThreadWorkerPanic(cause);
      return Result.err(
        new ConversationThreadSummarizationTransportError({
          operation: "post-message",
          cause,
          message: "Could not post conversation thread hydration response",
        }),
      );
    }
    return captured.value;
  };

  const hydrateRequest: ConversationThreadAttachmentHydrator = async (input) => {
    if (params.attachmentHydrator) return params.attachmentHydrator(input);
    const adapter = params.adapter;
    if (!adapter)
      return Result.err(
        new ConversationThreadOperationFailed({
          operation: "summarize-thread",
          message: "surface adapter unavailable",
        }),
      );
    return Result.gen(async function* () {
      const results: Array<{
        ref: (typeof input.refs)[number];
        attachments: ReturnType<typeof toReplyChainMessage>["attachments"];
      }> = [];
      for (const ref of input.refs) {
        if (ref.surface === "native")
          return Result.err(
            new ConversationThreadOperationFailed({
              operation: "summarize-thread",
              message: "native attachment hydrator unavailable",
            }),
          );
        const message = yield* Result.await(
          adapter
            .readMsg({ platform: "discord", channelId: ref.channelId, messageId: ref.messageId })
            .then((result) =>
              result.mapError(
                (error) =>
                  new ConversationThreadOperationFailed({
                    operation: "summarize-thread",
                    message: error.message,
                  }),
              ),
            ),
        );
        if (!message)
          return Result.err(
            new ConversationThreadOperationFailed({
              operation: "summarize-thread",
              message: "surface message not found",
            }),
          );
        results.push({ ref, attachments: toReplyChainMessage(message).attachments });
      }
      return Result.ok(results);
    });
  };

  const handleHydrationRequest = async (
    targetWorker: ConversationThreadSummarizationWorkerTransport,
    request: ThreadSummarizationHydrationRequest,
  ) => {
    const [settled] = await Promise.allSettled([hydrateRequest({ refs: request.refs })]);
    if (settled.status === "rejected" && Panic.is(settled.reason)) {
      handleWorkerPanic(settled.reason);
      return;
    }
    if (stopped || terminalFailure || terminalPanic || activeWorker !== targetWorker) return;
    if (settled.status === "rejected") {
      handleWorkerPanic(
        new Panic({
          message: "Conversation thread attachment hydration defect",
          cause: settled.reason,
        }),
      );
      return;
    }
    const results = settled.value.match<ThreadSummarizationHydrationResponse["results"]>({
      ok: (items) =>
        items.map((item) => ({
          ref: item.ref,
          ok: true,
          attachments: item.attachments.map((attachment) => ({
            id: attachment.id,
            url: attachment.url,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            ...(attachment.data ? { data: new Uint8Array(attachment.data) } : {}),
          })),
        })),
      err: (error) => request.refs.map((ref) => ({ ref, ok: false, error: error.message })),
    });
    if (stopped || terminalFailure || terminalPanic || activeWorker !== targetWorker) return;
    const response: ThreadSummarizationHydrationResponse = {
      type: "hydrate-discord-attachments-result",
      id: request.id,
      results,
    };
    const [posted] = await Promise.allSettled([
      Promise.resolve().then(() => postHydrationReply(targetWorker, response)),
    ]);
    if (stopped || terminalFailure || terminalPanic || activeWorker !== targetWorker) return;
    if (posted.status === "rejected") {
      handleWorkerPanic(
        Panic.is(posted.reason)
          ? posted.reason
          : new Panic({
              message: "Conversation thread hydration response failed",
              cause: posted.reason,
            }),
      );
      return;
    }
    posted.value.match({
      ok: () => undefined,
      err: (error) =>
        handleWorkerPanic(
          new Panic({
            message: "Conversation thread hydration response failed",
            cause: error,
          }),
        ),
    });
  };

  const handleWatchdogExceeded = (
    targetWorker: ConversationThreadSummarizationWorkerTransport,
    reason: string,
    memory: WorkerMemoryUsage,
    limit: number,
  ) => {
    if (stopped || terminalFailure || terminalPanic || activeWorker !== targetWorker) return;
    logger.warn(
      "conversation thread summarization worker exceeded memory watchdog limit; restarting worker",
      { reason, memory, limitBytes: limit },
    );
    terminateWorker();
    memoryTracker.recordRestart(reason);
    settlePending(
      new ConversationThreadSummarizationTransportError({
        operation: "memory-watchdog",
        message: `Conversation thread summarization worker restarted: ${reason}`,
      }),
    );
  };

  const handleJobResponse = (response: ThreadSummarizationWorkerResponse) => {
    const waiter = pending.get(response.id);
    const job = jobs.get(response.id);
    if (!waiter && !job) {
      logger.warn("conversation thread worker response had no pending job", {
        jobId: response.id,
      });
      return;
    }

    pending.delete(response.id);
    jobs.delete(response.id);
    const durationMs = job ? Date.now() - job.startedAt : undefined;

    if (response.ok) {
      if (response.result.eligible > 0) {
        logger.debug("conversation thread summarization job completed", {
          jobId: response.id,
          wait: job?.wait,
          dryRun: job?.dryRun,
          threadId: job?.threadId,
          durationMs,
          eligible: response.result.eligible,
          summarized: response.result.summarized,
          failed: response.result.failed,
        });
      }
      waiter?.resolve(
        Result.ok({ ...response.result, jobId: response.id, status: "completed" as const }),
      );
      scheduleIdleTeardown();
      return;
    }

    const error = new ConversationThreadSummarizationRemoteError({
      jobId: response.id,
      remoteMessage: response.error,
      message: response.error,
    });
    logger.error("conversation thread summarization job failed", {
      jobId: response.id,
      wait: job?.wait,
      dryRun: job?.dryRun,
      threadId: job?.threadId,
      durationMs,
    });
    waiter?.resolve(Result.err(error));
    scheduleIdleTeardown();
  };

  const handleWorkerMessage = (
    targetWorker: ConversationThreadSummarizationWorkerTransport,
    response: ThreadSummarizationWorkerMessage,
  ) => {
    if (!("type" in response)) {
      handleJobResponse(response);
      return;
    }
    if (response.type === "worker-memory") {
      memoryTracker.recordSample(response);
      return;
    }
    if (response.type === "worker-watchdog-exceeded") {
      memoryTracker.recordSample(response);
      handleWatchdogExceeded(targetWorker, response.reason, response.memory, response.limitBytes);
      return;
    }
    void handleHydrationRequest(targetWorker, response);
  };

  function configureWorker(targetWorker: ConversationThreadSummarizationWorkerTransport): void {
    targetWorker.onMessage((event) => {
      if (stopped || terminalFailure || terminalPanic || activeWorker !== targetWorker) return;
      const decoded = decodeThreadSummarizationWorkerMessage(event.data);
      decoded.match({
        err: (error) => {
          terminalFailure = error;
          settlePending(terminalFailure);
          logger.warn(
            "conversation thread worker sent invalid response",
            formatTaggedErrorForLog(terminalFailure),
          );
          terminateWorker();
        },
        ok: (response) => handleWorkerMessage(targetWorker, response),
      });
    });

    targetWorker.onError((panic) => {
      if (activeWorker !== targetWorker) return;
      handleWorkerPanic(panic);
    });
  }

  return {
    getMemoryDiagnostics() {
      let status: WorkerMemoryDiagnostics["status"] = "idle";
      if (stopped || terminalFailure || terminalPanic) status = "stopped";
      else if (activeWorker) status = "running";
      return memoryTracker.snapshot(status);
    },
    async runSummarization(input = {}) {
      rethrowConversationThreadWorkerPanic(terminalPanic);
      if (terminalFailure) return Result.err(terminalFailure);
      if (stopped) {
        return Result.err(
          new ConversationThreadSummarizationTransportError({
            operation: "stopped",
            message: "Conversation thread summarization worker is stopped",
          }),
        );
      }
      const jobId = crypto.randomUUID();
      const wait = input.wait === true;
      jobs.set(jobId, {
        startedAt: Date.now(),
        wait,
        dryRun: input.dryRun === true,
        clear: input.clear === true,
        threadId: input.threadId,
      });
      const request = {
        id: jobId,
        input,
        searchDbPath: params.searchDbPath,
        surfaceDbPath: params.surfaceDbPath,
        nativeDbPath: params.nativeDbPath,
      } satisfies ThreadSummarizationWorkerRequest;
      if (wait) {
        return await new Promise<
          ResultType<ThreadSummarizationResult, ConversationThreadSummarizationWorkerError>
        >((resolve, reject) => {
          pending.set(jobId, { resolve, reject });
          const posted = postRequest(request);
          posted.match({ ok: () => undefined, err: (error) => resolve(Result.err(error)) });
        });
      }

      const posted = postRequest(request);
      return posted.map(() => queuedResult(jobId));
    },
    async stop() {
      logger.debug("conversation thread summarization worker client stopping");
      stopped = true;
      settlePending(
        new ConversationThreadSummarizationTransportError({
          operation: "stopped",
          message: "Conversation thread summarization worker is stopped",
        }),
      );
      terminateWorker();
      logger.debug("conversation thread summarization worker client stopped");
    },
  };
}

export function startConversationThreadWorker(params: {
  runner: ConversationThreadSummarizationRunner;
  getConfig: () => Promise<CoreConfig>;
  schedule?: ConversationThreadWorkerScheduler;
  checkIntervalMs?: number;
  initialCheckDelayMs?: number;
  reportFatalPanic?: ConversationThreadWorkerFatalReporter;
}): { stop(): Promise<void> } {
  const logger = createLogger({ module: "conversation-thread-worker" });
  const scheduler = params.schedule ?? defaultScheduler;
  const checkIntervalMs = params.checkIntervalMs ?? CHECK_INTERVAL_MS;
  const reportFatalPanic = params.reportFatalPanic ?? signalConversationThreadWorkerPanicToProcess;
  logger.debug("conversation thread periodic worker started", {
    checkIntervalMs,
  });
  let stopped = false;
  let running = false;
  let cancelScheduledTick: (() => void) | null = null;
  let tickPromise: Promise<void> | null = null;
  let terminalPanic: Panic | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    cancelScheduledTick = scheduler(() => {
      cancelScheduledTick = null;
      const current = tick();
      tickPromise = current;
      return current;
    }, delayMs);
  };

  const tick = async () => {
    if (stopped) return;
    if (running) {
      logger.debug("conversation thread summarization tick skipped: previous tick still running");
      schedule(checkIntervalMs);
      return;
    }

    running = true;
    await (async () => {
      const operation = await Result.tryPromise({
        try: async () => {
          const cfg = await params.getConfig();
          if (cfg.conversation.thread.summarization.enabled !== true) {
            logger.debug("conversation thread summarization disabled");
            return;
          }

          const run = await params.runner.runSummarization({
            wait: true,
            limit: cfg.conversation.thread.summarization.batchSize,
            trigger: "periodic",
          });
          run.match({
            err: (error) => {
              logger.error(
                "conversation thread summarization tick failed",
                formatTaggedErrorForLog(error),
              );
            },
            ok: () => undefined,
          });
        },
        catch: captureError,
      });
      operation.match({
        ok: () => undefined,
        err: ({ cause: error }) => {
          if (isPanic(error)) {
            terminalPanic = error;
            reportConversationThreadWorkerPanicOnce(error, reportFatalPanic);
            logger.error(
              "conversation thread summarization tick panicked",
              formatTaggedErrorForLog(error),
            );
          } else {
            logger.error(
              "conversation thread summarization tick failed",
              formatTaggedErrorForLog(
                new ConversationThreadSummarizationRuntimeError({
                  operation: "in-process",
                  cause: error,
                  message: opaqueErrorMessage(error, "Opaque conversation thread worker failure"),
                }),
              ),
            );
          }
        },
      });
    })().finally(() => {
      running = false;
      if (!terminalPanic) schedule(checkIntervalMs);
    });
  };

  schedule(params.initialCheckDelayMs ?? INITIAL_CHECK_DELAY_MS);

  return {
    async stop() {
      logger.debug("conversation thread periodic worker stopping");
      stopped = true;
      cancelScheduledTick?.();
      cancelScheduledTick = null;
      await tickPromise;
      rethrowConversationThreadWorkerPanic(terminalPanic);
      logger.debug("conversation thread periodic worker stopped");
    },
  };
}
