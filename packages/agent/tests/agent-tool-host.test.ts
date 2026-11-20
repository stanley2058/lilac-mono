import { expect, test } from "bun:test";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { AgentToolHost } from "../agent-tool-host";

test("keeps projected results in batch slots when duplicate IDs finish out of order", async () => {
  let releaseFirst = () => {};
  const secondCheckpointed = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const schema = jsonSchema({ type: "object", properties: {} });
  const tools = {
    first: tool({
      inputSchema: schema,
      execute: async () => {
        await secondCheckpointed;
        return "first result";
      },
    }),
    second: tool({ inputSchema: schema, execute: () => "second result" }),
  };
  const messages: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "duplicate", toolName: "first", input: {} },
        { type: "tool-call", toolCallId: "duplicate", toolName: "second", input: {} },
      ],
    },
  ];
  const state = { tools, messages, pendingToolCalls: new Set<string>() };
  const snapshot = { step: 1, tools, names: Object.keys(tools) };
  const host = new AgentToolHost({
    readState: () => state,
    readContext: () => undefined,
    readAbortSignal: () => undefined,
    assertNotAborted: () => {},
    makeAbortError: () => new Error("aborted"),
    readLastStepSnapshot: () => snapshot,
    readToolExchangeBaseLength: () => 0,
    emit: () => {},
    appendMessage: (message) => {
      messages.push(message);
    },
    checkpointMessages: (candidate) => {
      if (
        candidate?.some(
          (message) =>
            message.role === "tool" &&
            message.content.some(
              (part) => part.type === "tool-result" && part.toolName === "second",
            ),
        )
      )
        releaseFirst();
    },
  });
  const result = await host.executeToolCalls(
    [
      { toolCallId: "duplicate", toolName: "first", input: {} },
      { toolCallId: "duplicate", toolName: "second", input: {} },
    ],
    snapshot,
    (part) => ({ ...part, providerOptions: { anthropic: { test: part.toolName } } }),
  );
  expect(result.isOk()).toBe(true);
  expect(messages.slice(1)).toEqual([
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "duplicate",
          toolName: "first",
          output: { type: "json", value: "first result" },
          providerOptions: { anthropic: { test: "first" } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "duplicate",
          toolName: "second",
          output: { type: "json", value: "second result" },
          providerOptions: { anthropic: { test: "second" } },
        },
      ],
    },
  ]);
});
