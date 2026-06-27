import { createLogger, getCoreConfig } from "@stanley2058/lilac-utils";

import { createConversationThreadEmbeddingAdapter } from "./thread-embedding";
import { createSerialJobQueue } from "./thread-job-queue";
import { ConversationThreadService } from "./thread-service";
import type { ConversationThreadRunSummarizationInput } from "./thread-service";
import { ConversationThreadStore } from "./thread-store";
import { createDiscordEntityMapper } from "../entity/entity-mapper";
import { DiscordSurfaceStore } from "../surface/store/discord-surface-store";

type WorkerRequest = {
  id: string;
  input: ConversationThreadRunSummarizationInput;
  searchDbPath: string;
  surfaceDbPath?: string;
};

const logger = createLogger({ module: "conversation-thread-worker-isolate" });
logger.info("conversation thread summarization worker isolate booted");

function isWorkerRequest(input: unknown): input is WorkerRequest {
  if (!input || typeof input !== "object") return false;
  const record = input as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.searchDbPath === "string" &&
    (!record.surfaceDbPath || typeof record.surfaceDbPath === "string") &&
    (!record.input || typeof record.input === "object")
  );
}

async function runJob(request: WorkerRequest): Promise<void> {
  const startedAt = Date.now();
  let store: ConversationThreadStore | null = null;
  let surfaceStore: DiscordSurfaceStore | null = null;
  try {
    logger.info("conversation thread summarization worker job started", {
      jobId: request.id,
      dryRun: request.input.dryRun === true,
      force: request.input.force === true,
      clear: request.input.clear === true,
      threadId: request.input.threadId,
      beforeTs: request.input.beforeTs,
      afterTs: request.input.afterTs,
      queuedJobs: jobQueue.depth,
    });
    const cfg = await getCoreConfig({ forceReload: true });
    let embeddingAdapter;
    try {
      embeddingAdapter = createConversationThreadEmbeddingAdapter(cfg) ?? undefined;
    } catch (e) {
      logger.warn("conversation thread embeddings disabled in worker", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    store = new ConversationThreadStore(request.searchDbPath, {
      surfaceDbPath: request.surfaceDbPath,
      mainAgentUserNames: [cfg.surface.discord.botName],
    });
    const entityMapper = request.surfaceDbPath
      ? (() => {
          surfaceStore = new DiscordSurfaceStore(request.surfaceDbPath);
          return createDiscordEntityMapper({ cfg, store: surfaceStore });
        })()
      : undefined;
    const service = new ConversationThreadService({
      store,
      getConfig: () => getCoreConfig(),
      embeddingAdapter,
      entityMapper,
    });
    const result = await service.runSummarization({ ...request.input, jobId: request.id });
    logger.info("conversation thread summarization worker job completed", {
      jobId: request.id,
      durationMs: Date.now() - startedAt,
      eligible: result.eligible,
      cleared: result.cleared,
      summarized: result.summarized,
      failed: result.failed,
    });
    postMessage({ id: request.id, ok: true, result });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error(
      "conversation thread summarization worker job failed",
      { jobId: request.id, durationMs: Date.now() - startedAt },
      e,
    );
    postMessage({ id: request.id, ok: false, error });
  } finally {
    store?.close();
    surfaceStore?.close();
  }
}

const jobQueue = createSerialJobQueue<WorkerRequest>({
  run: runJob,
  onIdle() {
    logger.debug("conversation thread summarization worker queue idle");
  },
});

self.addEventListener("message", (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isWorkerRequest(request)) {
    postMessage({ id: "unknown", ok: false, error: "invalid worker request" });
    return;
  }

  jobQueue.enqueue(request);
  logger.info("conversation thread summarization worker job enqueued", {
    jobId: request.id,
    queueDepth: jobQueue.depth,
    running: jobQueue.running,
  });
});
