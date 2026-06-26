import { createLogger, type CoreConfig } from "@stanley2058/lilac-utils";

import type {
  ConversationThreadRunSummarizationInput,
  ConversationThreadRunSummarizationResult,
} from "./thread-service";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;

export type ConversationThreadSummarizationRunner = {
  runSummarization(
    input?: ConversationThreadRunSummarizationInput,
  ): Promise<ConversationThreadRunSummarizationResult>;
};

type WorkerResponse =
  | {
      id: string;
      ok: true;
      result: ConversationThreadRunSummarizationResult;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

function isWorkerResponse(input: unknown): input is WorkerResponse {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.ok === "boolean";
}

function queuedResult(jobId: string): ConversationThreadRunSummarizationResult {
  return {
    dryRun: false,
    refreshed: { channels: 0, threads: 0, messages: 0 },
    eligible: 0,
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
}): ConversationThreadSummarizationRunner & { stop(): Promise<void> } {
  const logger = createLogger({ module: "conversation-thread-worker-client" });
  const worker = new Worker(new URL("./thread-summarization-worker.ts", import.meta.url), {
    type: "module",
  });
  logger.info("conversation thread summarization worker client started");
  const pending = new Map<
    string,
    {
      resolve: (result: ConversationThreadRunSummarizationResult) => void;
      reject: (error: Error) => void;
    }
  >();
  const jobs = new Map<
    string,
    {
      startedAt: number;
      wait: boolean;
      dryRun: boolean;
      threadId?: string;
    }
  >();

  worker.onmessage = (event: MessageEvent<unknown>) => {
    const response = event.data;
    if (!isWorkerResponse(response)) {
      logger.warn("conversation thread worker sent invalid response");
      return;
    }

    const waiter = pending.get(response.id);
    pending.delete(response.id);
    const job = jobs.get(response.id);
    jobs.delete(response.id);
    const durationMs = job ? Date.now() - job.startedAt : undefined;

    if (response.ok) {
      logger.info("conversation thread summarization job completed", {
        jobId: response.id,
        wait: job?.wait,
        dryRun: job?.dryRun,
        threadId: job?.threadId,
        durationMs,
        eligible: response.result.eligible,
        summarized: response.result.summarized,
        failed: response.result.failed,
      });
      if (waiter) waiter.resolve(response.result);
      return;
    }

    const error = new Error(response.error);
    logger.error(
      "conversation thread summarization job failed",
      {
        jobId: response.id,
        wait: job?.wait,
        dryRun: job?.dryRun,
        threadId: job?.threadId,
        durationMs,
      },
      error,
    );
    if (waiter) waiter.reject(error);
  };

  worker.onerror = (event) => {
    const error = new Error(event.message || "conversation thread worker failed");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    jobs.clear();
    logger.error("conversation thread worker error", error);
  };

  return {
    async runSummarization(input = {}) {
      const jobId = crypto.randomUUID();
      const wait = input.wait === true;
      jobs.set(jobId, {
        startedAt: Date.now(),
        wait,
        dryRun: input.dryRun === true,
        threadId: input.threadId,
      });
      logger.info("conversation thread summarization job queued", {
        jobId,
        wait,
        dryRun: input.dryRun === true,
        threadId: input.threadId,
        beforeTs: input.beforeTs,
        afterTs: input.afterTs,
      });
      if (wait) {
        const result = await new Promise<ConversationThreadRunSummarizationResult>(
          (resolve, reject) => {
            pending.set(jobId, { resolve, reject });
            worker.postMessage({
              id: jobId,
              input,
              searchDbPath: params.searchDbPath,
              surfaceDbPath: params.surfaceDbPath,
            });
          },
        );
        return { ...result, jobId, status: "completed" as const };
      }

      worker.postMessage({
        id: jobId,
        input,
        searchDbPath: params.searchDbPath,
        surfaceDbPath: params.surfaceDbPath,
      });
      return queuedResult(jobId);
    },
    async stop() {
      logger.info("conversation thread summarization worker client stopping", {
        pendingJobs: jobs.size,
        waiters: pending.size,
      });
      worker.terminate();
      const error = new Error("conversation thread worker stopped");
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      jobs.clear();
      logger.info("conversation thread summarization worker client stopped");
    },
  };
}

export function startConversationThreadWorker(params: {
  runner: ConversationThreadSummarizationRunner;
  getConfig: () => Promise<CoreConfig>;
}): { stop(): Promise<void> } {
  const logger = createLogger({ module: "conversation-thread-worker" });
  logger.info("conversation thread periodic worker started", {
    checkIntervalMs: CHECK_INTERVAL_MS,
  });
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    if (running) {
      logger.debug("conversation thread summarization tick skipped: previous tick still running");
      schedule(CHECK_INTERVAL_MS);
      return;
    }

    running = true;
    try {
      const cfg = await params.getConfig();
      if (cfg.conversation.thread.summarization.enabled !== true) {
        logger.debug("conversation thread summarization disabled");
        return;
      }

      logger.info("conversation thread summarization tick started");
      const result = await params.runner.runSummarization({ wait: true });
      logger.info("conversation thread summarization tick completed", {
        eligible: result.eligible,
        summarized: result.summarized,
        failed: result.failed,
        refreshed: result.refreshed,
      });
    } catch (e) {
      logger.error("conversation thread summarization tick failed", e);
    } finally {
      running = false;
      schedule(CHECK_INTERVAL_MS);
    }
  };

  schedule(10_000);

  return {
    async stop() {
      logger.info("conversation thread periodic worker stopping");
      stopped = true;
      if (timer) clearTimeout(timer);
      logger.info("conversation thread periodic worker stopped");
    },
  };
}
