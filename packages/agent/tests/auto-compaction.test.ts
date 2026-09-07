import { describe, expect, it, spyOn } from "bun:test";
import { jsonSchema, tool, type LanguageModel, type ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { ModelCapability } from "@stanley2058/lilac-utils/model-capability";

import {
  attachAutoCompaction,
  buildSummaryProviderOptions,
  computeInputCompactionBudget,
  __autoCompactionInternals,
} from "../auto-compaction";
import { AiSdkPiAgent } from "../ai-sdk-pi-agent";
import {
  hasMatchingOpenAIServerCompaction,
  materializeOpenAIServerCompaction,
  readOpenAIServerCompactionArtifact,
  type OpenAIServerCompactionArtifact,
} from "../openai-server-compaction";

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

function summaryResponse(summary = "Condensed prior work.") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "summary" },
        { type: "text-delta" as const, id: "summary", delta: summary },
        { type: "text-end" as const, id: "summary" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function serverCompactionArtifact(
  encryptedContent = "encrypted context",
  estimatedTokens = 31,
  replayKey = "test/model",
): OpenAIServerCompactionArtifact {
  const artifact = readOpenAIServerCompactionArtifact({
    type: "custom",
    kind: "openai.compaction",
    providerOptions: {
      openai: {
        type: "compaction",
        itemId: "cmp_123",
        encryptedContent,
      },
      lilac: {
        serverCompaction: {
          formatVersion: 1,
          protocol: "openai-responses-v2",
          replayKey,
          portableSummary: "Condensed prior work.",
          estimatedTokens,
        },
      },
    },
  });
  if (!artifact) throw new Error("Expected a valid OpenAI server compaction artifact.");
  return artifact;
}

describe("auto-compaction internals", () => {
  it("wraps summaries as stable prior context rather than a new request", () => {
    expect(__autoCompactionInternals.buildCompactionSummaryMessage("summary details")).toEqual({
      role: "user",
      content: [
        "<context-compaction>",
        "The conversation before this point was compacted.",
        "Treat this summary as prior conversation context, not as a new user request.",
        "",
        "summary details",
        "</context-compaction>",
      ].join("\n"),
    });
  });

  it("uses native artifact metadata instead of encrypted content to estimate tokens", () => {
    const artifact = serverCompactionArtifact("x".repeat(100_000));
    const message: ModelMessage = {
      role: "assistant",
      content: [artifact.part],
    };

    expect(__autoCompactionInternals.estimateMessageTokens(message)).toBe(31);
  });

  it("retains two continuable turns plus intervening messages", () => {
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
      keepRecentTokens: 10_000,
      keepRecentTurns: 2,
    });

    expect(__autoCompactionInternals.hasCompletedAssistantToolTurn(messages, 4)).toBe(true);
    expect(__autoCompactionInternals.hasCompletedAssistantToolTurn(messages, 3)).toBe(false);
    expect(
      __autoCompactionInternals.chooseRetainedTailStart({
        messages,
        keepRecentTokens: 10_000,
        keepRecentTurns: 2,
      }),
    ).toBe(4);
    expect(boundary).toEqual({ suffixStart: 4 });
    expect(messages.slice(boundary.suffixStart)).toEqual(messages.slice(4));
  });

  it("summarizes an oversized newest atomic tool turn instead of exceeding the cap", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "request" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "oversized-call",
            toolName: "bash",
            input: { command: "large output" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "oversized-call",
            toolName: "bash",
            output: { type: "text", value: "x".repeat(4_000) },
          },
        ],
      },
    ];

    expect(
      __autoCompactionInternals.resolveCompactionBoundary({
        messages,
        keepRecentTokens: 100,
        keepRecentTurns: 2,
      }),
    ).toEqual({ suffixStart: messages.length });
  });

  it("does not retain older server-compaction users past a newer oversized user", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "small older request" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "newer answer" },
    ];

    expect(__autoCompactionInternals.retainServerCompactionUserMessages(messages, 20)).toEqual([]);
  });

  it("summarizes an oversized newest user turn instead of exceeding the hard cap", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "older request" },
      { role: "assistant", content: "older response" },
      { role: "user", content: `large paste ${"x".repeat(4_000)}` },
    ];

    expect(
      __autoCompactionInternals.resolveCompactionBoundary({
        messages,
        keepRecentTokens: 100,
        keepRecentTurns: 2,
      }),
    ).toEqual({ suffixStart: messages.length });
  });

  it("separates a threshold continuation from retained-tail selection", () => {
    const continuation = __autoCompactionInternals.buildAutoContinueMessage();
    const messages: ModelMessage[] = [
      { role: "user", content: "real request" },
      { role: "assistant", content: "completed response" },
      continuation,
    ];

    expect(__autoCompactionInternals.splitThresholdContinueTrailer(messages)).toEqual({
      messages: messages.slice(0, -1),
      trailer: [messages[2]!],
    });
    expect(
      __autoCompactionInternals.splitThresholdContinueTrailer([
        ...messages,
        { role: "user", content: "new actual request" },
      ]),
    ).toEqual({
      messages: [...messages.slice(0, -1), { role: "user", content: "new actual request" }],
      trailer: [],
    });
    expect(
      __autoCompactionInternals.splitThresholdContinueTrailer([
        { role: "user", content: "real request" },
        continuation,
        { role: "assistant", content: "continued response" },
      ]),
    ).toEqual({
      messages: [
        { role: "user", content: "real request" },
        continuation,
        { role: "assistant", content: "continued response" },
      ],
      trailer: [],
    });
  });

  it("forces automatic pressure to summarize a wholly retainable transcript", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "small request" },
      { role: "assistant", content: "small response" },
    ];

    expect(
      __autoCompactionInternals.resolveCompactionBoundary({
        messages,
        keepRecentTokens: 10_000,
        keepRecentTurns: 2,
      }),
    ).toEqual({ suffixStart: 0 });
    expect(
      __autoCompactionInternals.resolveCompactionBoundary({
        messages,
        keepRecentTokens: 10_000,
        keepRecentTurns: 2,
        forceCompaction: true,
      }),
    ).toEqual({ suffixStart: messages.length });
  });

  it("packs under-budget messages into a single summarization call", async () => {
    const messages: ModelMessage[] = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(200)}`,
    }));

    let calls = 0;
    await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages,
      initialChunkTokenBudget: 129_000,
      maxReductionPasses: 6,
      initialMaxCharsPerMessage: 516_000,
      initialMaxCharsTotal: 774_000,
      stage: "history",
      summarizeChunk: async () => {
        calls += 1;
        return "summary";
      },
    });

    expect(calls).toBe(1);
  });

  it("summarizes a below-threshold transcript in one call without pre-splitting", async () => {
    // Exceeds the old 35% split while remaining below the context limit.
    const messages: ModelMessage[] = Array.from({ length: 300 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `msg ${index} ${"x".repeat(2_930)}`,
    }));
    const contextLimit = 369_000;
    const estimated = __autoCompactionInternals.estimateMessagesTokens(messages);
    expect(estimated).toBeGreaterThan(contextLimit * 0.35);
    expect(estimated).toBeLessThan(contextLimit);

    let calls = 0;
    await __autoCompactionInternals.summarizeMessagesHierarchical({
      messages,
      initialChunkTokenBudget: contextLimit,
      maxReductionPasses: 6,
      initialMaxCharsPerMessage: contextLimit * 4,
      initialMaxCharsTotal: contextLimit * 6,
      stage: "history",
      summarizeChunk: async () => {
        calls += 1;
        return "summary";
      },
    });

    expect(calls).toBe(1);
  });

  it("preserves message order and content when packing a segment", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "FIRST" },
      { role: "assistant", content: "SECOND" },
      { role: "user", content: "THIRD" },
    ];

    const segments = __autoCompactionInternals.renderMessagesForSummarySegments(messages, {
      maxCharsPerMessage: 10_000,
      maxCharsTotal: 10_000,
    });

    expect(segments).toHaveLength(1);
    const segment = segments[0] ?? "";
    expect(segment.indexOf("FIRST")).toBeLessThan(segment.indexOf("SECOND"));
    expect(segment.indexOf("SECOND")).toBeLessThan(segment.indexOf("THIRD"));
  });

  it("starts a new segment once the char limit is reached, losing no messages", () => {
    const markers = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT"];
    const messages: ModelMessage[] = markers.map((marker) => ({
      role: "user" as const,
      content: `${marker}${"y".repeat(100)}`,
    }));

    const segments = __autoCompactionInternals.renderMessagesForSummarySegments(messages, {
      maxCharsPerMessage: 250,
      maxCharsTotal: 250,
    });

    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(250);
    }

    const joined = segments.join("\n");
    for (const marker of markers) {
      expect(joined.split(marker)).toHaveLength(2);
    }
    const positions = markers.map((marker) => joined.indexOf(marker));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("flushes buffered messages before splitting an oversized message", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "SMALL" },
      { role: "assistant", content: "z".repeat(600) },
    ];

    const segments = __autoCompactionInternals.renderMessagesForSummarySegments(messages, {
      maxCharsPerMessage: 200,
      maxCharsTotal: 200,
    });

    expect(segments[0]).toContain("SMALL");
    expect(segments.slice(1).every((segment) => segment.startsWith("[message continuation"))).toBe(
      true,
    );
    expect(segments.slice(1).length).toBeGreaterThan(1);
  });

  it("omits inline media payloads from summary text", () => {
    const payload = `RAW_IMAGE_${"a".repeat(10_000)}`;
    const reasoningPayload = `RAW_REASONING_FILE_${"b".repeat(10_000)}`;
    const dataUrl = `data:image/png;base64,${payload}`;
    const remoteUrl = "https://cdn.example.com/reference.png";
    const segments = __autoCompactionInternals.renderMessagesForSummarySegments(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Please inspect this image." },
            { type: "file", mediaType: "image/png", data: payload },
            { type: "file", mediaType: "image/png", data: new URL(remoteUrl) },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "inspect-image",
              toolName: "inspect",
              input: {
                image: dataUrl,
                reasoning: {
                  type: "reasoning-file",
                  mediaType: "application/json",
                  data: { type: "data", data: reasoningPayload },
                },
              },
            },
          ],
        },
      ],
      { maxCharsPerMessage: 20_000, maxCharsTotal: 20_000 },
    );

    expect(segments.join("\n")).toContain("Please inspect this image.");
    expect(segments.join("\n")).toContain("[inline media omitted]");
    expect(segments.join("\n")).toContain(remoteUrl);
    expect(segments.join("\n")).not.toContain(payload);
    expect(segments.join("\n")).not.toContain(reasoningPayload);
    expect(segments.join("\n")).not.toContain(dataUrl);
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
      stage: "history",
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
      stage: "history",
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
    const largeWindow = computeInputCompactionBudget({
      contextLimit: 200_000,
      outputLimit: 16_000,
      thresholdFraction: 0.8,
    });
    expect(largeWindow.earlyInputBudget).toBe(160_000);
    expect(largeWindow.reservedOutputTokens).toBe(40_000);
    expect(largeWindow.safeInputBudget).toBe(160_000);
    expect(largeWindow.inputBudget).toBe(160_000);

    const smallWindow = computeInputCompactionBudget({
      contextLimit: 32_000,
      outputLimit: 12_000,
      thresholdFraction: 0.8,
    });
    expect(smallWindow.earlyInputBudget).toBe(25_600);
    expect(smallWindow.reservedOutputTokens).toBe(12_000);
    expect(smallWindow.safeInputBudget).toBe(20_000);
    expect(smallWindow.inputBudget).toBe(20_000);

    const fullOutputWindow = computeInputCompactionBudget({
      contextLimit: 500_000,
      outputLimit: 500_000,
      thresholdFraction: 0.8,
    });
    expect(fullOutputWindow.reservedOutputTokens).toBe(100_000);
    expect(fullOutputWindow.safeInputBudget).toBe(400_000);
    expect(fullOutputWindow.inputBudget).toBe(400_000);
    expect(__autoCompactionInternals.resolveRetainedTailTokenCap(20_000, 20_000)).toBe(5_000);
  });

  it("uses transcript occupancy instead of cumulative agentic-provider usage", () => {
    const messages: ModelMessage[] = Array.from({ length: 9 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(20_400)}`,
    }));

    const estimated = __autoCompactionInternals.resolveThresholdInputTokens({
      source: "transcript-estimate",
      usageInputTokens: 900_000,
      messages,
    });
    expect(estimated).toBeGreaterThan(45_000);
    expect(estimated).toBeLessThan(47_000);
    expect(
      __autoCompactionInternals.resolveThresholdInputTokens({
        source: "usage",
        usageInputTokens: 900_000,
        messages,
      }),
    ).toBe(900_000);
  });

  it("normalizes configurable threshold fractions", () => {
    expect(__autoCompactionInternals.normalizeThresholdFraction(undefined)).toBe(0.8);
    expect(__autoCompactionInternals.normalizeThresholdFraction(Number.NaN)).toBe(0.8);
    expect(__autoCompactionInternals.normalizeThresholdFraction(0)).toBe(0.05);
    expect(__autoCompactionInternals.normalizeThresholdFraction(1)).toBe(0.95);
    expect(__autoCompactionInternals.normalizeThresholdFraction(0.6)).toBe(0.6);
  });

  it("drops discarded reasoning summaries from summarization provider options", () => {
    expect(
      buildSummaryProviderOptions({
        openai: {
          store: false,
          include: ["reasoning.encrypted_content"],
          reasoningSummary: "detailed",
        },
        anthropic: { cacheControl: "ephemeral" },
      }),
    ).toEqual({
      openai: { store: false, include: ["reasoning.encrypted_content"] },
      anthropic: { cacheControl: "ephemeral" },
    });
    expect(buildSummaryProviderOptions(undefined)).toBeUndefined();
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

  it("forwards turn error provenance to the wrapped base handler", async () => {
    const transformError = new Error("base transform failed");
    const phases: Array<string | undefined> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "test/main",
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      resolveContextLimit: async () => ({ context: 100_000, output: 10_000 }),
      prepareFullModelView: () => {
        throw transformError;
      },
      baseTurnErrorHandler: (_error, context) => {
        phases.push(context.phase);
        return "fail";
      },
    });

    try {
      await expect(agent.prompt("fail before model call")).rejects.toBe(transformError);
      expect(phases).toEqual(["transform-messages"]);
    } finally {
      detach();
    }
  });

  it("does not compact or auto-continue a terminal stop turn", async () => {
    const mainModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "text" },
            { type: "text-delta" as const, id: "text", delta: "final answer" },
            { type: "text-end" as const, id: "text" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: {
                ...zeroUsage(),
                inputTokens: {
                  total: 900_000,
                  noCache: 100_000,
                  cacheRead: 800_000,
                  cacheWrite: 0,
                },
              },
            },
          ],
        }),
      }),
    });
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "summary" },
              { type: "text-delta" as const, id: "summary", delta: "## Objective\n- Continue." },
              { type: "text-end" as const, id: "summary" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        };
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: "prior request" },
        { role: "assistant", content: "prior response" },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 1_000_000, output: 200_000 }),
    });

    try {
      await agent.prompt("small request");
      expect(summaryCalls).toBe(0);
      expect(mainModel.doStreamCalls).toHaveLength(1);
      expect(agent.state.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(JSON.stringify(agent.state.messages)).not.toContain("Continue if you have next steps");

      await agent.prompt("next request");
    } finally {
      detach();
    }

    expect(summaryCalls).toBe(1);
    expect(mainModel.doStreamCalls).toHaveLength(2);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(agent.state.messages[0]?.content).toContain("<context-compaction>");
    expect(agent.state.messages.at(-2)?.content).toBe("next request");
    expect(JSON.stringify(agent.state.messages)).not.toContain("Continue if you have next steps");
  });

  it("compacts and resumes an ordinary length-truncated turn once", async () => {
    const response = (text: string, finishReason: "length" | "stop") => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: text },
          { type: "text-delta" as const, id: text, delta: text },
          { type: "text-end" as const, id: text },
          {
            type: "finish" as const,
            finishReason: { unified: finishReason, raw: finishReason },
            usage: zeroUsage(),
          },
        ],
      }),
    });
    const mainModel = new MockLanguageModelV4({
      doStream: [response("truncated answer", "length"), response("finished answer", "stop")],
    });
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        return summaryResponse("Length-truncated work is ready to continue.");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: "older request" },
        { role: "assistant", content: "older answer" },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("complete the work");
    } finally {
      detach();
    }

    expect(mainModel.doStreamCalls).toHaveLength(2);
    expect(summaryCalls).toBeGreaterThan(0);
    expect(agent.state.messages[0]?.content).toContain("<context-compaction>");
    expect(JSON.stringify(agent.state.messages)).toContain("finished answer");
  });

  it("does not execute a length-truncated tool call and closes it before recovery", async () => {
    const mainModel = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "truncated-call",
                toolName: "write_file",
                input: '{"path":"partial.txt"}',
              },
              {
                type: "finish",
                finishReason: { unified: "length", raw: "length" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        summaryResponse("recovered without running the truncated call"),
      ],
    });
    let executions = 0;
    let summaryInput = "";
    const summaryModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        summaryInput = JSON.stringify(prompt);
        return summaryResponse("Truncated tool call was rejected.");
      },
    });
    const firstTurnMessages: ModelMessage[][] = [];
    const truncatedResultEvents: Array<{
      type: "message_start" | "message_end";
      message: ModelMessage;
    }> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: "older request" },
        { role: "assistant", content: "older answer" },
      ],
      tools: {
        write_file: tool({
          inputSchema: jsonSchema({ type: "object" }),
          execute: () => {
            executions += 1;
            return "written";
          },
        }),
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_end") firstTurnMessages.push(event.newMessages);
      if (
        (event.type === "message_start" || event.type === "message_end") &&
        event.message.role === "tool" &&
        event.message.content.some(
          (part) => part.type === "tool-result" && part.toolCallId === "truncated-call",
        )
      ) {
        truncatedResultEvents.push({ type: event.type, message: event.message });
      }
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("write the file");
    } finally {
      detach();
    }

    expect(executions).toBe(0);
    expect(mainModel.doStreamCalls).toHaveLength(2);
    expect(summaryInput).toContain("older request");
    expect(JSON.stringify(mainModel.doStreamCalls[1]?.prompt)).toContain(
      "was not executed because the model output was truncated",
    );
    expect(firstTurnMessages[0]?.at(-1)).toEqual({
      role: "tool",
      content: [
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "truncated-call",
          output: expect.objectContaining({ type: "error-text" }),
        }),
      ],
    });
    expect(truncatedResultEvents.map((event) => event.type)).toEqual([
      "message_start",
      "message_end",
    ]);
    expect(truncatedResultEvents[1]?.message).toEqual(firstTurnMessages[0]?.at(-1));
  });

  it("does not let the estimate override known usage for usage-source providers", async () => {
    const response = (text: string) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "text" },
          { type: "text-delta" as const, id: "text", delta: text },
          { type: "text-end" as const, id: "text" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: {
              ...zeroUsage(),
              inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
            },
          },
        ],
      }),
    });
    let mainCalls = 0;
    const mainModel = new MockLanguageModelV4({
      doStream: async () => {
        mainCalls += 1;
        return response(mainCalls === 1 ? `large response ${"x".repeat(40_000)}` : "done");
      },
    });
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        throw new Error("usage-source estimate must not force compaction");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "usage",
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("first");
      await agent.prompt("second");
    } finally {
      detach();
    }

    expect(mainCalls).toBe(2);
    expect(summaryCalls).toBe(0);
  });

  it("does not infer fresh-request occupancy from inline media bytes", async () => {
    const payload = `RAW_IMAGE_${"a".repeat(40_000)}`;
    const mainModel = new MockLanguageModelV4({ doStream: async () => summaryResponse("answer") });
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        throw new Error("inline media bytes must not schedule compaction");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        {
          role: "user",
          content: [{ type: "file", mediaType: "image/png", data: payload }],
        },
        { role: "assistant", content: "image reviewed" },
        { role: "user", content: "prior follow-up" },
        { role: "assistant", content: "prior answer" },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "usage",
      keepRecentTurns: 1,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("continue");
    } finally {
      detach();
    }

    expect(mainModel.doStreamCalls).toHaveLength(1);
    expect(summaryCalls).toBe(0);
  });

  it("does not compact when the model-view transform omits media", async () => {
    const mainModel = new MockLanguageModelV4({ doStream: async () => summaryResponse("answer") });
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        throw new Error("media pruning must not schedule compaction");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "old image" },
            { type: "file", mediaType: "image/png", data: "aGVsbG8=" },
          ],
        },
        { role: "assistant", content: "image reviewed" },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "usage",
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      prepareFullModelView: (messages) =>
        messages.map((message): ModelMessage => {
          if (message.role !== "user" || !Array.isArray(message.content)) return message;
          return {
            ...message,
            content: message.content.map((part) =>
              part.type === "file"
                ? { type: "text" as const, text: "Image omitted after its inline limit." }
                : part,
            ),
          };
        }),
    });

    try {
      await agent.prompt("first follow-up");
      await agent.prompt("second follow-up");
    } finally {
      detach();
    }

    expect(mainModel.doStreamCalls).toHaveLength(2);
    expect(summaryCalls).toBe(0);
  });

  it("uses full-input preflight for a fresh agent with no prior usage", async () => {
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "summary" },
              { type: "text-delta" as const, id: "summary", delta: "## Objective\n- Continue." },
              { type: "text-end" as const, id: "summary" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        };
      },
    });
    const mainModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start" as const, id: "text" },
            { type: "text-delta" as const, id: "text", delta: "new answer" },
            { type: "text-end" as const, id: "text" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage: zeroUsage(),
            },
          ],
        }),
      }),
    });
    const agent = new AiSdkPiAgent({
      system: `large system ${"s".repeat(20_000)}`,
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: "prior request" },
        { role: "assistant", content: `prior response ${"x".repeat(20_000)}` },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "usage",
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("new request");
    } finally {
      detach();
    }

    expect(summaryCalls).toBe(1);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(agent.state.messages[1]?.content).toBe("new request");
  });

  it("restores a final threshold trailer and preserves it across a failed compaction retry", async () => {
    const response = (text: string, inputTokens: number) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "text" },
          { type: "text-delta" as const, id: "text", delta: text },
          { type: "text-end" as const, id: "text" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: {
              ...zeroUsage(),
              inputTokens: {
                total: inputTokens,
                noCache: inputTokens,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          },
        ],
      }),
    });
    let mainCalls = 0;
    const mainModel = new MockLanguageModelV4({
      doStream: async () => {
        mainCalls += 1;
        return response("continued response", 100);
      },
    });
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        if (summaryCalls === 1) throw new Error("summary unavailable");
        return response("## Objective\n- Retry succeeded.", 100);
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: `old request ${"a".repeat(20_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(20_000)}` },
        { role: "user", content: "middle request" },
        { role: "assistant", content: "middle response" },
        { role: "user", content: "recent request" },
        { role: "assistant", content: "initial response" },
        __autoCompactionInternals.buildAutoContinueMessage(),
      ],
    });
    const statuses: string[] = [];
    let completedEstimate = 0;
    let completedBudget = 0;
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      onCompactionEnd: ({ status, estimatedInputTokensAfter, budget }) => {
        statuses.push(status);
        if (status !== "completed") return;
        completedEstimate = estimatedInputTokensAfter ?? 0;
        completedBudget = budget.inputBudget;
      },
    });

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    let summaryCallsAfterRetry = 0;
    try {
      await expect(agent.continue()).rejects.toThrow();
      await agent.continue();
      summaryCallsAfterRetry = summaryCalls;
      await agent.prompt("later request");
    } finally {
      errorSpy.mockRestore();
      detach();
    }

    const serialized = JSON.stringify(agent.state.messages);
    const continuation =
      "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
    expect(summaryCallsAfterRetry).toBeGreaterThan(1);
    expect(summaryCalls).toBe(summaryCallsAfterRetry);
    expect(mainCalls).toBe(2);
    expect(statuses).toEqual(["failed", "completed"]);
    expect(completedEstimate).toBeLessThanOrEqual(completedBudget);
    expect(serialized.split(continuation)).toHaveLength(2);
    expect(agent.state.messages[0]?.content).toContain("<context-compaction>");
    expect(agent.state.messages.at(-2)?.content).toBe("later request");
    expect(agent.state.messages.at(-1)?.role).toBe("assistant");
  });

  it("drops a reconstructed threshold trailer when a real user prompt supersedes it", async () => {
    let modelInput = "";
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        modelInput = JSON.stringify(prompt);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "text" },
              { type: "text-delta" as const, id: "text", delta: "new response" },
              { type: "text-end" as const, id: "text" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        };
      },
    });
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        throw new Error("stale small marker must not force compaction");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: "old request" },
        { role: "assistant", content: "old response" },
        __autoCompactionInternals.buildAutoContinueMessage(),
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("new actual request");
    } finally {
      detach();
    }

    expect(modelInput).not.toContain("autoCompactionContinue");
    expect(modelInput).not.toContain("Continue if you have next steps");
    expect(summaryCalls).toBe(0);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(agent.state.messages[2]?.content).toBe("new actual request");
    expect(JSON.stringify(agent.state.messages)).not.toContain("autoCompactionContinue");
  });

  it("compacts an over-budget restored transcript after removing a superseded trailer", async () => {
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        return summaryResponse("Restored transcript summary.");
      },
    });
    let providerInvokedBeforeCompaction = false;
    const mainModel = new MockLanguageModelV4({
      doStream: async () => {
        providerInvokedBeforeCompaction = summaryCalls === 0;
        return summaryResponse("new response");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: `old request ${"a".repeat(20_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(20_000)}` },
        __autoCompactionInternals.buildAutoContinueMessage(),
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "transcript-estimate",
      keepRecentTurns: 1,
      keepRecentTokens: 500,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("new actual request");
    } finally {
      detach();
    }

    expect(summaryCalls).toBeGreaterThan(0);
    expect(providerInvokedBeforeCompaction).toBe(false);
    expect(mainModel.doStreamCalls).toHaveLength(1);
    expect(agent.state.messages[0]?.content).toContain("Restored transcript summary.");
    expect(agent.state.messages.at(-2)?.content).toBe("new actual request");
    expect(JSON.stringify(agent.state.messages)).not.toContain("autoCompactionContinue");
  });

  it("uses explicit context and output limits without fetching model capabilities", async () => {
    let capabilityFetches = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "custom/private-model",
    });

    const resolved = await __autoCompactionInternals.resolveContextLimit({
      agent,
      options: {
        model: "custom/private-model",
        modelCapability: new ModelCapability({
          fetch: Object.assign(
            async () => {
              capabilityFetches += 1;
              throw new Error("model capability fetch must not run");
            },
            { preconnect() {} },
          ),
        }),
        resolveContextLimit: async () => ({ context: 32_000, output: 12_000 }),
      },
    });

    expect(capabilityFetches).toBe(0);
    expect(resolved).toMatchObject({
      known: true,
      contextLimit: 32_000,
      outputLimit: 12_000,
    });
  });

  it("keeps numeric explicit context resolvers compatible", async () => {
    let capabilityFetches = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "custom/private-model",
    });

    const resolved = await __autoCompactionInternals.resolveContextLimit({
      agent,
      options: {
        model: "custom/private-model",
        modelCapability: new ModelCapability({
          fetch: Object.assign(
            async () => {
              capabilityFetches += 1;
              throw new Error("model capability fetch must not run");
            },
            { preconnect() {} },
          ),
        }),
        resolveContextLimit: async () => 32_000,
      },
    });

    expect(capabilityFetches).toBe(0);
    expect(resolved).toMatchObject({ known: true, contextLimit: 32_000, outputLimit: 0 });
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

  it("preserves a complete inline provider tool exchange", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "inline-call",
            toolName: "mcp__lilac__read",
            input: { path: "README.md" },
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "inline-call",
            toolName: "mcp__lilac__read",
            output: { type: "text", value: "contents" },
          },
          { type: "text", text: "done" },
        ],
      },
    ];

    expect(__autoCompactionInternals.isValidSuffix(messages, 0)).toBe(true);
    expect(__autoCompactionInternals.repairTranscriptForCompaction(messages)).toEqual({
      messages,
      droppedDanglingToolCallParts: 0,
      droppedOrphanToolResultParts: 0,
      droppedEmptyAssistantMessages: 0,
      droppedEmptyToolMessages: 0,
    });
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
      summary,
    });

    expect(__autoCompactionInternals.estimateMessagesTokens(shrunk.messages)).toBeLessThanOrEqual(
      budget,
    );
    expect(shrunk.messages.length).toBeGreaterThan(0);
    expect(shrunk.messages[shrunk.messages.length - 1]?.role).not.toBe("assistant");
    expect(JSON.stringify(shrunk.messages)).toContain(retainedOutputMarker);
    expect(JSON.stringify(shrunk.messages)).not.toContain(
      "tool output omitted by emergency compaction",
    );
    // The reported summary is the truncated one the model will actually see.
    expect(shrunk.summary.length).toBeLessThan(summary.length);
    const first = shrunk.messages[0];
    expect(typeof first?.content === "string" && first.content.includes(shrunk.summary)).toBe(true);
  });

  it("preserves the latest user request while shrinking the summary", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: `<summary>\n${"s".repeat(3_000)}\n</summary>` },
      { role: "user", content: "Please continue from here and make sure tests pass." },
    ];

    const { messages: shrunk } = __autoCompactionInternals.shrinkCompactedMessagesToBudget({
      messages,
      inputBudget: 300,
      summary: "s".repeat(3_000),
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
        summary: "summary",
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
        summary: "",
      }),
    ).toThrow("Compaction could not fit bounded context within the input budget");
  });

  it("activates a generated server-compaction view so rejection retries its portable summary", async () => {
    const nativeReplayError = new Error("generated native replay rejected");
    const prompts: string[] = [];
    let mainCalls = 0;
    const mainModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        mainCalls += 1;
        prompts.push(JSON.stringify(prompt));
        if (mainCalls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [{ type: "error" as const, error: nativeReplayError }],
            }),
          };
        }
        return summaryResponse("portable retry succeeded");
      },
    });
    const summaryModel = new MockLanguageModelV4({ doStream: summaryResponse() });
    let serverReplayEnabled = true;
    let nativeReplayActive = false;
    const replayKey = "test/model";
    const prepareFullModelView = (messages: readonly ModelMessage[]) => {
      const activeKey = serverReplayEnabled ? replayKey : undefined;
      nativeReplayActive = hasMatchingOpenAIServerCompaction(messages, activeKey);
      return materializeOpenAIServerCompaction(messages, activeKey);
    };
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: `old request ${"a".repeat(8_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(8_000)}` },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "transcript-estimate",
      thresholdFraction: 0.25,
      keepRecentTurns: 1,
      keepRecentTokens: 100,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      prepareFullModelView,
      serverCompactionEnabled: () => serverReplayEnabled,
      serverCompaction: async () => serverCompactionArtifact("generated encrypted context"),
      baseTurnErrorHandler: (error, context) => {
        if (
          error === nativeReplayError &&
          nativeReplayActive &&
          context.phase === "model-call" &&
          context.retrySafety.canRetry
        ) {
          serverReplayEnabled = false;
          nativeReplayActive = false;
          return "retry";
        }
        return "fail";
      },
    });

    try {
      await agent.prompt("latest request remains verbatim");
    } finally {
      detach();
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("generated encrypted context");
    expect(prompts[1]).toContain("Condensed prior work.");
    expect(prompts[1]).not.toContain("generated encrypted context");
    expect(JSON.stringify(agent.state.messages)).not.toContain("generated encrypted context");
  });

  it("materializes a cached server-compaction view when the replay key changes", async () => {
    const firstModelError = new Error("advance to another replay key");
    const prompts: string[] = [];
    let mainCalls = 0;
    const mainModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        mainCalls += 1;
        prompts.push(JSON.stringify(prompt));
        if (mainCalls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [{ type: "error" as const, error: firstModelError }],
            }),
          };
        }
        return summaryResponse("replacement model response");
      },
    });
    const summaryModel = new MockLanguageModelV4({ doStream: summaryResponse() });
    let activeReplayKey = "test/model-a";
    const prepareFullModelView = (messages: readonly ModelMessage[]) =>
      materializeOpenAIServerCompaction(messages, activeReplayKey);
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main-a",
      messages: [
        { role: "user", content: `old request ${"a".repeat(8_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(8_000)}` },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main-a",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "transcript-estimate",
      thresholdFraction: 0.25,
      keepRecentTurns: 1,
      keepRecentTokens: 100,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      prepareFullModelView,
      serverCompactionEnabled: () => true,
      serverCompaction: async () =>
        serverCompactionArtifact("model-a encrypted context", 31, "test/model-a"),
      baseTurnErrorHandler: (error, context) => {
        if (error !== firstModelError || !context.retrySafety.canRetry) return "fail";
        activeReplayKey = "test/model-b";
        return "retry";
      },
    });

    try {
      await agent.prompt("latest request remains verbatim");
    } finally {
      detach();
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("model-a encrypted context");
    expect(prompts[1]).toContain("Condensed prior work.");
    expect(prompts[1]).not.toContain("model-a encrypted context");
  });

  it("skips server compaction when the automatic path is dynamically disabled", async () => {
    let summaryCalls = 0;
    let serverCalls = 0;
    const mainModel = new MockLanguageModelV4({
      doStream: async () => summaryResponse("continued response"),
    });
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        return summaryResponse();
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old response ${"b".repeat(6_000)}` },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      thresholdFraction: 0.25,
      serverCompactionEnabled: () => false,
      serverCompaction: async () => {
        serverCalls += 1;
        return serverCompactionArtifact();
      },
    });

    try {
      await agent.prompt("latest request remains verbatim");
    } finally {
      detach();
    }

    expect(summaryCalls).toBe(1);
    expect(serverCalls).toBe(0);
    expect(agent.state.messages[0]?.role).toBe("user");
    expect(agent.state.messages[0]?.content).toContain("<context-compaction>");
  });

  it("summarizes an expanding prepared prefix while preserving the canonical suffix and excluding overlays and decoration", async () => {
    let summaryPrompt = "";
    const summaryModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        summaryPrompt = JSON.stringify(prompt);
        return summaryResponse("Prepared prefix summary.");
      },
    });
    const mainModel = new MockLanguageModelV4({
      doStream: async () => summaryResponse("answer"),
    });
    const latest: ModelMessage = {
      role: "user",
      content: "latest canonical request",
      providerOptions: { test: { canonical: true } },
    };
    let overlayRevision = 0;
    let seamCanonical: readonly ModelMessage[] = [];
    let seamFullBudgetView: readonly ModelMessage[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: `old request ${"a".repeat(50_000)}` },
        { role: "assistant", content: `CANONICAL_UNPRUNED_${"b".repeat(8_000)}` },
      ],
      prepareModelCall: ({ canonicalMessages, fullBudgetView, runtime, payload }) => {
        seamCanonical = canonicalMessages;
        seamFullBudgetView = fullBudgetView;
        return { runtime, payload };
      },
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "transcript-estimate",
      keepRecentTurns: 1,
      keepRecentTokens: 500,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      prepareFullModelView: (messages) =>
        messages.flatMap((message): ModelMessage[] => {
          if (message.role !== "assistant" || typeof message.content !== "string") {
            return [{ ...message }];
          }
          return [
            { role: "assistant", content: "PREPARED_PRUNED_PART_ONE" },
            { role: "assistant", content: "PREPARED_PRUNED_PART_TWO" },
          ];
        }),
      buildEphemeralOverlay: () => {
        overlayRevision += 1;
        return [{ role: "user", content: `EPHEMERAL_OVERLAY_${overlayRevision}` }];
      },
      decorateRequestPayload: (payload) => {
        const last = payload.at(-1);
        if (last?.role !== "user") return [...payload];
        return [
          ...payload.slice(0, -1),
          { ...last, providerOptions: { test: { finalDecoration: true } } },
        ];
      },
    });

    try {
      await agent.prompt(latest);
    } finally {
      detach();
    }

    expect(summaryPrompt).toContain("PREPARED_PRUNED_PART_ONE");
    expect(summaryPrompt).toContain("PREPARED_PRUNED_PART_TWO");
    expect(summaryPrompt).not.toContain("CANONICAL_UNPRUNED");
    expect(summaryPrompt).not.toContain("EPHEMERAL_OVERLAY");
    expect(JSON.stringify(seamCanonical[0])).toContain("Prepared prefix summary.");
    expect(seamCanonical[1]).toEqual(latest);
    expect(JSON.stringify(seamFullBudgetView)).toContain("EPHEMERAL_OVERLAY");
    expect(agent.state.messages[1]).toEqual(latest);
    expect(JSON.stringify(agent.state.messages)).not.toContain("PREPARED_PRUNED");
    expect(JSON.stringify(agent.state.messages)).not.toContain("EPHEMERAL_OVERLAY");
    expect(JSON.stringify(agent.state.messages)).not.toContain("finalDecoration");
    const payload = JSON.stringify(mainModel.doStreamCalls[0]?.prompt);
    expect(payload).toContain(`EPHEMERAL_OVERLAY_${overlayRevision}`);
    expect(payload).toContain("finalDecoration");
  });

  it("includes the current overlay in preflight estimates without summarizing or persisting it", async () => {
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        summaryCalls += 1;
        expect(JSON.stringify(prompt)).not.toContain("OVERLAY_BUDGET_PRESSURE");
        return summaryResponse("Overlay-aware summary.");
      },
    });
    const mainModel = new MockLanguageModelV4({
      doStream: async () => summaryResponse("done"),
    });
    let overlayRevision = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: `older ${"a".repeat(3_000)}` },
        { role: "assistant", content: `answer ${"b".repeat(2_000)}` },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "transcript-estimate",
      keepRecentTurns: 1,
      keepRecentTokens: 100,
      resolveContextLimit: async () => ({ context: 6_000, output: 2_000 }),
      buildEphemeralOverlay: () => {
        overlayRevision += 1;
        return [
          {
            role: "user",
            content: `OVERLAY_BUDGET_PRESSURE_${overlayRevision}_${"x".repeat(12_000)}`,
          },
        ];
      },
    });

    try {
      await agent.prompt("latest");
    } finally {
      detach();
    }

    expect(summaryCalls).toBe(1);
    expect(JSON.stringify(agent.state.messages)).not.toContain("OVERLAY_BUDGET_PRESSURE");
    expect(JSON.stringify(mainModel.doStreamCalls[0]?.prompt)).toContain(
      `OVERLAY_BUDGET_PRESSURE_${overlayRevision}`,
    );
  });

  it("uses an input estimate floor to trigger compaction and re-evaluates it with a fresh overlay", async () => {
    let summaryCalls = 0;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summaryCalls += 1;
        return summaryResponse("Floor-aware summary.");
      },
    });
    const mainModel = new MockLanguageModelV4({
      doStream: async () => summaryResponse("done"),
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: mainModel,
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: `older request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `older answer ${"b".repeat(6_000)}` },
      ],
    });
    let overlayRevision = 0;
    const floorCalls: Array<{
      readonly canonicalCount: number;
      readonly preparedCount: number;
      readonly overlay: string;
      readonly ordinaryEstimate: number;
      readonly suffixAndOverlayEstimate: number;
    }> = [];
    let startEstimate = 0;
    let endEstimate = 0;
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel,
      thresholdInputSource: "transcript-estimate",
      keepRecentTurns: 1,
      keepRecentTokens: 100,
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      buildEphemeralOverlay: () => {
        overlayRevision += 1;
        return [{ role: "user", content: `FLOOR_OVERLAY_${overlayRevision}` }];
      },
      inputEstimateFloor: ({
        canonicalMessages,
        preparedFullView,
        overlay,
        context,
        ordinaryModelInputEstimate,
        estimateMessagesTokens,
      }) => {
        expect(context.system).toBe("test");
        floorCalls.push({
          canonicalCount: canonicalMessages.length,
          preparedCount: preparedFullView.length,
          overlay: JSON.stringify(overlay),
          ordinaryEstimate: ordinaryModelInputEstimate,
          suffixAndOverlayEstimate: estimateMessagesTokens([
            ...canonicalMessages.slice(-1),
            ...overlay,
          ]),
        });
        return floorCalls.length === 1 ? 9_000 : 7_000;
      },
      onCompactionStart: ({ estimatedInputTokens }) => {
        startEstimate = estimatedInputTokens;
      },
      onCompactionEnd: ({ status, estimatedInputTokensAfter }) => {
        if (status === "completed") endEstimate = estimatedInputTokensAfter ?? 0;
      },
    });

    try {
      await agent.prompt("latest request");
    } finally {
      detach();
    }

    expect(summaryCalls).toBe(1);
    expect(floorCalls).toHaveLength(2);
    expect(floorCalls[0]).toMatchObject({ canonicalCount: 3, preparedCount: 3 });
    expect(floorCalls[0]?.ordinaryEstimate).toBeLessThan(8_000);
    expect(floorCalls[0]?.suffixAndOverlayEstimate).toBeLessThan(
      floorCalls[0]?.ordinaryEstimate ?? 0,
    );
    expect(floorCalls[0]?.overlay).toContain("FLOOR_OVERLAY_1");
    expect(floorCalls[1]?.overlay).toContain("FLOOR_OVERLAY_2");
    expect(floorCalls[1]?.ordinaryEstimate).toBeLessThan(7_000);
    expect(startEstimate).toBe(9_000);
    expect(endEstimate).toBe(7_000);
  });

  it("rejects an invalid input estimate floor", async () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: new MockLanguageModelV4({ doStream: async () => summaryResponse("unused") }),
      modelSpecifier: "test/main",
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
      inputEstimateFloor: () => Number.NaN,
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(agent.prompt("reject invalid floor")).rejects.toThrow(
        "input estimate floor must return null or a finite non-negative number",
      );
    } finally {
      errorSpy.mockRestore();
      detach();
    }
  });

  it("keeps ordinary preflight behavior when the input estimate floor is omitted", async () => {
    let summaryCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: new MockLanguageModelV4({ doStream: async () => summaryResponse("done") }),
      modelSpecifier: "test/main",
      messages: [
        { role: "user", content: "small prior request" },
        { role: "assistant", content: "small prior response" },
      ],
    });
    const detach = await attachAutoCompaction(agent, {
      model: "test/main",
      modelCapability: new ModelCapability({ fetch: createRegistryFetch({}) }),
      summaryModel: new MockLanguageModelV4({
        doStream: async () => {
          summaryCalls += 1;
          return summaryResponse("unexpected");
        },
      }),
      resolveContextLimit: async () => ({ context: 10_000, output: 1_000 }),
    });

    try {
      await agent.prompt("small current request");
    } finally {
      detach();
    }

    expect(summaryCalls).toBe(0);
    expect(agent.state.messages[0]?.content).toBe("small prior request");
  });
});
