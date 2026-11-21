import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { withoutAnthropicReplay } from "./anthropic-replay";
import { openAIRequestCodec } from "./openai-responses/input";

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
  const portable = withoutAnthropicReplay(messages);
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
    expect(JSON.stringify(withoutAnthropicReplay(history))).not.toContain("anthropic");
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
    const portable = JSON.stringify(withoutAnthropicReplay(history));
    expect(portable).not.toContain("anthropic");
    expect(portable).toContain("visible");
  });
}
