import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "../ai-sdk-pi-agent";
import { prepareContextHandoff } from "../session-continuation";
import { codexRequestCodec } from "./codex/adapter";
import { openAIRequestCodec } from "./openai-responses/input";

// Redacted production transcripts (request_transcripts.messages_json), one stored request each.
const FIXTURE_DIR = path.join(import.meta.dir, "../tests/fixtures/prod-history");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type StoredPart = { type: string; mediaType?: string; filename?: string };

// Core materializes stored resource parts into file parts before a model call.
function materialize(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") return message;
    const content = message.content.map((part) => {
      const stored: StoredPart = part;
      if (stored.type !== "resource") return part;
      return { type: "file" as const, data: PNG, mediaType: stored.mediaType ?? "image/png" };
    });
    return { ...message, content };
  });
}

function fixture(name: string): ModelMessage[] {
  const messages: ModelMessage[] = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"),
  );
  return materialize(messages);
}

const FIXTURES = {
  "anthropic-direct": {
    owner: "anthropic",
    keys: ["anthropic.signature", "anthropic.caller", "lilac.generated"],
    kinds: ["anthropic.message_start"],
  },
  "anthropic-gateway": {
    owner: "gateway",
    keys: ["anthropic.signature", "anthropic.caller"],
    kinds: [],
  },
  "openai-native-tool-search": {
    owner: "openai",
    keys: ["openai.itemId", "openai.reasoningEncryptedContent", "openai.phase", "lilac.generated"],
    kinds: [],
  },
  "claude-code": {
    owner: "claude-code",
    keys: [
      "claude-code.parentToolCallId",
      "claude-code.rawInput",
      "claude-code.rawResult",
      "claude-code.rawResultTruncated",
    ],
    kinds: [],
  },
} as const;

const TARGETS = {
  anthropic: {
    provider: "anthropic.messages",
    modelId: "claude-opus-5-5",
    namespaces: ["anthropic"],
    kinds: ["anthropic.message_start", "anthropic.fallback"],
  },
  gateway: {
    provider: "gateway",
    modelId: "anthropic/claude-opus-5.5",
    namespaces: ["anthropic", "gateway"],
    kinds: [],
  },
  google: {
    provider: "google.generative-ai",
    modelId: "gemini-3-pro",
    namespaces: ["google"],
    kinds: [],
  },
  openai: {
    provider: "openai.responses",
    modelId: "gpt-6-astra",
    namespaces: ["openai"],
    kinds: ["openai.compaction"],
  },
  "claude-code": {
    provider: "claude-code",
    modelId: "opus",
    namespaces: ["claude-code", "openaiCompatible"],
    kinds: [],
  },
} as const;

function collectMetadata(
  value: unknown,
  found = { keys: new Set<string>(), kinds: new Set<string>() },
) {
  if (Array.isArray(value)) {
    for (const item of value) collectMetadata(item, found);
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  const record = value as Record<string, unknown>;
  if (record.type === "custom" && typeof record.kind === "string") found.kinds.add(record.kind);
  const options = record.providerOptions;
  if (typeof options === "object" && options !== null)
    for (const [name, namespace] of Object.entries(options))
      for (const key of Object.keys(namespace ?? {})) found.keys.add(`${name}.${key}`);
  for (const child of Object.values(record)) collectMetadata(child, found);
  return found;
}

function done() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: "done" },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "end_turn" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
    }),
  };
}

describe("redacted production history", () => {
  for (const [name, expected] of Object.entries(FIXTURES)) {
    for (const [targetName, target] of Object.entries(TARGETS)) {
      test(`${name} reaches ${targetName} with only its own metadata`, async () => {
        const messages = fixture(name);
        const before = structuredClone(messages);
        const model = new MockLanguageModelV4({
          provider: target.provider,
          modelId: target.modelId,
          doStream: [done()],
        });
        const agent = new AiSdkPiAgent({ system: "test", model, messages });
        await agent.prompt("continue");
        expect(agent.state.messages.slice(0, before.length)).toEqual(before);

        const found = collectMetadata(model.doStreamCalls[0]?.prompt);
        const allowed: readonly string[] = [...target.namespaces, "lilac"];
        for (const key of found.keys) expect(allowed).toContain(key.slice(0, key.indexOf(".")));
        for (const kind of found.kinds) expect(target.kinds as readonly string[]).toContain(kind);
        if (expected.owner !== targetName) return;
        for (const key of expected.keys) expect([...found.keys]).toContain(key);
        for (const kind of expected.kinds) expect([...found.kinds]).toContain(kind);
      });
    }

    for (const [codecName, codec] of [
      ["OpenAI Responses", openAIRequestCodec],
      ["Codex", codexRequestCodec],
    ] as const) {
      for (const nativeToolSearch of [false, true]) {
        test(`${name} encodes for ${codecName} with native tool search ${nativeToolSearch}`, async () => {
          const stored = fixture(name);
          // Core hands Claude Code tool history to other families as a text summary.
          const messages =
            expected.owner === "claude-code" ? prepareContextHandoff(stored) : stored;
          const result = await codec.request({
            model: "gpt-6-astra",
            providerOptions: { openai: { store: false } },
            context: {
              scopeId: "scope",
              step: 0,
              system: "",
              tools: [],
              canonicalMessages: messages,
              messages,
              nativeToolSearch,
            },
          });
          const request = result.unwrap();
          const json = JSON.stringify(request);
          for (const foreign of [
            "anthropic",
            "claude-code",
            "toolSearchReferences",
            "message_start",
          ])
            expect(json).not.toContain(foreign);
          const types = new Set<unknown>(
            request.input.map((item) => ("type" in item ? item.type : undefined)),
          );
          const searched = name === "openai-native-tool-search" && nativeToolSearch;
          expect(types.has("tool_search_call")).toBe(searched);
          expect(types.has("tool_search_output")).toBe(searched);
        });
      }
    }
  }
});
