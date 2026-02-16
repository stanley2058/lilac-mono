import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";

import { __autoCompactionInternals } from "../auto-compaction";

describe("auto-compaction internals", () => {
  it("selects a split-turn boundary using token budget", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "large turn" },
      { role: "assistant", content: "x".repeat(4000) },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { filePath: "src/index.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "text", value: "content" },
          },
        ],
      },
      { role: "assistant", content: "recent assistant" },
      { role: "user", content: "latest user" },
    ];

    const boundary = __autoCompactionInternals.resolveCompactionBoundary({
      messages,
      keepRecentTokens: 15,
      keepLastMessages: 2,
    });

    expect(boundary.suffixStart).toBeGreaterThan(0);
    expect(messages[boundary.suffixStart]?.role).not.toBe("tool");
    expect(boundary.splitTurnStart).toBe(2);
  });

  it("retries hierarchical summary with smaller budgets after overflow", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "a".repeat(3500) },
      { role: "assistant", content: "b".repeat(3500) },
      { role: "user", content: "c".repeat(3500) },
    ];

    let calls = 0;
    const summary = await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages,
      initialChunkTokenBudget: 10_000,
      maxReductionPasses: 6,
      initialMaxCharsPerMessage: 8_000,
      initialMaxCharsTotal: 8_000,
      summarizeChunk: async (transcript, previousSummary) => {
        calls += 1;
        if (transcript.length > 1600) {
          throw new Error("maximum context length exceeded");
        }
        return previousSummary
          ? `${previousSummary}|${transcript.length}`
          : `S${transcript.length}`;
      },
    });

    expect(calls).toBeGreaterThan(1);
    expect(summary.startsWith("S")).toBe(true);
  });

  it("computes overflow recovery decisions", () => {
    const noOverflow = __autoCompactionInternals.computeOverflowRecoveryDecision({
      error: new Error("rate limit"),
      attempts: 0,
      maxAttempts: 2,
      aborted: false,
    });
    expect(noOverflow.recover).toBe(false);
    expect(noOverflow.nextAttempts).toBe(0);

    const recoverable = __autoCompactionInternals.computeOverflowRecoveryDecision({
      error: new Error("prompt is too long"),
      attempts: 1,
      maxAttempts: 2,
      aborted: false,
    });
    expect(recoverable.recover).toBe(true);
    expect(recoverable.nextAttempts).toBe(2);

    const exhausted = __autoCompactionInternals.computeOverflowRecoveryDecision({
      error: new Error("maximum context length"),
      attempts: 2,
      maxAttempts: 2,
      aborted: false,
    });
    expect(exhausted.recover).toBe(false);
    expect(exhausted.terminalError instanceof Error).toBe(true);
  });
});
