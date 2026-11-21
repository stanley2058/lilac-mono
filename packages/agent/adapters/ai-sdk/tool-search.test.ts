import { createOverflowReferenceNormalizer } from "../../../tool-results/src/tool-result-output-normalizer";
import { expect, test } from "bun:test";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "../../ai-sdk-pi-agent";
import { prepareAnthropicToolSearch } from "./tool-search";

const schema = jsonSchema({ type: "object", properties: {}, additionalProperties: false });
const definition = tool({ inputSchema: schema, description: "lookup" });
const model = new MockLanguageModelV4({
  provider: "anthropic.messages",
  modelId: "claude-opus-5-5",
});
const history: ModelMessage[] = [
  { role: "user", content: "search" },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "searching",
        providerOptions: { anthropic: { signature: "signed" } },
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
        output: { type: "json", value: { matches: [{ name: "lookup" }] } },
      },
    ],
  },
];

test("keeps declarations and signed thinking stable after tool discovery and replay", () => {
  const deferredTools = { other: definition, lookup: definition };
  const first = prepareAnthropicToolSearch({
    model,
    tools: { find_tools: definition },
    deferredTools,
    messages: history.slice(0, 1),
  });
  const second = prepareAnthropicToolSearch({
    model,
    tools: { find_tools: definition, lookup: definition },
    deferredTools,
    messages: history,
  });
  expect(second.tools).toEqual(first.tools);
  expect(Object.keys(second.tools)).toEqual(Object.keys(first.tools));
  expect(second.tools.lookup?.providerOptions?.anthropic?.deferLoading).toBe(true);
  expect(second.messages[1]).toEqual(history[1]);
  expect(second.messages[2]).toMatchObject({
    content: [
      {
        output: {
          type: "content",
          value: [
            {
              type: "custom",
              providerOptions: { anthropic: { type: "tool-reference", toolName: "lookup" } },
            },
          ],
        },
      },
    ],
  });
  expect(
    prepareAnthropicToolSearch({
      model,
      tools: { find_tools: definition, lookup: definition },
      deferredTools,
      messages: structuredClone(history),
    }).messages,
  ).toEqual(second.messages);
  expect(history[2]).toMatchObject({ content: [{ output: { type: "json" } }] });
});

test("leaves other providers and unsupported Claude models unchanged", () => {
  for (const [provider, modelId] of [
    ["openai.responses", "gpt-5"],
    ["anthropic.messages", "claude-opus-4-1"],
    ["claude-code", "claude-opus-5-5"],
  ]) {
    const input = {
      model: new MockLanguageModelV4({ provider, modelId }),
      tools: { find_tools: definition },
      deferredTools: { lookup: definition },
      messages: history,
    };
    expect(prepareAnthropicToolSearch(input)).toBe(input);
  }
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function call(toolName: string, toolCallId: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "tool-call" as const, toolName, toolCallId, input: "{}" },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          usage,
        },
      ],
    }),
  };
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
          usage,
        },
      ],
    }),
  };
}

test("search activates execution authority without changing the provider declarations", async () => {
  let selected = false;
  let executed = 0;
  const provider = new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: "claude-opus-5-5",
    doStream: [call("find_tools", "search"), call("lookup", "lookup"), done()],
  });
  const agent = new AiSdkPiAgent({
    system: "test",
    model: provider,
    tools: {
      find_tools: tool({
        inputSchema: schema,
        execute: () => {
          selected = true;
          return { matches: [{ name: "lookup" }] };
        },
      }),
      lookup: tool({
        inputSchema: schema,
        execute: () => {
          executed++;
          return "found";
        },
      }),
    },
    deferredToolNames: () => ["lookup"],
    beforeStep: () => {
      agent.setActiveTools(new Set(selected ? ["find_tools", "lookup"] : ["find_tools"]));
    },
  });
  await agent.prompt("search then lookup");
  expect(executed).toBe(1);
  expect(provider.doStreamCalls).toHaveLength(3);
  expect(provider.doStreamCalls[1]?.tools).toEqual(provider.doStreamCalls[0]?.tools);
  expect(provider.doStreamCalls[2]?.tools).toEqual(provider.doStreamCalls[0]?.tools);
  expect(JSON.stringify(provider.doStreamCalls[1]?.prompt)).toContain("tool-reference");
});

test("deferred declarations do not authorize execution before discovery", async () => {
  let executed = 0;
  const provider = new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: "claude-opus-5-5",
    doStream: [call("lookup", "lookup"), done()],
  });
  const agent = new AiSdkPiAgent({
    system: "test",
    model: provider,
    tools: {
      find_tools: definition,
      lookup: tool({
        inputSchema: schema,
        execute: () => {
          executed++;
          return "found";
        },
      }),
    },
    deferredToolNames: () => ["lookup"],
    beforeStep: () => {
      agent.setActiveTools(new Set(["find_tools"]));
    },
  });
  await agent.prompt("try lookup");
  expect(executed).toBe(0);
});

test("retains native references across production output overflow and checkpoint replay", async () => {
  let selected = false;
  const checkpoints: Array<readonly ModelMessage[]> = [];
  const provider = new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: "claude-opus-5-5",
    doStream: [call("find_tools", "search"), done()],
  });
  const normalize = createOverflowReferenceNormalizer({
    owner: { scopeId: "test", requestId: "search" },
    getOutputConfig: () => ({
      maxInlineBytes: 64,
      artifactTtlMs: 60000,
      maxArtifactBytesPerScope: 10000,
    }),
  });
  const agent = new AiSdkPiAgent({
    system: "test",
    model: provider,
    tools: {
      find_tools: tool({
        inputSchema: schema,
        execute: () => {
          selected = true;
          return { matches: [{ name: "lookup", title: "x".repeat(200) }] };
        },
      }),
      lookup: definition,
    },
    deferredToolNames: () => ["lookup"],
    normalizeToolResultOutput: normalize,
    recoveryCheckpointHandler: async (messages) => {
      checkpoints.push(structuredClone(messages));
    },
    beforeStep: () => {
      agent.setActiveTools(new Set(selected ? ["find_tools", "lookup"] : ["find_tools"]));
    },
  });
  await agent.prompt("find lookup");
  const checkpointMessages = structuredClone(agent.state.messages);
  const result = agent.state.messages.find((message) => message.role === "tool");
  expect(result).toMatchObject({
    content: [
      {
        output: { type: "text", value: expect.stringContaining("[tool result overflow]") },
        providerOptions: { anthropic: { toolSearchReferences: ["lookup"] } },
      },
    ],
  });
  expect(
    checkpoints.some((messages) =>
      messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) =>
              part.type === "tool-result" &&
              part.providerOptions?.anthropic?.toolSearchReferences !== undefined,
          ),
      ),
    ),
  ).toBe(true);
  const prompt = JSON.stringify(provider.doStreamCalls[1]?.prompt);
  expect(prompt).not.toContain("[tool result overflow]");
  expect(prompt).toContain("tool-reference");
  const replayed = prepareAnthropicToolSearch({
    model,
    tools: { find_tools: definition, lookup: definition },
    deferredTools: { lookup: definition },
    messages: checkpointMessages,
  });
  expect(JSON.stringify(replayed.messages)).toContain("tool-reference");
  expect(replayed.messages).toHaveLength(agent.state.messages.length);
});

test("retains inherited selection after signed history without moving the existing prefix", async () => {
  const provider = new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: "claude-opus-5-5",
    doStream: [call("lookup", "lookup"), done(), done()],
  });
  let searches = 0;
  let executions = 0;
  const messages: ModelMessage[] = [
    { role: "user", content: "previous" },
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "old",
          providerOptions: { anthropic: { signature: "old-signature" } },
        },
        { type: "text", text: "previous answer" },
      ],
    },
  ];
  const agent = new AiSdkPiAgent({
    system: "test",
    model: provider,
    messages,
    tools: {
      find_tools: tool({
        inputSchema: schema,
        execute: () => {
          searches++;
          return { matches: [] };
        },
      }),
      lookup: tool({
        inputSchema: schema,
        execute: () => {
          executions++;
          return "found";
        },
      }),
    },
    deferredToolNames: () => ["lookup"],
  });
  await agent.prompt("continue with selected tool");
  const saved = structuredClone(agent.state.messages);
  expect(searches).toBe(0);
  expect(executions).toBe(1);
  expect(saved.slice(0, 2)).toEqual(messages);
  const seeds = saved.filter(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "tool-call" && part.toolName === "find_tools"),
  );
  expect(seeds).toHaveLength(1);
  const firstInput = provider.doStreamCalls[0]?.prompt ?? [];
  expect(provider.doStreamCalls[1]?.prompt.slice(0, firstInput.length)).toEqual(firstInput);
  const resumed = new AiSdkPiAgent({
    system: "test",
    model: provider,
    messages: saved,
    tools: { find_tools: definition, lookup: definition },
    deferredToolNames: () => ["lookup"],
  });
  await resumed.prompt("next");
  expect(
    resumed.state.messages.filter(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "tool-call" && part.toolName === "find_tools"),
    ),
  ).toHaveLength(1);
});

for (const providerName of ["anthropic.messages", "google.generative-ai", "openai.chat"]) {
  test(`isolates Anthropic replay content at the ${providerName} boundary`, async () => {
    const provider = new MockLanguageModelV4({
      provider: providerName,
      modelId: "test-model",
      doStream: [done()],
    });
    const messages: ModelMessage[] = [
      { role: "user", content: "old prompt" },
      {
        role: "assistant",
        content: [
          {
            type: "custom",
            kind: "anthropic.message_start",
            providerOptions: { anthropic: { id: "old-message" } },
          },
          { type: "text", text: "old answer" },
        ],
      },
    ];
    const agent = new AiSdkPiAgent({ system: "test", model: provider, messages });
    await agent.prompt("continue");
    const prompt = JSON.stringify(provider.doStreamCalls[0]?.prompt);
    expect(prompt).toContain("old answer");
    if (providerName === "anthropic.messages") expect(prompt).toContain("anthropic.message_start");
    else expect(prompt).not.toContain("anthropic");
    expect(JSON.stringify(agent.state.messages)).toContain("anthropic.message_start");
  });
}
