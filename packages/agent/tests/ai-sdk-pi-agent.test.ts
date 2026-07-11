import { describe, expect, it } from "bun:test";
import { jsonSchema, tool, type LanguageModel, type ToolModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { AiSdkPiAgent, extractToolCallsFromMessages } from "../ai-sdk-pi-agent";

function fakeModel(): LanguageModel {
  return {} as LanguageModel;
}

function zeroUsage() {
  return {
    inputTokens: {
      total: 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: 0,
      text: 0,
      reasoning: 0,
    },
  };
}

describe("AiSdkPiAgent model spec tracking", () => {
  it("stores initial modelSpecifier and updates on setModel", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      modelSpecifier: "anthropic/claude-sonnet-4-5",
      reasoning: "high",
    });

    expect(agent.state.modelSpecifier).toBe("anthropic/claude-sonnet-4-5");
    expect(agent.state.reasoning).toBe("high");

    agent.setModel(fakeModel(), undefined, "openai/gpt-4.1-mini", "low");
    expect(agent.state.modelSpecifier).toBe("openai/gpt-4.1-mini");
    expect(agent.state.reasoning).toBe("low");

    agent.setModel(fakeModel());
    expect(agent.state.modelSpecifier).toBeUndefined();
    expect(agent.state.reasoning).toBeUndefined();
  });

  it("normalizes stringified assistant tool-call inputs from constructor messages", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "edit_file",
              input: '{"path":"note.txt","edits":[{"op":"replace","lines":["after"]}}',
            },
          ],
        },
      ],
    });

    const assistant = agent.state.messages[1];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant message");
    }

    const part = assistant.content[0];
    expect(part?.type).toBe("tool-call");
    if (!part || part.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }

    expect(part.input).toEqual({
      path: "note.txt",
      edits: [
        {
          op: "replace",
          lines: ["after"],
        },
      ],
    });
  });

  it("dedupes duplicate tool results from constructor messages", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "edit_file",
              input: { path: "note.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "edit_file",
              output: { type: "error-text", value: "first" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "edit_file",
              output: { type: "error-text", value: "second" },
            },
          ],
        },
      ],
    });

    expect(agent.state.messages).toHaveLength(2);
    expect(agent.state.messages[1]?.role).toBe("tool");
  });

  it("does not schedule local execution when a tool result already exists", () => {
    expect(
      extractToolCallsFromMessages([
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "edit_file",
              input: { path: "note.txt" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "edit_file",
              output: { type: "error-text", value: "already handled" },
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("appends messages while idle", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    agent.appendMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "subagent_result",
            input: { childRequestId: "child-1", status: "resolved" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "subagent_result",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ]);

    expect(agent.state.messages).toHaveLength(3);
    expect(agent.state.messages[1]?.role).toBe("assistant");
    expect(agent.state.messages[2]?.role).toBe("tool");
  });

  it("normalizes stringified assistant tool-call inputs when appending", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    agent.appendMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edit_file",
            input: '{"path":"note.txt","oldText":"before","newText":"after"}',
          },
        ],
      },
    ]);

    const assistant = agent.state.messages[1];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant message");
    }

    const part = assistant.content[0];
    expect(part?.type).toBe("tool-call");
    if (!part || part.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }

    expect(part.input).toEqual({
      path: "note.txt",
      oldText: "before",
      newText: "after",
    });
  });

  it("normalizes stringified assistant tool-call inputs when replacing", () => {
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [{ role: "user", content: "hello" }],
    });

    agent.replaceMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "edit_file",
            input: '{"path":"note.txt"}',
          },
        ],
      },
    ]);

    const assistant = agent.state.messages[0];
    expect(assistant?.role).toBe("assistant");
    if (!assistant || assistant.role !== "assistant" || !Array.isArray(assistant.content)) {
      throw new Error("expected assistant message");
    }

    const part = assistant.content[0];
    expect(part?.type).toBe("tool-call");
    if (!part || part.type !== "tool-call") {
      throw new Error("expected tool-call part");
    }

    expect(part.input).toEqual({ path: "note.txt" });
  });

  it("bounds JSON normalization failures without marking successful execution failed", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "cycle_tool",
                input: "{}",
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "done" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
      ],
    });

    const toolEnds: Array<{ isError: boolean; result: unknown }> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        cycle_tool: tool({
          description: "returns a cyclic object",
          inputSchema: jsonSchema({
            type: "object",
            additionalProperties: false,
          }),
          execute: () => {
            const result: { ok: true; self?: unknown } = { ok: true };
            result.self = result;
            return result;
          },
        }),
      },
      normalizeToolResultOutput: () => {
        throw new Error("serialization failed");
      },
    });

    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        toolEnds.push({ isError: event.isError, result: event.result });
      }
    });

    await agent.prompt("call the cyclic tool");

    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]?.isError).toBe(false);

    const toolMessage = agent.state.messages.find(
      (message): message is ToolModelMessage => message.role === "tool",
    );
    const output =
      toolMessage?.content[0]?.type === "tool-result" ? toolMessage.content[0].output : undefined;

    expect(output).toEqual({ type: "text", value: "[tool result is not JSON-serializable]" });
  });

  it("serializes non-finite successful tool outputs through JSON fallback", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "nan_tool",
                input: "{}",
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "done" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
      ],
    });

    const toolEnds: Array<{ isError: boolean; result: unknown }> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        nan_tool: tool({
          description: "returns NaN",
          inputSchema: jsonSchema({
            type: "object",
            additionalProperties: false,
          }),
          execute: () => Number.NaN,
        }),
      },
    });

    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        toolEnds.push({ isError: event.isError, result: event.result });
      }
    });

    await agent.prompt("call the NaN tool");

    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0]?.isError).toBe(false);

    const toolMessage = agent.state.messages.find(
      (message): message is ToolModelMessage => message.role === "tool",
    );
    const output =
      toolMessage?.content[0]?.type === "tool-result" ? toolMessage.content[0].output : undefined;

    expect(output).toEqual({ type: "json", value: null });
  });
});
