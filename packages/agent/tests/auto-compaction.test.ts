import { describe, expect, it } from "bun:test";
import type { LanguageModel, ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { ModelCapability } from "@stanley2058/lilac-utils";

import {
  attachAutoCompaction,
  compactMessages,
  __autoCompactionInternals,
} from "../auto-compaction";
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

function zeroUsage() {
  return {
    inputTokens: {
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: 0,
      text: 0,
      reasoning: 0,
    },
  };
}

describe("auto-compaction internals", () => {
  it("wraps summaries as stable prior context rather than a new request", () => {
    expect(__autoCompactionInternals.buildCompactionSummaryMessage("summary details")).toEqual({
      role: "user",
      content: [
        "<context-compaction>",
        "The conversation before this point was automatically compacted.",
        "Treat this summary as prior conversation context, not as a new user request.",
        "",
        "summary details",
        "</context-compaction>",
      ].join("\n"),
    });
  });

  it("counts canonical inline media separately from text token estimates", () => {
    const withMedia: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: "aGVsbG8=",
          },
        ],
      },
    ];
    const scrubbed: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Image omitted after its limit." }] },
    ];

    expect(__autoCompactionInternals.inlineMediaStorageBytes(withMedia)).toBe(8);
    expect(__autoCompactionInternals.inlineMediaStorageBytes(scrubbed)).toBe(0);
    expect(
      __autoCompactionInternals.estimateMessagesTokens([
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: "a".repeat(10 * 1024 * 1024),
            },
          ],
        },
      ]),
    ).toBeLessThan(100);
  });

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

  it("sends every marker from an oversized selected message through summarization", async () => {
    const markers = ["MARKER_A", "MARKER_B", "MARKER_C", "MARKER_D"];
    const content = markers.map((marker) => `${marker}${"x".repeat(90)}`).join("");
    const transcripts: string[] = [];
    const previousSummaries: Array<string | null> = [];

    await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages: [{ role: "user", content }],
      initialChunkTokenBudget: 10_000,
      maxReductionPasses: 1,
      initialMaxCharsPerMessage: 200,
      initialMaxCharsTotal: 500,
      summarizeChunk: async (transcript, previousSummary) => {
        transcripts.push(transcript);
        previousSummaries.push(previousSummary);
        return `${previousSummary ?? "summary"}|updated`;
      },
    });

    expect(transcripts.length).toBeGreaterThan(1);
    for (const marker of markers) {
      expect(transcripts.some((transcript) => transcript.includes(marker))).toBe(true);
    }
    expect(previousSummaries[0]).toBeNull();
    expect(previousSummaries.slice(1).every((summary) => summary !== null)).toBe(true);
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
    expect(largeWindow.reservedOutputTokens).toBe(40_000);
    expect(largeWindow.safeInputBudget).toBe(160_000);
    expect(largeWindow.inputBudget).toBe(160_000);

    const smallWindow = __autoCompactionInternals.computeInputCompactionBudget({
      contextLimit: 32_000,
      outputLimit: 12_000,
      thresholdFraction: 0.8,
    });
    expect(smallWindow.earlyInputBudget).toBe(25_600);
    expect(smallWindow.reservedOutputTokens).toBe(12_000);
    expect(smallWindow.safeInputBudget).toBe(20_000);
    expect(smallWindow.inputBudget).toBe(20_000);

    const fullOutputWindow = __autoCompactionInternals.computeInputCompactionBudget({
      contextLimit: 500_000,
      outputLimit: 500_000,
      thresholdFraction: 0.8,
    });
    expect(fullOutputWindow.reservedOutputTokens).toBe(100_000);
    expect(fullOutputWindow.safeInputBudget).toBe(400_000);
    expect(fullOutputWindow.inputBudget).toBe(400_000);
  });

  it("normalizes configurable threshold fractions", () => {
    expect(__autoCompactionInternals.normalizeThresholdFraction(undefined)).toBe(0.8);
    expect(__autoCompactionInternals.normalizeThresholdFraction(Number.NaN)).toBe(0.8);
    expect(__autoCompactionInternals.normalizeThresholdFraction(0)).toBe(0.05);
    expect(__autoCompactionInternals.normalizeThresholdFraction(1)).toBe(0.95);
    expect(__autoCompactionInternals.normalizeThresholdFraction(0.6)).toBe(0.6);
  });

  it("manually compacts persisted messages without an agent", async () => {
    const summaryResponse = () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "summary" },
          {
            type: "text-delta" as const,
            id: "summary",
            delta: "Condensed prior work.",
          },
          { type: "text-end" as const, id: "summary" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: zeroUsage(),
          },
        ],
      }),
    });
    const model = new MockLanguageModelV4({
      doStream: [summaryResponse(), summaryResponse()],
    });
    const messages: ModelMessage[] = [
      { role: "user", content: `old request ${"a".repeat(6_000)}` },
      { role: "assistant", content: `old response ${"b".repeat(6_000)}` },
      { role: "user", content: "latest request must remain verbatim" },
    ];

    const result = await compactMessages({
      messages,
      currentModel: model,
      contextLimit: 10_000,
      outputLimit: 1_000,
      thresholdFraction: 0.25,
      keepRecentTokens: 1,
      keepLastMessages: 1,
    });

    expect(result.status).toBe("compacted");
    expect(result.messageCountBefore).toBe(3);
    expect(result.messageCountAfter).toBe(2);
    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore);
    expect(result.budget.inputBudget).toBe(2_500);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [
        "<context-compaction>",
        "The conversation before this point was automatically compacted.",
        "Treat this summary as prior conversation context, not as a new user request.",
        "",
        "Condensed prior work.",
        "</context-compaction>",
      ].join("\n"),
    });
    expect(result.messages[1]).toEqual(messages[2]);
    expect(messages).toHaveLength(3);
  });

  it("returns typed noop metrics for an empty persisted transcript", async () => {
    const result = await compactMessages({
      messages: [],
      currentModel: fakeModel(),
      contextLimit: 100_000,
    });

    expect(result).toMatchObject({
      status: "noop",
      reason: "empty",
      messages: [],
      messageCountBefore: 0,
      messageCountAfter: 0,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
    });
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

  it("preserves the complete subset of a partial multi-call group", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "complete-call",
            toolName: "read_file",
            input: { filePath: "complete.ts" },
          },
          {
            type: "tool-call",
            toolCallId: "dangling-call",
            toolName: "read_file",
            input: { filePath: "dangling.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "complete-call",
            toolName: "read_file",
            output: { type: "text", value: "complete result" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);
    const rendered = JSON.stringify(repaired.messages);

    expect(repaired.droppedDanglingToolCallParts).toBe(1);
    expect(rendered).toContain("complete-call");
    expect(rendered).toContain("complete result");
    expect(rendered).not.toContain("dangling-call");
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("removes a dangling assistant tool call", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "dangling-call",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);

    expect(repaired.droppedDanglingToolCallParts).toBe(1);
    expect(repaired.droppedEmptyAssistantMessages).toBe(1);
    expect(repaired.messages).toEqual([{ role: "user", content: "latest" }]);
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("does not connect a tool call and result across an intervening message", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "progress before tool" },
          {
            type: "tool-call",
            toolCallId: "separated-call",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      { role: "user", content: "intervening user" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "separated-call",
            toolName: "bash",
            output: { type: "text", value: "must not reconnect" },
          },
        ],
      },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);
    const rendered = JSON.stringify(repaired.messages);

    expect(rendered).toContain("progress before tool");
    expect(rendered).toContain("intervening user");
    expect(rendered).not.toContain("separated-call");
    expect(rendered).not.toContain("must not reconnect");
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("drops a result that appears before its call without losing the later complete group", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "misordered-call",
            toolName: "bash",
            output: { type: "text", value: "misordered result" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "misordered-call",
            toolName: "bash",
            input: { command: "pwd" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "misordered-call",
            toolName: "bash",
            output: { type: "text", value: "ordered result" },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(false);
    const repaired = __autoCompactionInternals.repairTranscriptForCompaction(messages);
    const rendered = JSON.stringify(repaired.messages);

    expect(repaired.droppedOrphanToolResultParts).toBe(1);
    expect(rendered).not.toContain("misordered result");
    expect(rendered).toContain("ordered result");
    expect(__autoCompactionInternals.isValidSuffix(repaired.messages, 0)).toBe(true);
  });

  it("shrinks only the summary and preserves retained tool call-result context", () => {
    const summary = `<summary>\n${"s".repeat(8_000)}\n</summary>`;
    const retainedOutputMarker = `UNSUMMARIZED_SUFFIX_OUTPUT_${"x".repeat(10_000)}`;
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
            output: { type: "text", value: retainedOutputMarker },
          },
        ],
      },
      { role: "user", content: "latest" },
    ];

    const budget = 3_000;
    const shrunk = __autoCompactionInternals.shrinkCompactedMessagesToBudget({
      messages,
      inputBudget: budget,
    });

    expect(__autoCompactionInternals.estimateMessagesTokens(shrunk)).toBeLessThanOrEqual(budget);
    expect(shrunk.length).toBeGreaterThan(0);
    expect(shrunk[shrunk.length - 1]?.role).not.toBe("assistant");
    expect(JSON.stringify(shrunk)).toContain(retainedOutputMarker);
    expect(JSON.stringify(shrunk)).not.toContain("tool output omitted by emergency compaction");
  });

  it("preserves the latest user request while shrinking the summary", () => {
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

  it("throws instead of dropping an unsummarized suffix that cannot fit", () => {
    const retainedOutputMarker = `IRREDUCIBLE_SUFFIX_${"x".repeat(4_000)}`;
    const messages: ModelMessage[] = [
      { role: "user", content: "<summary>summary</summary>" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-retained",
            toolName: "bash",
            input: { command: "generate output" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-retained",
            toolName: "bash",
            output: { type: "text", value: retainedOutputMarker },
          },
        ],
      },
      { role: "user", content: "latest request" },
    ];

    expect(() =>
      __autoCompactionInternals.shrinkCompactedMessagesToBudget({
        messages,
        inputBudget: 100,
      }),
    ).toThrow("no retained suffix messages were discarded");
    expect(JSON.stringify(messages)).toContain(retainedOutputMarker);
  });

  it("surfaces a clear failure when an irreducible bounded message cannot fit", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "application/octet-stream",
            data: "x".repeat(1_000),
          },
        ],
      },
    ];

    expect(() =>
      __autoCompactionInternals.shrinkCompactedMessagesToBudget({
        messages,
        inputBudget: 1,
      }),
    ).toThrow("Compaction could not fit bounded context within the input budget");
  });
});
