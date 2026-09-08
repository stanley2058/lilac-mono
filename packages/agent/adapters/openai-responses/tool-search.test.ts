import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import type {
  AgentPreparedContext,
  AgentToolDefinition,
  AgentToolResult,
} from "../../agent-adapter";
import { openAIRequestCodec } from "./input";
import { openAIResponseCodec } from "./output";
import { loadSearchResult, seedToolLoadingContext, supportsNativeToolSearch } from "./tool-search";

const echo: AgentToolDefinition = {
  name: "mcp_echo",
  description: "Echo",
  inputSchemaJson: '{"type":"object","properties":{"text":{"type":"string"}}}',
  strict: false,
};
const other: AgentToolDefinition = { ...echo, name: "mcp_other" };
const search: AgentToolDefinition = {
  name: "find_tools",
  description: "Search",
  inputSchemaJson: '{"type":"object","properties":{"query":{"type":"string"}}}',
};
function context(
  messages: readonly ModelMessage[],
  selected: AgentToolDefinition[] = [],
): AgentPreparedContext {
  return {
    scopeId: "scope",
    step: 1,
    canonicalMessages: messages,
    messages,
    system: "test",
    tools: [search, ...selected],
    deferredTools: [echo, other],
    nativeToolSearch: true,
  };
}
function result(callId: string, names: string[]): AgentToolResult {
  return {
    callId,
    message: {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "find_tools",
          output: { type: "json", value: { matches: names.map((name) => ({ name })) } },
        },
      ],
    },
  };
}
function exchange(callId: string, names: string[]): ModelMessage[] {
  const projected = openAIResponseCodec
    .project({
      id: "r",
      status: "completed",
      output: [
        {
          type: "tool_search_call",
          id: `item-${callId}`,
          execution: "client",
          status: "completed",
          call_id: callId,
          arguments: { query: "echo" },
        },
      ],
    })
    .unwrap();
  const loaded = loadSearchResult(result(callId, names), [echo, other]).unwrap();
  return [...projected.messages, loaded.message];
}
async function request(prepared: AgentPreparedContext) {
  return (
    await openAIRequestCodec.request({
      model: "gpt-6-astra",
      context: prepared,
      providerOptions: { openai: { store: false } },
    })
  ).unwrap();
}

describe("native tool loading replay", () => {
  test("each search appends definitions without changing earlier input or declarations", async () => {
    const start: ModelMessage[] = [{ role: "user", content: "start" }];
    const first = await request(context(start));
    const secondHistory = [...start, ...exchange("s1", [echo.name])];
    const second = await request(seedToolLoadingContext(context(secondHistory, [echo])).unwrap());
    expect(second.tools).toEqual(first.tools);
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    const thirdHistory = [...secondHistory, ...exchange("s2", [other.name])];
    const third = await request(
      seedToolLoadingContext(context(thirdHistory, [echo, other])).unwrap(),
    );
    expect(third.tools).toEqual(first.tools);
    expect(third.input.slice(0, second.input.length)).toEqual(second.input);
    expect(third.input.filter((item) => item.type === "additional_tools")).toHaveLength(0);
    expect(third.input.filter((item) => item.type === "tool_search_output")).toHaveLength(2);
  });

  test("JSON replay preserves the disclosed schema after a catalog reload", async () => {
    const messages = exchange("s1", [echo.name]);
    const original = await request(context(messages, [echo]));
    const persisted: ModelMessage[] = JSON.parse(JSON.stringify(messages));
    const changed = {
      ...echo,
      description: "Changed",
      inputSchemaJson: '{"type":"object","properties":{"different":{"type":"number"}}}',
    };
    const replay = await request({ ...context(persisted, [changed]), deferredTools: [changed] });
    expect(replay).toEqual(original);
  });

  test("inherited selections get a stable seed, followed by later discoveries", async () => {
    const seeded = seedToolLoadingContext(
      context([{ role: "user", content: "summary" }], [echo]),
    ).unwrap();
    const first = await request(seeded);
    expect(first.input.filter((item) => item.type === "additional_tools")).toEqual([
      expect.objectContaining({
        role: "developer",
        tools: [expect.objectContaining({ name: echo.name })],
      }),
    ]);
    const messages = [...seeded.canonicalMessages, ...exchange("s2", [other.name])];
    const continued = seedToolLoadingContext(context(messages, [echo, other])).unwrap();
    const second = await request(continued);
    expect(second.input.slice(0, first.input.length)).toEqual(first.input);
    expect(second.input.filter((item) => item.type === "additional_tools")).toHaveLength(1);
    expect(seedToolLoadingContext(continued).unwrap()).toEqual(continued);
    const restored = seedToolLoadingContext({
      ...continued,
      deferredTools: [{ ...echo, description: "Reloaded" }, other],
    }).unwrap();
    expect(await request(restored)).toEqual(second);
  });

  test("compacted and branched prefixes seed only inherited active selections", async () => {
    const compacted = seedToolLoadingContext(
      context([{ role: "user", content: "compacted" }], [echo, other]),
    ).unwrap();
    expect((await request(compacted)).input).toContainEqual(
      expect.objectContaining({
        type: "additional_tools",
        tools: [
          expect.objectContaining({ name: echo.name }),
          expect.objectContaining({ name: other.name }),
        ],
      }),
    );
    const branch = seedToolLoadingContext(
      context([{ role: "user", content: "branch" }], [echo]),
    ).unwrap();
    expect(JSON.stringify((await request(branch)).input)).not.toContain(other.name);
  });

  test("portable projection uses ordinary search calls and selected tool declarations", async () => {
    const prepared = { ...context(exchange("s1", [echo.name]), [echo]), nativeToolSearch: false };
    const portable = await request(prepared);
    expect(portable.tools).toContainEqual(
      expect.objectContaining({ type: "function", name: echo.name }),
    );
    expect(portable.input).toContainEqual(
      expect.objectContaining({ type: "function_call", name: "find_tools", call_id: "s1" }),
    );
    expect(portable.input).toContainEqual(
      expect.objectContaining({ type: "function_call_output", call_id: "s1" }),
    );
    expect(portable.input.some((item) => item.type === "tool_search_output")).toBe(false);
  });

  test("empty, repeated, and failed searches produce correlated native results", async () => {
    const empty = exchange("empty", []);
    const failed = result("failed", []);
    failed.message.content = [
      {
        type: "tool-result",
        toolCallId: "failed",
        toolName: "find_tools",
        output: { type: "error-text", value: "Invalid query" },
      },
    ];
    const errorOutput = loadSearchResult(failed, [echo]).unwrap();
    const encoded = (
      await openAIRequestCodec.messages(
        [...empty, ...exchange("again", [echo.name]), errorOutput.message],
        { nativeToolSearch: true },
      )
    ).unwrap();
    expect(encoded).toContainEqual(
      expect.objectContaining({ type: "tool_search_output", call_id: "empty", tools: [] }),
    );
    expect(encoded).toContainEqual(
      expect.objectContaining({ type: "tool_search_output", call_id: "failed", tools: [] }),
    );
    expect(loadSearchResult(result("unknown", ["unavailable"]), [echo]).isErr()).toBe(true);
  });

  test("malformed replay metadata fails instead of dropping declarations", async () => {
    const malformed: ModelMessage[] = [
      {
        role: "user",
        content: "hi",
        providerOptions: { openai: { toolSearchSeed: [{ name: "broken" }] } },
      },
    ];
    expect(seedToolLoadingContext(context(malformed)).isErr()).toBe(true);
  });

  test("native discovery is limited to known supported models without opaque compaction or tool restrictions", () => {
    for (const model of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6", "gpt-6-astra"])
      expect(supportsNativeToolSearch(model, undefined)).toBe(true);
    for (const model of ["gpt-5", "gpt-5.3-codex", "gpt-4.1", "custom"])
      expect(supportsNativeToolSearch(model, undefined)).toBe(false);
    for (const openai of [
      { contextManagement: [] },
      { compactionTrigger: true },
      { conversation: "c" },
      { previousResponseId: "r" },
      { allowedTools: { toolNames: ["find_tools"] } },
    ])
      expect(supportsNativeToolSearch("gpt-6-astra", { openai })).toBe(false);
  });
});
