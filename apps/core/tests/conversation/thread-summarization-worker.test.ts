import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import {
  runThreadSummarizationWorkerOperation,
  type ThreadSummarizationWorkerCleanup,
  type ThreadSummarizationWorkerCleanupFailure,
} from "../../src/conversation/thread-summarization-worker";

const CLEANUP_LABELS = ["thread-store", "surface-store"] as const;

function cleanupsThatFail(
  failingLabel: ThreadSummarizationWorkerCleanup["label"],
  failure: unknown,
  closed: ThreadSummarizationWorkerCleanup["label"][],
): readonly ThreadSummarizationWorkerCleanup[] {
  return CLEANUP_LABELS.map((label) => ({
    label,
    close() {
      closed.push(label);
      if (label === failingLabel) throw failure;
    },
  }));
}

describe("conversation thread summarization worker cleanup", () => {
  for (const failingLabel of CLEANUP_LABELS) {
    it.each([
      ["ordinary failure", () => new Error(`${failingLabel} close failed`)],
      ["Panic", () => new Panic({ message: `${failingLabel} close invariant failed` })],
    ] as const)(
      `preserves an operation Panic when ${failingLabel} has an %s and closes both stores`,
      async (_, createFailure) => {
        const operationPanic = new Panic({ message: "summarization invariant failed" });
        const cleanupFailure = createFailure();
        const closed: ThreadSummarizationWorkerCleanup["label"][] = [];
        const cleanupFailures: ThreadSummarizationWorkerCleanupFailure[] = [];

        const operation = runThreadSummarizationWorkerOperation({
          run: async () => {
            throw operationPanic;
          },
          cleanups: cleanupsThatFail(failingLabel, cleanupFailure, closed),
          onCleanupFailure: (failure) => cleanupFailures.push(failure),
        });

        await expect(operation).rejects.toBe(operationPanic);
        expect(closed).toEqual([...CLEANUP_LABELS]);
        expect(cleanupFailures).toHaveLength(1);
        expect(cleanupFailures[0]?.cleanup.label).toBe(failingLabel);
        expect(cleanupFailures[0]?.kind).toBe(Panic.is(cleanupFailure) ? "panic" : "ordinary");
      },
    );

    it(`continues after an ordinary ${failingLabel} close failure`, async () => {
      const cleanupFailure = new Error(`${failingLabel} close failed`);
      const closed: ThreadSummarizationWorkerCleanup["label"][] = [];
      const cleanupFailures: ThreadSummarizationWorkerCleanupFailure[] = [];
      let continued = false;

      const operation = await runThreadSummarizationWorkerOperation({
        run: async () => {},
        cleanups: cleanupsThatFail(failingLabel, cleanupFailure, closed),
        onCleanupFailure: (failure) => cleanupFailures.push(failure),
      });
      continued = true;

      expect(operation.status).toBe("ok");
      expect(closed).toEqual([...CLEANUP_LABELS]);
      expect(cleanupFailures[0]).toMatchObject({
        cleanup: { label: failingLabel },
        kind: "ordinary",
        message: `Conversation thread summarization worker cleanup failed: ${failingLabel} close failed`,
      });
      expect(continued).toBe(true);
    });

    it(`propagates a ${failingLabel} cleanup Panic after attempting both stores`, async () => {
      const cleanupPanic = new Panic({ message: `${failingLabel} close invariant failed` });
      const closed: ThreadSummarizationWorkerCleanup["label"][] = [];

      const operation = runThreadSummarizationWorkerOperation({
        run: async () => {},
        cleanups: cleanupsThatFail(failingLabel, cleanupPanic, closed),
        onCleanupFailure: () => {},
      });

      await expect(operation).rejects.toBe(cleanupPanic);
      expect(closed).toEqual([...CLEANUP_LABELS]);
    });
  }
});
