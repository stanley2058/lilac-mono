import { expect, test } from "bun:test";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  prepareAnthropicToolSearch,
  seedAnthropicToolSearch,
} from "../../../../../packages/agent/adapters/ai-sdk/tool-search";
import { applyToolOutputCompactionView } from "../../../src/surface/bridge/bus-agent-runner/tool-output-policy";

for (const legacy of [false, true]) {
  test(`retains ${legacy ? "legacy" : "synthetic"} tool references through production pruning`, () => {
    const model = new MockLanguageModelV4({
      provider: "anthropic.messages",
      modelId: "claude-opus-5-5",
    });
    const definition = tool({ inputSchema: jsonSchema({ type: "object", properties: {} }) });
    const tools = { find_tools: definition, lookup: definition };
    const deferredTools = { lookup: definition };
    const messages: ModelMessage[] = [{ role: "user", content: "lookup" }];
    if (legacy)
      messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "legacy",
              toolName: "find_tools",
              input: { query: "lookup" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "legacy",
              toolName: "find_tools",
              output: { type: "json", value: { matches: [{ name: "lookup" }] } },
            },
          ],
        },
      );
    const canonical = seedAnthropicToolSearch({ model, messages, tools, deferredTools });
    const ids = new Set(
      canonical.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" ? [part.toolCallId] : [],
            )
          : [],
      ),
    );
    expect(ids.size).toBe(1);
    const pruned = applyToolOutputCompactionView({
      messages: canonical,
      compactedToolCallIds: ids,
    });
    const projected = prepareAnthropicToolSearch({ model, messages: pruned, tools, deferredTools });
    const output = JSON.stringify(projected.messages);
    expect(output).not.toContain("[Old tool result content cleared]");
    expect(JSON.stringify(pruned)).toContain("[Old tool result content cleared]");
    expect(output).toContain('"type":"tool-reference","toolName":"lookup"');
    expect(seedAnthropicToolSearch({ model, messages: canonical, tools, deferredTools })).toBe(
      canonical,
    );
    const replay = structuredClone(canonical);
    expect(seedAnthropicToolSearch({ model, messages: replay, tools, deferredTools })).toBe(replay);
  });
}
