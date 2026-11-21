import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { openAIRequestCodec } from "./openai-responses/input";
import {
  googleHistoryProfile,
  openAIHistoryProfile,
  projectMessagesFor,
  resolveAiSdkHistoryProfile,
} from "./provider-history";

const forOpenAI = (history: readonly ModelMessage[]) =>
  projectMessagesFor(openAIHistoryProfile(), history).messages;

const messages: ModelMessage[] = [
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: [
      {
        type: "custom",
        kind: "anthropic.message_start",
        providerOptions: { anthropic: { id: "old" } },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "custom",
        kind: "anthropic.fallback",
        providerOptions: { anthropic: { value: "opaque" } },
      },
      {
        type: "text",
        text: "answer",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      { type: "tool-call", toolCallId: "search", toolName: "find_tools", input: {} },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "search",
        toolName: "find_tools",
        providerOptions: { anthropic: { toolSearchReferences: ["lookup"] } },
        output: { type: "json", value: { matches: [{ name: "lookup" }] } },
      },
    ],
  },
];

test("removes Anthropic replay blocks and metadata without changing canonical messages", () => {
  const before = structuredClone(messages);
  const portable = forOpenAI(messages);
  expect(JSON.stringify(portable)).not.toContain("anthropic");
  expect(portable).toHaveLength(3);
  expect(JSON.stringify(portable)).toContain("answer");
  expect(JSON.stringify(portable)).toContain("lookup");
  expect(messages).toEqual(before);
});

for (const nativeToolSearch of [false, true]) {
  test(`OpenAI accepts Anthropic history with native search ${nativeToolSearch}`, async () => {
    const result = await openAIRequestCodec.request({
      model: "gpt-6-astra",
      context: {
        scopeId: "scope",
        step: 0,
        system: "",
        canonicalMessages: messages,
        messages,
        tools: [],
        nativeToolSearch,
      },
    });
    expect(result.isOk()).toBe(true);
    expect(JSON.stringify(result.unwrap())).not.toContain("anthropic");
    expect(JSON.stringify(result.unwrap())).toContain("answer");
  });
}

for (const role of ["assistant", "tool"] as const) {
  test(`removes nested references from ${role} results while retaining text`, async () => {
    const history: ModelMessage[] = [
      {
        role,
        content: [
          {
            type: "tool-result",
            toolCallId: "search",
            toolName: "find_tools",
            output: {
              type: "content",
              value: [
                {
                  type: "custom",
                  providerOptions: { anthropic: { type: "tool-reference", toolName: "lookup" } },
                },
                { type: "text", text: "visible result" },
              ],
            },
          },
        ],
      },
    ];
    const before = structuredClone(history);
    const result = await openAIRequestCodec.request({
      model: "gpt-6-astra",
      context: {
        scopeId: "scope",
        step: 0,
        system: "",
        tools: [],
        canonicalMessages: history,
        messages: history,
      },
    });
    expect(result.isOk()).toBe(true);
    expect(JSON.stringify(result.unwrap())).toContain("visible result");
    expect(JSON.stringify(forOpenAI(history))).not.toContain("anthropic");
    expect(history).toEqual(before);
  });
}

test("preserves OpenAI seed on an otherwise empty projected message", async () => {
  const history: ModelMessage[] = [
    {
      role: "assistant",
      content: [{ type: "custom", kind: "anthropic.message_start" }],
      providerOptions: {
        openai: {
          toolSearchSeed: [
            {
              name: "lookup",
              description: "lookup",
              inputSchemaJson: '{"type":"object","properties":{}}',
            },
          ],
        },
      },
    },
  ];
  const result = await openAIRequestCodec.request({
    model: "gpt-6-astra",
    context: {
      scopeId: "scope",
      step: 0,
      system: "",
      tools: [],
      canonicalMessages: history,
      messages: history,
      nativeToolSearch: true,
    },
  });
  expect(result.unwrap().input).toMatchObject([
    { type: "additional_tools", tools: [{ name: "lookup" }] },
  ]);
});

for (const output of [
  { type: "text", value: "visible", providerOptions: { anthropic: { marker: "private" } } },
  {
    type: "json",
    value: { text: "visible" },
    providerOptions: { anthropic: { marker: "private" } },
  },
] as const) {
  test(`removes output-level Anthropic options from ${output.type}`, () => {
    const history: ModelMessage[] = [
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call", toolName: "lookup", output }],
      },
    ];
    const portable = JSON.stringify(forOpenAI(history));
    expect(portable).not.toContain("anthropic");
    expect(portable).toContain("visible");
  });
}

const ANTHROPIC_KINDS = [
  "anthropic.message_start",
  "anthropic.fallback",
  "anthropic.tool-reference",
];

test.each([
  ["anthropic.messages", "claude-opus-5-5", "anthropic", ANTHROPIC_KINDS],
  ["vertex.anthropic.messages", "claude-opus-5-5", "anthropic", ANTHROPIC_KINDS],
  ["gateway", "anthropic/claude-opus-4.5", "anthropic", []],
  ["openrouter", "anthropic/claude-opus-4.5", "anthropic", []],
  ["openai.responses", "gpt-6-astra", "openai", ["openai.compaction"]],
  ["gateway", "openai/gpt-6-astra", "openai", []],
  ["google.generative-ai", "gemini-3-pro", "google", []],
  ["gateway", "google/gemini-3-pro", "google", []],
  ["groq.chat", "llama", "other", []],
  ["groq.chat", "anthropic/claude-lookalike", "other", []],
] as const)("resolves %s %s to %s", (provider, modelId, family, customKinds) => {
  const profile = resolveAiSdkHistoryProfile(new MockLanguageModelV4({ provider, modelId }));
  expect(profile.family).toBe(family);
  expect(profile.customKinds).toEqual(customKinds);
});

test("resolves a bare gateway model id by its vendor", () => {
  expect(resolveAiSdkHistoryProfile("anthropic/claude-opus-4.5").family).toBe("anthropic");
});

test("keeps Lilac markers and the transport namespace while dropping unknown metadata", () => {
  const [message] = projectMessagesFor(
    resolveAiSdkHistoryProfile(
      new MockLanguageModelV4({
        provider: "gateway",
        modelId: "google/gemini-3-pro",
      }),
    ),
    [
      {
        role: "user",
        content: "hello",
        providerOptions: {
          lilac: { generated: { version: 1 } },
          gateway: { order: ["vertex"] },
          google: { thoughtSignature: "kept" },
          anthropic: { cacheControl: { type: "ephemeral" } },
          unknown: { value: true },
        },
      },
    ],
  ).messages;
  expect(message?.providerOptions).toEqual({
    lilac: { generated: { version: 1 } },
    gateway: { order: ["vertex"] },
    google: { thoughtSignature: "kept" },
  });
});

test("keeps OpenAI tool-search keys only with native tool search", () => {
  const history: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "search",
          toolName: "find_tools",
          input: {},
          providerOptions: {
            openai: {
              itemId: "tsc_1",
              toolSearchCall: true,
              phase: "commentary",
            },
          },
        },
      ],
    },
  ];
  const options = (nativeToolSearch: boolean) => {
    const [message] = projectMessagesFor(
      openAIHistoryProfile({ nativeToolSearch }),
      history,
    ).messages;
    const part =
      message?.role === "assistant" && typeof message.content !== "string"
        ? message.content[0]
        : undefined;
    return part?.type === "tool-call" ? part.providerOptions : undefined;
  };
  expect(options(false)).toEqual({ openai: { phase: "commentary" } });
  expect(options(true)).toEqual({
    openai: { itemId: "tsc_1", toolSearchCall: true, phase: "commentary" },
  });
});

test("Google receives no Anthropic or OpenAI replay content", () => {
  const projected = projectMessagesFor(googleHistoryProfile(), messages).messages;
  expect(JSON.stringify(projected)).not.toContain("anthropic");
  expect(projected).toHaveLength(3);
});

test("ignores namespaces inherited from Object.prototype", () => {
  const history: ModelMessage[] = JSON.parse(
    '[{"role":"user","content":"hello","providerOptions":{"__proto__":{"leak":true},"constructor":{"leak":true}}}]',
  );
  const [message] = projectMessagesFor(openAIHistoryProfile(), history).messages;
  expect(message?.providerOptions).toBeUndefined();
});

for (const nativeToolSearch of [false, true]) {
  test(`drops empty assistant turns unless a seed is replayed with native search ${nativeToolSearch}`, () => {
    const seed = [{ name: "lookup", description: "lookup", inputSchemaJson: "{}" }];
    const history: ModelMessage[] = [
      { role: "assistant", content: [] },
      {
        role: "assistant",
        content: [{ type: "custom", kind: "anthropic.message_start" }],
        providerOptions: { openai: { toolSearchSeed: seed } },
      },
      { role: "assistant", content: "text turn" },
    ];
    const projected = projectMessagesFor(
      openAIHistoryProfile({ nativeToolSearch }),
      history,
    ).messages;
    const seeded: ModelMessage = {
      role: "assistant",
      content: [],
      providerOptions: { openai: { toolSearchSeed: seed } },
    };
    const text: ModelMessage = { role: "assistant", content: "text turn" };
    expect(projected).toEqual(nativeToolSearch ? [seeded, text] : [text]);
  });
}

test("keeps replay keys the installed converters read", () => {
  const anthropic = projectMessagesFor(
    resolveAiSdkHistoryProfile(
      new MockLanguageModelV4({ provider: "anthropic.messages", modelId: "claude-opus-5-5" }),
    ),
    [
      {
        role: "system",
        content: "",
        providerOptions: {
          anthropic: { toolChanges: [{ type: "tool_addition", toolName: "lookup" }] },
        },
      },
    ],
  ).messages;
  expect(anthropic[0]?.providerOptions).toEqual({
    anthropic: { toolChanges: [{ type: "tool_addition", toolName: "lookup" }] },
  });
  const [tool] = projectMessagesFor(openAIHistoryProfile(), [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "mcp",
          output: {
            type: "execution-denied",
            reason: "denied",
            providerOptions: { openai: { approvalId: "approval" }, anthropic: { marker: true } },
          },
        },
      ],
    },
  ]).messages;
  const part = tool?.role === "tool" ? tool.content[0] : undefined;
  expect(part?.type === "tool-result" ? part.output : undefined).toEqual({
    type: "execution-denied",
    reason: "denied",
    providerOptions: { openai: { approvalId: "approval" } },
  });
});
