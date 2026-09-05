import { describe, expect, it } from "bun:test";
import { tool, type ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";

import {
  SERVER_COMPACTION_REQUEST_HEADER,
  SERVER_COMPACTION_REQUEST_MARKER,
} from "@stanley2058/lilac-utils/server-compaction-request";

import {
  compactWithOpenAIResponses,
  compactWithOpenAIResponsesResult,
  declarationOnlyServerCompactionTools,
  materializeOpenAIServerCompaction,
  readOpenAIServerCompactionArtifact,
} from "../openai-server-compaction";

function compactionPart(params: {
  replayKey?: string;
  portableSummary?: string;
  estimatedTokens?: number;
  unexpectedMetadata?: boolean;
}) {
  return {
    type: "custom" as const,
    kind: "openai.compaction" as const,
    providerOptions: {
      openai: {
        type: "compaction",
        itemId: "cmp_123",
        encryptedContent: "ciphertext".repeat(10_000),
      },
      lilac: {
        serverCompaction: {
          formatVersion: 1 as const,
          protocol: "openai-responses-v2" as const,
          replayKey: params.replayKey ?? "workspace/model",
          portableSummary: params.portableSummary ?? "Portable prior context.",
          estimatedTokens: params.estimatedTokens ?? 73,
          ...(params.unexpectedMetadata ? { unexpectedMetadata: true } : {}),
        },
      },
    },
  };
}

function artifactMessage(part: unknown): ModelMessage {
  const artifact = readOpenAIServerCompactionArtifact(part);
  if (!artifact) throw new Error("Expected a valid OpenAI server compaction artifact.");
  return { role: "assistant", content: [artifact.part] };
}

describe("OpenAI server compaction artifacts", () => {
  it("keeps only non-executable function declarations", () => {
    const tools = declarationOnlyServerCompactionTools({
      local: tool({ inputSchema: z.object({}), execute: () => "executed" }),
      hosted: Object.assign(tool({ inputSchema: z.object({}) }), {
        type: "provider" as const,
        id: "openai.web_search",
        args: {},
      }),
    });

    expect(Object.keys(tools)).toEqual(["local"]);
    expect(tools.local).not.toHaveProperty("execute");
  });

  it("creates a marked stateless artifact from exactly one provider compaction part", async () => {
    let toolExecutions = 0;
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "dangerous-call",
              toolName: "dangerous",
              input: "{}",
            },
            {
              type: "custom",
              kind: "openai.compaction",
              providerMetadata: {
                openai: {
                  type: "compaction",
                  itemId: "cmp_native",
                  encryptedContent: "encrypted-native-state",
                },
              },
            },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            },
          ],
        }),
      },
    });

    const artifact = await compactWithOpenAIResponses({
      model,
      replayKey: "openai:openai/gpt-test",
      portableSummary: "Portable summary with enough text to estimate.",
      messages: [{ role: "user", content: "history" }],
      system: "system",
      tools: {
        dangerous: tool({
          inputSchema: z.object({}),
          execute: () => {
            toolExecutions += 1;
            return "executed";
          },
        }),
      },
      providerOptions: { openai: { store: true, include: ["file_search_call.results"] } },
    });

    expect(toolExecutions).toBe(0);
    expect(artifact.metadata.estimatedTokens).toBeGreaterThan(1);
    expect(artifact.metadata.portableSummary).toBe(
      "Portable summary with enough text to estimate.",
    );
    expect(model.doStreamCalls[0]?.headers?.[SERVER_COMPACTION_REQUEST_HEADER]).toBe(
      SERVER_COMPACTION_REQUEST_MARKER,
    );
    expect(model.doStreamCalls[0]?.providerOptions).toEqual({
      openai: {
        store: false,
        include: ["file_search_call.results", "reasoning.encrypted_content"],
      },
    });
  });

  it("returns an owned error when the provider omits its compaction part", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            },
          ],
        }),
      },
    });

    const result = await compactWithOpenAIResponsesResult({
      model,
      replayKey: "openai:openai/gpt-test",
      portableSummary: "Portable summary.",
      messages: [{ role: "user", content: "history" }],
      system: "system",
    });

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "OpenAIServerCompactionOutputInvalid", outputCount: 0 },
    });
  });

  it("rejects invalid generated metadata before activating the native artifact", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "custom",
              kind: "openai.compaction",
              providerMetadata: {
                openai: {
                  type: "compaction",
                  itemId: "cmp_invalid_metadata",
                  encryptedContent: "encrypted-native-state",
                },
              },
            },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            },
          ],
        }),
      },
    });

    const result = await compactWithOpenAIResponsesResult({
      model,
      replayKey: "",
      portableSummary: "Portable summary remains available for local fallback.",
      messages: [{ role: "user", content: "history" }],
      system: "system",
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        _tag: "OpenAIServerCompactionOutputInvalid",
        reason: "generated-artifact",
        outputCount: 1,
      },
    });
  });

  it("returns owned cancellation only for its exact aborted signal", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({ chunks: [] }),
      },
    });

    const result = await compactWithOpenAIResponsesResult({
      model,
      replayKey: "openai:openai/gpt-test",
      portableSummary: "Portable summary.",
      messages: [{ role: "user", content: "history" }],
      system: "system",
      abortSignal: controller.signal,
    });

    expect(result).toMatchObject({
      status: "error",
      error: { _tag: "OpenAIServerCompactionAborted" },
    });
  });

  it("keeps a strictly valid native artifact when its replay key matches", () => {
    const artifact = artifactMessage(compactionPart({ replayKey: "workspace/model" }));
    const messages: ModelMessage[] = [
      { role: "user", content: "before compaction" },
      artifact,
      { role: "user", content: "descendant request" },
    ];

    expect(readOpenAIServerCompactionArtifact(artifact.content[0])).not.toBeNull();
    expect(materializeOpenAIServerCompaction(messages, "workspace/model")).toEqual(messages);
  });

  it("materializes URL-backed file parts without deep-cloning runtime values", () => {
    const url = new URL("https://example.com/context.pdf");
    const filePart = {
      type: "file" as const,
      data: url,
      mediaType: "application/pdf",
    };
    const messages: ModelMessage[] = [{ role: "user", content: [filePart] }];

    const materialized = materializeOpenAIServerCompaction(messages, "workspace/model");
    const message = materialized[0];
    if (message?.role !== "user" || !Array.isArray(message.content)) {
      throw new Error("Expected a user message with multipart content.");
    }
    const part = message.content[0];
    if (part?.type !== "file") throw new Error("Expected a file part.");

    expect(message).not.toBe(messages[0]);
    expect(part).not.toBe(filePart);
    expect(part.data).toBe(url);
  });

  it("projects a portable summary for a mismatched or unavailable replay key", () => {
    const artifact = artifactMessage(
      compactionPart({ replayKey: "workspace/original", portableSummary: "Portable summary." }),
    );
    const messages: ModelMessage[] = [
      { role: "user", content: "before compaction" },
      artifact,
      { role: "assistant", content: "descendant response" },
      { role: "user", content: "descendant request" },
    ];
    const expected = [
      {
        role: "user" as const,
        content: [
          "<context-compaction>",
          "The conversation before this point was compacted.",
          "Treat this summary as prior conversation context, not as a new user request.",
          "",
          "Portable summary.",
          "</context-compaction>",
        ].join("\n"),
      },
      ...messages.slice(2),
    ];

    expect(materializeOpenAIServerCompaction(messages, "workspace/other")).toEqual(expected);
    expect(materializeOpenAIServerCompaction(messages, undefined)).toEqual(expected);
  });

  it("drops recognizable compaction parts with unreadable metadata", () => {
    const malformedPart = compactionPart({ estimatedTokens: 0, unexpectedMetadata: true });
    const messages: ModelMessage[] = [
      { role: "user", content: "before malformed artifact" },
      {
        role: "assistant",
        content: [malformedPart],
      },
      { role: "user", content: "must remain after malformed artifact" },
    ];

    expect(readOpenAIServerCompactionArtifact(malformedPart)).toBeNull();
    expect(materializeOpenAIServerCompaction(messages, "workspace/other")).toEqual([
      messages[0]!,
      messages[2]!,
    ]);
  });
});
