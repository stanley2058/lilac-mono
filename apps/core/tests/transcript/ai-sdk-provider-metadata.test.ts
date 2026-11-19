import { expect, it } from "bun:test";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import { storedMessagesV1Schema } from "@stanley2058/lilac-event-bus";
import { projectStoredMessagesV1 } from "../../src/transcript/stored-message-materialization";

it.each([undefined, "provider-tool-1"])(
  "persists finalized Opus caller metadata with toolId %s and its recovery checkpoints",
  async (toolId) => {
    const providerMetadata = {
      anthropic: {
        caller: { type: "direct", toolId },
        nested: [{ omitted: undefined, retained: null }],
      },
    };
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "lookup-1",
                toolName: "lookup",
                input: "{}",
                providerMetadata,
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "done" },
              { type: "text-end", id: "answer" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ],
          }),
        },
      ],
    });
    const checkpoints: (readonly ModelMessage[])[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "result",
        }),
      },
      recoveryCheckpointHandler: async (messages) => {
        checkpoints.push(structuredClone(messages));
      },
    });

    await agent.prompt("look it up");

    const withCaller = checkpoints.filter((messages) =>
      messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              "providerOptions" in part && part.providerOptions?.anthropic?.caller !== undefined,
          ),
      ),
    );
    expect(withCaller.length).toBeGreaterThan(0);
    for (const messages of [...checkpoints, agent.state.messages]) {
      expect(storedMessagesV1Schema.safeParse(messages).success).toBe(true);
      expect(projectStoredMessagesV1(messages).isOk()).toBe(true);
    }
    const assistant = agent.state.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([
      expect.objectContaining({
        type: "tool-call",
        providerOptions: {
          anthropic: {
            caller: toolId === undefined ? { type: "direct" } : { type: "direct", toolId },
            nested: [{ retained: null }],
          },
        },
      }),
    ]);
    expect(Object.hasOwn(providerMetadata.anthropic.caller, "toolId")).toBe(true);
    expect(Object.hasOwn(providerMetadata.anthropic.nested[0]!, "omitted")).toBe(true);
  },
);

it.each([undefined, "provider-tool-1"])(
  "persists content-entry provider metadata with toolId %s",
  async (toolId) => {
    const providerOptions = { anthropic: { caller: { type: "direct", toolId } } };
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "search-1",
              toolName: "search",
              input: "{}",
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "search-1",
              toolName: "search",
              result: "result",
              providerExecuted: true,
            },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            },
          ],
        }),
      },
    });
    const checkpoints: (readonly ModelMessage[])[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        search: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          toModelOutput: () => ({
            type: "content",
            value: [{ type: "text", text: "result", providerOptions }],
          }),
        }),
      },
      recoveryCheckpointHandler: async (messages) => {
        checkpoints.push(structuredClone(messages));
      },
    });
    await agent.prompt("search");
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const messages of [...checkpoints, agent.state.messages]) {
      expect(projectStoredMessagesV1(messages).isOk()).toBe(true);
    }
    const results = agent.state.messages.flatMap((message) =>
      typeof message.content === "string"
        ? []
        : message.content.filter((part) => part.type === "tool-result"),
    );
    expect(results).toEqual([
      expect.objectContaining({
        output: {
          type: "content",
          value: [
            {
              type: "text",
              text: "result",
              providerOptions: {
                anthropic: {
                  caller: toolId === undefined ? { type: "direct" } : { type: "direct", toolId },
                },
              },
            },
          ],
        },
      }),
    ]);
    expect(Object.hasOwn(providerOptions.anthropic.caller, "toolId")).toBe(true);
  },
);
