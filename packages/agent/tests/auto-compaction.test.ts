import { describe, expect, it } from "bun:test";
import type { LanguageModel, ModelMessage } from "ai";

import { ModelCapability } from "@stanley2058/lilac-utils";

import { attachAutoCompaction, __autoCompactionInternals } from "../auto-compaction";
import { AiSdkPiAgent } from "../ai-sdk-pi-agent";

function createRegistryFetch(registry: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(registry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function fakeModel(): LanguageModel {
  return {} as LanguageModel;
}

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

  it("computes input budget from safe and early thresholds", () => {
    const largeWindow = __autoCompactionInternals.computeInputCompactionBudget({
      contextLimit: 200_000,
      outputLimit: 16_000,
      thresholdFraction: 0.8,
    });
    expect(largeWindow.earlyInputBudget).toBe(160_000);
    expect(largeWindow.safeInputBudget).toBe(184_000);
    expect(largeWindow.inputBudget).toBe(160_000);

    const smallWindow = __autoCompactionInternals.computeInputCompactionBudget({
      contextLimit: 32_000,
      outputLimit: 12_000,
      thresholdFraction: 0.8,
    });
    expect(smallWindow.earlyInputBudget).toBe(25_600);
    expect(smallWindow.safeInputBudget).toBe(20_000);
    expect(smallWindow.inputBudget).toBe(20_000);
  });

  it("computes fallback budget for unknown-model overflow retries", () => {
    const firstAttempt = __autoCompactionInternals.computeUnknownOverflowCompactionBudget({
      estimatedInputTokens: 12_000,
      lastTurnInputTokens: 10_000,
      overflowAttempt: 1,
    });
    const secondAttempt = __autoCompactionInternals.computeUnknownOverflowCompactionBudget({
      estimatedInputTokens: 12_000,
      lastTurnInputTokens: 10_000,
      overflowAttempt: 2,
    });

    expect(firstAttempt.inputBudget).toBe(8_400);
    expect(secondAttempt.inputBudget).toBe(6_599);
    expect(secondAttempt.inputBudget).toBeLessThan(firstAttempt.inputBudget);
    expect(firstAttempt.reservedOutputTokens).toBe(0);
    expect(firstAttempt.safeInputBudget).toBe(firstAttempt.inputBudget);
  });

  it("clears pending threshold compaction when capability becomes unknown", () => {
    const cleared = __autoCompactionInternals.reconcilePendingCompactionReason({
      pendingReason: "threshold",
      capabilityKnown: false,
    });
    const keepOverflow = __autoCompactionInternals.reconcilePendingCompactionReason({
      pendingReason: "overflow",
      capabilityKnown: false,
    });
    const keepKnownThreshold = __autoCompactionInternals.reconcilePendingCompactionReason({
      pendingReason: "threshold",
      capabilityKnown: true,
    });

    expect(cleared).toBeNull();
    expect(keepOverflow).toBe("overflow");
    expect(keepKnownThreshold).toBe("threshold");
  });

  it("does not fail attach when model capability cannot be resolved", async () => {
    const unknownCapabilityEvents: Array<{ spec: string; reason: string }> = [];

    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "custom/private-model",
    });

    const detach = await attachAutoCompaction(agent, {
      model: "custom/private-model",
      modelCapability: new ModelCapability({
        apiUrl: "https://example.invalid/models.dev/api.json",
        fetch: createRegistryFetch({}),
      }),
      onUnknownCapability: ({ spec, reason }) => {
        unknownCapabilityEvents.push({ spec, reason });
      },
    });

    expect(unknownCapabilityEvents).toHaveLength(1);
    expect(unknownCapabilityEvents[0]).toEqual({
      spec: "custom/private-model",
      reason: "capability_unresolved",
    });

    detach();
  });

  it("repairs orphan tool results before boundary selection", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read",
            input: { filePath: "a.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: { type: "text", value: "ok" },
          },
          {
            type: "tool-result",
            toolCallId: "orphan-1",
            toolName: "read",
            output: { type: "text", value: "orphan" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "orphan-2",
            toolName: "grep",
            output: { type: "text", value: "orphan" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);

    expect(repaired.droppedOrphanToolResultParts).toBe(2);
    expect(repaired.droppedEmptyToolMessages).toBe(1);
    expect(repaired.messages).toHaveLength(3);
    expect(repaired.messages[1]?.role).toBe("tool");
  });

  it("shrinks compacted transcript to fit input budget", () => {
    const summary = `<summary>\n${"s".repeat(8_000)}\n</summary>`;
    const messages: ModelMessage[] = [
      { role: "user", content: summary },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "x".repeat(10_000) },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    const budget = 500;
    const shrunk = __autoCompactionInternals.shrinkCompactedMessagesToBudget({
      messages,
      inputBudget: budget,
    });

    expect(__autoCompactionInternals.estimateMessagesTokens(shrunk)).toBeLessThanOrEqual(budget);
    expect(shrunk.length).toBeGreaterThan(0);
    expect(shrunk[shrunk.length - 1]?.role).not.toBe("assistant");
  });

  it("preserves the latest user request during emergency shrinking", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: `<summary>\n${"s".repeat(3_000)}\n</summary>` },
      { role: "user", content: "Please continue from here and make sure tests pass." },
    ];

    const shrunk = __autoCompactionInternals.shrinkCompactedMessagesToBudget({
      messages,
      inputBudget: 300,
    });

    expect(shrunk.length).toBeGreaterThan(0);
    expect(shrunk[shrunk.length - 1]?.role).toBe("user");
    const content = shrunk[shrunk.length - 1]?.content;
    expect(typeof content === "string" && content.includes("Please continue from here")).toBe(true);
  });
});
