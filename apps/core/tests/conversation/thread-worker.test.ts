import { describe, expect, it, spyOn } from "bun:test";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import { Panic, Result } from "better-result";

import {
  ConversationThreadSummarizationTransportError,
  startConversationThreadSummarizationWorker,
  startConversationThreadWorker,
  type ConversationThreadSummarizationWorkerTransport,
  type ConversationThreadWorkerScheduler,
} from "../../src/conversation/thread-worker";
import type { ThreadSummarizationWorkerRequest } from "../../src/conversation/thread-summarization-worker-protocol";
import type { ConversationThreadRunSummarizationInput } from "../../src/conversation/thread-service";

function createControlledScheduler() {
  const scheduled: Array<{ task: () => void | Promise<void>; delayMs: number }> = [];
  const schedule: ConversationThreadWorkerScheduler = (task, delayMs) => {
    const entry = {
      delayMs,
      task() {
        const index = scheduled.indexOf(entry);
        if (index >= 0) scheduled.splice(index, 1);
        return task();
      },
    };
    scheduled.push(entry);
    return () => {
      const index = scheduled.indexOf(entry);
      if (index >= 0) scheduled.splice(index, 1);
    };
  };
  return { schedule, scheduled };
}

describe("conversation thread periodic worker", () => {
  it("dispatches a bounded periodic run from the configured batch size", async () => {
    const { schedule, scheduled } = createControlledScheduler();
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.conversation.thread.summarization.enabled = true;
    cfg.conversation.thread.summarization.batchSize = 17;
    const dispatched = Promise.withResolvers<ConversationThreadRunSummarizationInput>();
    const worker = startConversationThreadWorker({
      getConfig: async () => cfg,
      schedule,
      initialCheckDelayMs: 123,
      runner: {
        async runSummarization(input = {}) {
          dispatched.resolve(input);
          return Result.ok({
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
          });
        },
      },
    });

    expect(scheduled.map((entry) => entry.delayMs)).toEqual([123]);
    scheduled[0]!.task();
    expect(await dispatched.promise).toEqual({ wait: true, limit: 17, trigger: "periodic" });
    await worker.stop();
    expect(scheduled).toEqual([]);
  });

  it("handles typed runner failures without rejecting the scheduler", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { schedule, scheduled } = createControlledScheduler();
      const cfg = parseCoreConfigV1ToUniversal({});
      cfg.conversation.thread.summarization.enabled = true;
      const dispatched = Promise.withResolvers<void>();
      const worker = startConversationThreadWorker({
        getConfig: async () => cfg,
        schedule,
        initialCheckDelayMs: 0,
        runner: {
          async runSummarization() {
            dispatched.resolve();
            return Result.err(
              new ConversationThreadSummarizationTransportError({
                operation: "post-message",
                message: "worker request could not be posted",
              }),
            );
          },
        },
      });

      scheduled[0]!.task();
      await dispatched.promise;
      await worker.stop();
      expect(scheduled).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("logs ordinary runner rejection and schedules the next tick", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { schedule, scheduled } = createControlledScheduler();
      const cfg = parseCoreConfigV1ToUniversal({});
      cfg.conversation.thread.summarization.enabled = true;
      const worker = startConversationThreadWorker({
        getConfig: async () => cfg,
        schedule,
        initialCheckDelayMs: 0,
        checkIntervalMs: 77,
        runner: {
          async runSummarization() {
            throw new Error("unexpected runner rejection");
          },
        },
      });

      const detachedTick = scheduled[0]!.task();
      if (!detachedTick) throw new Error("Expected scheduler to expose the detached tick promise");
      await detachedTick;
      expect(scheduled.map((entry) => entry.delayMs)).toEqual([77]);
      await worker.stop();
      expect(scheduled).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports and propagates runner Panic without scheduling another tick", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const panic = new Panic({ message: "summarization scheduler invariant failed" });
    const reported: Panic[] = [];
    try {
      const { schedule, scheduled } = createControlledScheduler();
      const cfg = parseCoreConfigV1ToUniversal({});
      cfg.conversation.thread.summarization.enabled = true;
      const worker = startConversationThreadWorker({
        getConfig: async () => cfg,
        schedule,
        initialCheckDelayMs: 0,
        reportFatalPanic: (fatalPanic) => reported.push(fatalPanic),
        runner: {
          async runSummarization() {
            throw panic;
          },
        },
      });

      const detachedTick = scheduled[0]!.task();
      if (!detachedTick) throw new Error("Expected scheduler to expose the detached tick promise");
      await detachedTick;
      expect(reported).toEqual([panic]);
      expect(scheduled).toEqual([]);
      await expect(worker.stop()).rejects.toBe(panic);
      expect(scheduled).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports a client worker Panic exactly once through the periodic worker", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const panic = new Panic({ message: "summarization worker invariant failed" });
    const reported: Panic[] = [];
    const requestPosted = Promise.withResolvers<void>();
    let errorListener: (panic: Panic) => void = () => {};
    const transport: ConversationThreadSummarizationWorkerTransport = {
      postMessage(_request: ThreadSummarizationWorkerRequest) {
        requestPosted.resolve();
      },
      terminate() {},
      onMessage() {},
      onError(listener) {
        errorListener = listener;
      },
    };
    const client = startConversationThreadSummarizationWorker({
      searchDbPath: "/data/search.sqlite",
      createWorker: () => transport,
      reportFatalPanic: (fatalPanic) => reported.push(fatalPanic),
    });

    try {
      const { schedule, scheduled } = createControlledScheduler();
      const cfg = parseCoreConfigV1ToUniversal({});
      cfg.conversation.thread.summarization.enabled = true;
      const worker = startConversationThreadWorker({
        runner: client,
        getConfig: async () => cfg,
        schedule,
        initialCheckDelayMs: 0,
        reportFatalPanic: (fatalPanic) => reported.push(fatalPanic),
      });

      const detachedTick = scheduled[0]!.task();
      if (!detachedTick) throw new Error("Expected scheduler to expose the detached tick promise");
      await requestPosted.promise;
      errorListener(panic);
      await detachedTick;

      expect(reported).toEqual([panic]);
      expect(scheduled).toEqual([]);
      await expect(worker.stop()).rejects.toBe(panic);
      expect(scheduled).toEqual([]);
    } finally {
      await client.stop();
      consoleError.mockRestore();
    }
  });
});
