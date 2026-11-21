import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "../ai-sdk-pi-agent";
import { codexRequestCodec } from "./codex/adapter";
import { openAIRequestCodec } from "./openai-responses/input";

// Each stored artifact carries a value unique to its provider, so a payload can be searched for leaks.
const MARKERS = {
  anthropic: ["anthropic-signature", "anthropic-redacted", "anthropic-cache"],
  anthropicReplay: ["anthropic-fallback-model", "anthropic-reference-tool"],
  openai: ["openai-reasoning", "openai-compaction", "openai-text-item"],
  openaiToolSearch: ["openai-seed-tool", "openai-loaded-tool", "openai-search-item"],
  google: ["google-signature", "google-server-call", "google-server-type"],
  // Read by @ai-sdk/openai only; the Lilac Responses encoder has no wire field for it.
  openaiSdk: ["openai-parallel-call"],
  compatible: ["compatible-field"],
  // Metadata no provider declares: Lilac's own Anthropic search bookkeeping and future keys.
  undeclared: [
    "lilac-search-reference",
    "future-anthropic",
    "future-openai",
    "future-google",
    "future-kind",
    "unknown-namespace",
  ],
} as const;
const ALL_MARKERS: readonly string[] = Object.values(MARKERS).flat();

const definition = (name: string) => ({
  name,
  description: name,
  inputSchemaJson: '{"type":"object","properties":{}}',
});

const history: ModelMessage[] = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "first question",
        providerOptions: { anthropic: { cacheControl: { type: "anthropic-cache" } } },
      },
    ],
    providerOptions: {
      openai: { toolSearchSeed: [definition("openai-seed-tool")] },
      lilac: { marker: "lilac-marker" },
      unknown: { value: "unknown-namespace" },
    },
  },
  {
    role: "assistant",
    content: [
      {
        type: "custom",
        kind: "anthropic.message_start",
        providerOptions: { anthropic: { id: "msg_1" } },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "custom",
        kind: "anthropic.fallback",
        providerOptions: {
          anthropic: {
            type: "fallback",
            from: { model: "anthropic-fallback-model" },
            to: { model: "anthropic-fallback-model" },
          },
        },
      },
      {
        type: "custom",
        kind: "anthropic.future_kind",
        providerOptions: { anthropic: { value: "future-kind" } },
      },
      {
        type: "reasoning",
        text: "anthropic thinking",
        providerOptions: {
          anthropic: { signature: "anthropic-signature", futureKey: "future-anthropic" },
        },
      },
      {
        type: "reasoning",
        text: "",
        providerOptions: { anthropic: { redactedData: "anthropic-redacted" } },
      },
      {
        type: "reasoning",
        text: "openai thinking",
        providerOptions: {
          openai: { itemId: "rs_1", reasoningEncryptedContent: "openai-reasoning" },
        },
      },
      {
        type: "text",
        text: "visible answer",
        providerOptions: {
          openai: { itemId: "openai-text-item", phase: "commentary", futureKey: "future-openai" },
          google: {
            thoughtSignature: "google-signature",
            thought: false,
            futureKey: "future-google",
          },
          openaiCompatible: { field: "compatible-field" },
        },
      },
      {
        type: "tool-call",
        toolCallId: "search",
        toolName: "find_tools",
        input: { query: "lookup" },
        providerOptions: { openai: { itemId: "openai-search-item", toolSearchCall: true } },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "search",
        toolName: "find_tools",
        output: { type: "json", value: { matches: [{ name: "lookup" }] } },
        providerOptions: {
          anthropic: { toolSearchReferences: ["lilac-search-reference"] },
          openai: { toolSearchTools: [definition("openai-loaded-tool")] },
        },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "lookup",
        toolName: "lookup",
        input: {},
        providerOptions: {
          openai: {
            parallelToolCall: {
              itemId: "openai-parallel-call",
              toolCallId: "lookup",
              toolName: "lookup",
              input: "{}",
              index: 0,
              count: 1,
            },
          },
          google: { serverToolCallId: "google-server-call", serverToolType: "google-server-type" },
        },
      },
      {
        type: "custom",
        kind: "openai.compaction",
        providerOptions: {
          openai: { type: "compaction", itemId: "cmp_1", encryptedContent: "openai-compaction" },
        },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "lookup",
        toolName: "lookup",
        output: {
          type: "content",
          value: [
            {
              type: "custom",
              providerOptions: {
                anthropic: { type: "tool-reference", toolName: "anthropic-reference-tool" },
              },
            },
            { type: "text", text: "visible result" },
          ],
        },
      },
    ],
  },
];

function expectMarkers(payload: unknown, allowed: readonly string[]) {
  const json = JSON.stringify(payload);
  expect(json).toContain("visible answer");
  expect(json).toContain("visible result");
  for (const marker of allowed) expect(json).toContain(marker);
  for (const marker of ALL_MARKERS.filter((value) => !allowed.includes(value)))
    expect(json).not.toContain(marker);
}

// Collects every `namespace.key` and custom kind that reaches an AI SDK prompt.
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

async function aiSdkPrompt(provider: string, modelId: string) {
  const model = new MockLanguageModelV4({ provider, modelId, doStream: [done()] });
  const before = structuredClone(history);
  const agent = new AiSdkPiAgent({ system: "test", model, messages: structuredClone(history) });
  await agent.prompt("continue");
  expect(agent.state.messages.slice(0, history.length)).toEqual(before);
  return model.doStreamCalls[0]?.prompt;
}

const ROUTED_ANTHROPIC_KEYS = [
  "anthropic.cacheControl",
  "anthropic.redactedData",
  "anthropic.signature",
  "lilac.marker",
];

describe("stored history reaches each provider only with its own artifacts", () => {
  test.each([
    {
      name: "Anthropic",
      provider: "anthropic.messages",
      modelId: "claude-opus-5-5",
      markers: [...MARKERS.anthropic, ...MARKERS.anthropicReplay],
      keys: [
        ...ROUTED_ANTHROPIC_KEYS,
        "anthropic.from",
        "anthropic.to",
        "anthropic.toolName",
        "anthropic.type",
      ],
      kinds: ["anthropic.fallback", "anthropic.message_start"],
    },
    {
      name: "Anthropic through Vercel Gateway",
      provider: "gateway",
      modelId: "anthropic/claude-opus-4.5",
      markers: MARKERS.anthropic,
      keys: ROUTED_ANTHROPIC_KEYS,
      kinds: [],
    },
    {
      name: "an OpenRouter alias",
      provider: "openrouter",
      modelId: "openrouter/auto",
      markers: ["anthropic-cache"],
      keys: ["anthropic.cacheControl", "lilac.marker"],
      kinds: [],
    },
    {
      name: "Google",
      provider: "google.generative-ai",
      modelId: "gemini-3-pro",
      markers: MARKERS.google,
      keys: [
        "google.serverToolCallId",
        "google.serverToolType",
        "google.thought",
        "google.thoughtSignature",
        "lilac.marker",
      ],
      kinds: [],
    },
    {
      name: "OpenAI through the AI SDK",
      provider: "openai.responses",
      modelId: "gpt-6-astra",
      markers: [...MARKERS.openai, ...MARKERS.openaiSdk],
      keys: [
        "lilac.marker",
        "openai.encryptedContent",
        "openai.itemId",
        "openai.parallelToolCall",
        "openai.phase",
        "openai.reasoningEncryptedContent",
        "openai.type",
      ],
      kinds: ["openai.compaction"],
    },
    {
      name: "an OpenAI-compatible provider",
      provider: "cerebras.chat",
      modelId: "anthropic/claude-lookalike",
      markers: MARKERS.compatible,
      keys: ["lilac.marker", "openaiCompatible.field"],
      kinds: [],
    },
  ])("$name via AI SDK", async ({ provider, modelId, markers, keys, kinds }) => {
    const prompt = await aiSdkPrompt(provider, modelId);
    expectMarkers(prompt, markers);
    const found = collectMetadata(prompt);
    expect([...found.keys].sort()).toEqual([...keys].sort());
    expect([...found.kinds].sort()).toEqual([...kinds].sort());
  });

  for (const [name, codec] of [
    ["OpenAI Responses", openAIRequestCodec],
    ["Codex", codexRequestCodec],
  ] as const) {
    for (const nativeToolSearch of [false, true]) {
      test(`${name} with native tool search ${nativeToolSearch}`, async () => {
        const before = structuredClone(history);
        const result = await codec.request({
          model: "gpt-6-astra",
          providerOptions: { openai: { store: false } },
          context: {
            scopeId: "scope",
            step: 0,
            system: "",
            tools: [],
            canonicalMessages: history,
            messages: history,
            nativeToolSearch,
          },
        });
        const request = result.unwrap();
        expectMarkers(request, [
          ...MARKERS.openai,
          ...(nativeToolSearch ? MARKERS.openaiToolSearch : []),
        ]);
        expect(JSON.stringify(request)).not.toContain("anthropic");
        expect(request.input).toContainEqual(
          expect.objectContaining({ id: "openai-text-item", phase: "commentary" }),
        );
        const types = new Set<unknown>(
          request.input.map((item) => ("type" in item ? item.type : undefined)),
        );
        for (const type of ["additional_tools", "tool_search_call", "tool_search_output"])
          expect(types.has(type)).toBe(nativeToolSearch);
        expect(history).toEqual(before);
      });
    }
  }
});
