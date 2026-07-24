import { describe, expect, it } from "bun:test";
import { jsonSchema, tool, type LanguageModel, type ModelMessage, type ToolModelMessage } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { AiSdkPiAgent, extractToolCallsFromMessages } from "../ai-sdk-pi-agent";
import { ToolExpansion } from "../tool-call-expansion";

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

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function syntheticResultMessages(toolCallId: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "subagent_result",
          input: { status: "resolved" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "subagent_result",
          output: { type: "text", value: "child result" },
        },
      ],
    },
  ];
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

  it("does not normalize constructor history or replacement input", () => {
    const constructorToolMessage: ToolModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "constructor-call",
          toolName: "history_tool",
          output: { type: "text", value: "constructor output" },
        },
      ],
    };
    const replacementToolMessage: ToolModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "replacement-call",
          toolName: "history_tool",
          output: { type: "text", value: "replacement output" },
        },
      ],
    };
    let normalizations = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      messages: [constructorToolMessage],
      normalizeToolResultOutput: () => {
        normalizations += 1;
        return { type: "text", value: "normalized" };
      },
    });

    expect(agent.state.messages).toEqual([constructorToolMessage]);
    expect(normalizations).toBe(0);

    agent.replaceMessages([replacementToolMessage]);

    expect(agent.state.messages).toEqual([replacementToolMessage]);
    expect(normalizations).toBe(0);
  });

  it("continues after the SDK produces a tool result for invalid input", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "read-invalid",
                toolName: "read_file",
                input: '{"start":{"line":1390}}',
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
              { type: "text-delta", id: "text-1", delta: "recovered" },
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
    let executions = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        read_file: tool({
          inputSchema: jsonSchema(
            {
              type: "object",
              properties: {
                start: {
                  type: "object",
                  properties: {
                    type: { const: "line" },
                    line: { type: "number" },
                  },
                  required: ["type", "line"],
                },
              },
              required: ["start"],
              additionalProperties: false,
            },
            {
              validate: () => ({
                success: false,
                error: new Error("start.type is required"),
              }),
            },
          ),
          execute: () => {
            executions += 1;
            return "unexpected";
          },
        }),
      },
    });

    await agent.prompt("read from line 1390");

    expect(executions).toBe(0);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
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

    expect(output).toEqual({ type: "error-text", value: "[tool result is not JSON-serializable]" });
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

describe("AiSdkPiAgent provider stream parts", () => {
  it("emits custom, source, file, and reasoning-file updates without text or tools", async () => {
    const providerMetadata = { test: { itemId: "provider-item" } };
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "custom", kind: "test.redacted", providerMetadata },
            {
              type: "source",
              sourceType: "url",
              id: "url-source",
              url: "https://example.test/source",
              title: "URL source",
              providerMetadata,
            },
            {
              type: "source",
              sourceType: "document",
              id: "document-source",
              mediaType: "application/pdf",
              title: "Document source",
              filename: "source.pdf",
              providerMetadata,
            },
            {
              type: "file",
              mediaType: "text/plain",
              data: { type: "data", data: "ZmlsZQ==" },
              providerMetadata,
            },
            {
              type: "reasoning-file",
              mediaType: "application/json",
              data: { type: "data", data: "e30=" },
              providerMetadata,
            },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: zeroUsage(),
            },
          ],
        }),
      },
    });
    const agent = new AiSdkPiAgent({ system: "test", model });
    const updates: Array<{ type: string; rawType: string; providerMetadata: unknown }> = [];
    let messageStarts = 0;
    let messageEnds = 0;
    agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") messageStarts += 1;
      if (event.type === "message_end" && event.message.role === "assistant") messageEnds += 1;
      if (event.type === "message_update") {
        updates.push({
          type: event.assistantMessageEvent.type,
          rawType: event.assistantMessageEvent.raw.type,
          providerMetadata: event.assistantMessageEvent.raw.providerMetadata,
        });
      }
    });

    await agent.prompt("provider parts");

    expect(messageStarts).toBe(1);
    expect(messageEnds).toBe(1);
    expect(updates.map(({ type, rawType }) => [type, rawType])).toEqual([
      ["custom", "custom"],
      ["source", "source"],
      ["source", "source"],
      ["file", "file"],
      ["reasoning_file", "reasoning-file"],
    ]);
    expect(updates.every((update) => update.providerMetadata === providerMetadata)).toBe(true);
  });

  it("normalizes response tool messages before events and the next model call", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "provider-1",
                toolName: "provider_one",
                input: "{}",
              },
              {
                type: "tool-call",
                toolCallId: "provider-2",
                toolName: "provider_two",
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
    const normalizationContexts: Array<{
      toolCallId: string;
      toolName: string;
      bypassGenericOutputNormalizer?: boolean;
    }> = [];
    const toolEvents: ToolModelMessage[] = [];
    let executions = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        provider_one: tool({
          inputSchema: jsonSchema(
            { type: "object", additionalProperties: false },
            {
              validate: () => ({ success: false, error: new Error("raw provider one") }),
            },
          ),
          execute: () => {
            executions += 1;
            return "must not execute";
          },
        }),
        provider_two: tool({
          inputSchema: jsonSchema(
            { type: "object", additionalProperties: false },
            {
              validate: () => ({ success: false, error: new Error("raw provider two") }),
            },
          ),
          execute: () => {
            executions += 1;
            return "must not execute";
          },
        }),
      },
      genericOutputNormalizerBypassTools: new Set(["provider_one", "provider_two"]),
      normalizeToolResultOutput: (_output, context) => {
        normalizationContexts.push(context);
        return { type: "text", value: `normalized:${context.toolCallId}` };
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "tool") {
        toolEvents.push(event.message);
      }
    });

    await agent.prompt("use provider outputs");

    expect(executions).toBe(0);
    expect(normalizationContexts).toEqual([
      { toolCallId: "provider-1", toolName: "provider_one" },
      { toolCallId: "provider-2", toolName: "provider_two" },
    ]);
    expect(toolEvents).toHaveLength(1);
    expect(
      toolEvents[0]?.content.map((part) => (part.type === "tool-result" ? part.output : part)),
    ).toEqual([
      { type: "text", value: "normalized:provider-1" },
      { type: "text", value: "normalized:provider-2" },
    ]);
    expect(
      agent.state.messages.find(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) => part.type === "tool-result" && part.toolCallId === "provider-1",
          ),
      ),
    ).toEqual(toolEvents[0]);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("normalized:provider-1");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("normalized:provider-2");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("raw provider one");
  });
});

describe("AiSdkPiAgent queued steering and cancellation", () => {
  it("returns stable steering IDs and interrupts with every queued message exactly once", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
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
    });
    const firstTransformEntered = deferred();
    const releaseFirstTransform = deferred();
    const modelInputs: Array<readonly ModelMessage[]> = [];
    let transformCount = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      transformMessages: async (messages) => {
        modelInputs.push(messages);
        transformCount += 1;
        if (transformCount === 1) {
          firstTransformEntered.resolve();
          await releaseFirstTransform.promise;
        }
        return [...messages];
      },
    });

    const run = agent.prompt("start");
    await firstTransformEntered.promise;

    expect(agent.interruptQueuedSteering()).toEqual({ status: "empty" });
    agent.followUp("queued follow-up");
    const firstId = agent.steer("first steering");
    const secondId = agent.steer("second steering");
    expect(firstId).toBe("steering-1");
    expect(secondId).toBe("steering-2");

    expect(agent.interruptQueuedSteering()).toEqual({
      status: "interrupted",
      steeringIds: [firstId, secondId],
    });
    expect(agent.interruptQueuedSteering()).toEqual({ status: "empty" });

    releaseFirstTransform.resolve();
    await run;

    expect(modelInputs).toHaveLength(2);
    expect(modelInputs[1]).toEqual([
      { role: "user", content: "start" },
      {
        role: "user",
        content: "queued follow-up\n\nfirst steering\n\nsecond steering",
      },
    ]);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      {
        role: "user",
        content: "queued follow-up\n\nfirst steering\n\nsecond steering",
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("merges a second queued interrupt batch into the pending interrupt in admission order", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
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
    });
    const firstTransformEntered = deferred();
    const releaseFirstTransform = deferred();
    const modelInputs: Array<readonly ModelMessage[]> = [];
    const interruptAbortEvents: string[] = [];
    let transformCount = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      transformMessages: async (messages) => {
        modelInputs.push(messages);
        transformCount += 1;
        if (transformCount === 1) {
          firstTransformEntered.resolve();
          await releaseFirstTransform.promise;
        }
        return [...messages];
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_abort" && event.reason === "interrupt") {
        interruptAbortEvents.push(event.reason);
      }
    });

    const run = agent.prompt("start");
    await firstTransformEntered.promise;

    agent.followUp("first follow-up");
    const firstId = agent.steer("first steering");
    expect(agent.interruptQueuedSteering()).toEqual({
      status: "interrupted",
      steeringIds: [firstId],
    });

    agent.followUp("second follow-up");
    const secondId = agent.steer("second steering");
    expect(agent.interruptQueuedSteering()).toEqual({
      status: "interrupted",
      steeringIds: [secondId],
    });
    expect(agent.getQueuedSteeringIds()).toEqual([]);
    expect(agent.interruptQueuedSteering()).toEqual({ status: "empty" });

    releaseFirstTransform.resolve();
    await run;

    const interruptedMessage = {
      role: "user" as const,
      content: "first follow-up\n\nfirst steering\n\nsecond follow-up\n\nsecond steering",
    };
    expect(interruptAbortEvents).toEqual(["interrupt"]);
    expect(modelInputs).toEqual([
      [{ role: "user", content: "start" }],
      [{ role: "user", content: "start" }, interruptedMessage],
    ]);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      interruptedMessage,
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("cancels without a message, rewinds, clears queues, and does not leak into a later prompt", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "cancelled-call",
                toolName: "lookup",
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
              { type: "text-start", id: "text-later" },
              { type: "text-delta", id: "text-later", delta: "later response" },
              { type: "text-end", id: "text-later" },
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
    const modelInputs: Array<readonly ModelMessage[]> = [];
    const cancelResets: Array<{ messages: ModelMessage[]; droppedMessageCount: number }> = [];
    let cancelled = false;
    let toolExecutions = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            toolExecutions += 1;
            return "unexpected";
          },
        }),
      },
      transformMessages: (messages) => {
        modelInputs.push(messages);
        return [...messages];
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_end" && !cancelled) {
        cancelled = true;
        agent.steer("must be cleared");
        agent.followUp("also must be cleared");
        agent.cancel();
      }
      if (event.type === "messages_reset" && event.reason === "cancel") {
        cancelResets.push({
          messages: event.messages,
          droppedMessageCount: event.droppedMessageCount,
        });
      }
    });

    await agent.prompt("original prompt");

    expect(toolExecutions).toBe(0);
    expect(cancelResets).toEqual([
      {
        messages: [{ role: "user", content: "original prompt" }],
        droppedMessageCount: 1,
      },
    ]);
    expect(agent.state.messages).toEqual([{ role: "user", content: "original prompt" }]);

    await agent.prompt("later prompt");

    expect(modelInputs).toEqual([
      [{ role: "user", content: "original prompt" }],
      [
        { role: "user", content: "original prompt" },
        { role: "user", content: "later prompt" },
      ],
    ]);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "original prompt" },
      { role: "user", content: "later prompt" },
      {
        role: "assistant",
        content: [{ type: "text", text: "later response" }],
      },
    ]);
  });

  it("lets cancellation win while the turn error handler is awaited", async () => {
    for (const decision of ["fail", "retry"] as const) {
      const handlerEntered = deferred();
      const releaseHandler = deferred();
      const originalError = new Error(`original ${decision} error`);
      const cancelAbortEvents: string[] = [];
      const cancelResetEvents: string[] = [];
      const agent = new AiSdkPiAgent({
        system: "test",
        model: fakeModel(),
        transformMessages: () => {
          throw originalError;
        },
        turnErrorHandler: async () => {
          handlerEntered.resolve();
          await releaseHandler.promise;
          return decision;
        },
      });
      agent.subscribe((event) => {
        if (event.type === "turn_abort" && event.reason === "cancel") {
          cancelAbortEvents.push(event.reason);
        }
        if (event.type === "messages_reset" && event.reason === "cancel") {
          cancelResetEvents.push(event.reason);
        }
      });

      const run = agent.prompt(`${decision} prompt`);
      await handlerEntered.promise;
      agent.steer("must be cleared");
      agent.followUp("also must be cleared");
      agent.cancel();
      releaseHandler.resolve();
      await run;

      expect(cancelAbortEvents).toEqual(["cancel"]);
      expect(cancelResetEvents).toEqual(["cancel"]);
      expect(agent.state.error).toBeUndefined();
      expect(agent.state.messages).toEqual([{ role: "user", content: `${decision} prompt` }]);
      expect(agent.interruptQueuedSteering()).toEqual({ status: "empty" });
    }
  });

  it("preserves a manual abort when the awaited turn error handler rejects", async () => {
    const handlerEntered = deferred();
    const handlerAborted = deferred();
    const terminalEvents: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      transformMessages: () => {
        throw new Error("transient model error");
      },
      turnErrorHandler: async (_error, context) => {
        handlerEntered.resolve();
        if (context.abortSignal?.aborted) return "fail" as const;
        await new Promise<void>((resolve) => {
          context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        handlerAborted.resolve();
        throw new Error("handler aborted");
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_abort") {
        terminalEvents.push(`${event.type}:${event.reason}`);
      } else if (event.type === "agent_end") {
        terminalEvents.push(event.type);
      }
    });

    const run = agent.prompt("abort during backoff");
    await handlerEntered.promise;
    agent.abort();
    await handlerAborted.promise;
    await run;

    expect(terminalEvents).toEqual(["turn_abort:manual", "agent_end"]);
    expect(agent.state.error).toBeUndefined();
    expect(agent.state.messages).toEqual([{ role: "user", content: "abort during backoff" }]);
  });

  it("lets cancellation win when the awaited turn error handler rejects", async () => {
    const handlerEntered = deferred();
    const releaseHandler = deferred();
    const terminalEvents: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      transformMessages: () => {
        throw new Error("original turn error");
      },
      turnErrorHandler: async () => {
        handlerEntered.resolve();
        await releaseHandler.promise;
        throw new Error("handler rejection");
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_abort") {
        terminalEvents.push(`${event.type}:${event.reason}`);
      } else if (event.type === "messages_reset") {
        terminalEvents.push(`${event.type}:${event.reason}`);
      } else if (event.type === "agent_end") {
        terminalEvents.push(event.type);
      }
    });

    const run = agent.prompt("cancel rejected handler");
    await handlerEntered.promise;
    agent.cancel();
    releaseHandler.resolve();
    await run;

    expect(terminalEvents).toEqual(["turn_abort:cancel", "messages_reset:cancel", "agent_end"]);
    expect(agent.state.error).toBeUndefined();
    expect(agent.state.messages).toEqual([{ role: "user", content: "cancel rejected handler" }]);
  });

  it("preserves turn error handler rejection when cancellation was not requested", async () => {
    const handlerError = new Error("handler rejection");
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      transformMessages: () => {
        throw new Error("original turn error");
      },
      turnErrorHandler: async () => {
        throw handlerError;
      },
    });

    await expect(agent.prompt("fail normally")).rejects.toBe(handlerError);
    expect(agent.state.error).toBe(handlerError.message);
  });

  it("replays a failed model turn after partial output without committing the failed draft", async () => {
    const streamError = new Error("WebSocket closed before a terminal response event");
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "partial" },
              { type: "text-delta", id: "partial", delta: "partial answer" },
              { type: "error", error: streamError },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "recovered" },
              { type: "text-delta", id: "recovered", delta: "recovered answer" },
              { type: "text-end", id: "recovered" },
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
    const retries: boolean[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      turnErrorHandler: (_error, context) => (context.retrySafety.canRetry ? "retry" : "fail"),
    });
    agent.subscribe((event) => {
      if (event.type === "turn_retry") retries.push(event.hadPartialOutput);
    });

    await agent.prompt("answer once");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[1]?.prompt).toEqual(model.doStreamCalls[0]?.prompt);
    expect(retries).toEqual([true]);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "answer once" },
      { role: "assistant", content: [{ type: "text", text: "recovered answer" }] },
    ]);
  });

  it("does not replay after provider-executed tool activity", async () => {
    const streamError = new Error("WebSocket closed before a terminal response event");
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "provider-call",
              toolName: "provider_search",
              input: "{}",
              providerExecuted: true,
            },
            { type: "error", error: streamError },
          ],
        }),
      },
    });
    const retryReasons: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      turnErrorHandler: async (_error, context) => {
        if (!context.retrySafety.canRetry) retryReasons.push(context.retrySafety.reason);
        return "retry" as const;
      },
    });

    await expect(agent.prompt("search")).rejects.toBe(streamError);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(retryReasons).toEqual(["provider-executed-tool"]);
    expect(agent.state.messages).toEqual([{ role: "user", content: "search" }]);
  });

  it("does not replay after a provider-executed tool result", async () => {
    const streamError = new Error("WebSocket closed before a terminal response event");
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-result",
              toolCallId: "provider-call",
              toolName: "provider_search",
              input: {},
              result: "result",
              providerExecuted: true as const,
            },
            { type: "error", error: streamError },
          ],
        }),
      },
    });
    const retryReasons: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      turnErrorHandler: async (_error, context) => {
        if (!context.retrySafety.canRetry) retryReasons.push(context.retrySafety.reason);
        return "retry" as const;
      },
    });

    await expect(agent.prompt("search")).rejects.toBe(streamError);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(retryReasons).toEqual(["provider-executed-tool"]);
  });

  it("replays a local tool draft and executes only the completed retry", async () => {
    const streamError = new Error("WebSocket closed before a terminal response event");
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "draft-call",
                toolName: "lookup",
                input: "{}",
              },
              { type: "error", error: streamError },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "completed-call",
                toolName: "lookup",
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
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "done" },
              { type: "text-end", id: "answer" },
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
    let executions = 0;
    const abandonedToolCalls: string[][] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            executions += 1;
            return "result";
          },
        }),
      },
      turnErrorHandler: (_error, context) => (context.retrySafety.canRetry ? "retry" : "fail"),
    });
    agent.subscribe((event) => {
      if (event.type === "turn_retry") {
        abandonedToolCalls.push(event.abandonedToolCallIds);
      }
    });

    await agent.prompt("look it up");

    expect(model.doStreamCalls).toHaveLength(3);
    expect(executions).toBe(1);
    expect(abandonedToolCalls).toEqual([["draft-call"]]);
    expect(JSON.stringify(agent.state.messages)).not.toContain("draft-call");
    expect(JSON.stringify(agent.state.messages)).toContain("completed-call");
  });

  it("does not replay errors after the model turn commits", async () => {
    const boundaryError = new Error("boundary network timeout");
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "committed" },
            { type: "text-end", id: "answer" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: zeroUsage(),
            },
          ],
        }),
      },
    });
    const retryReasons: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      turnBoundaryHandler: () => {
        throw boundaryError;
      },
      turnErrorHandler: async (_error, context) => {
        if (!context.retrySafety.canRetry) retryReasons.push(context.retrySafety.reason);
        return "retry" as const;
      },
    });

    await expect(agent.prompt("finish")).rejects.toBe(boundaryError);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(retryReasons).toEqual(["post-model-phase"]);
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "committed" }],
    });
  });

  it("stops before approval when cancellation is requested by a tool start subscriber", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "tool-call", toolCallId: "cancel-at-start", toolName: "lookup", input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: zeroUsage(),
            },
          ],
        }),
      },
    });
    const terminalEvents: string[] = [];
    let approvalChecks = 0;
    let executions = 0;
    let normalizations = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          needsApproval: () => {
            approvalChecks += 1;
            return false;
          },
          execute: () => {
            executions += 1;
            return "unexpected";
          },
        }),
      },
      normalizeToolResultOutput: (output) => {
        normalizations += 1;
        return output;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        terminalEvents.push(event.type);
        agent.cancel();
      } else if (event.type === "turn_abort") {
        terminalEvents.push(`${event.type}:${event.reason}`);
      } else if (event.type === "messages_reset") {
        terminalEvents.push(`${event.type}:${event.reason}`);
      } else if (event.type === "agent_end") {
        terminalEvents.push(event.type);
      }
    });

    await agent.prompt("cancel tool at start");

    expect(approvalChecks).toBe(0);
    expect(executions).toBe(0);
    expect(normalizations).toBe(0);
    expect(terminalEvents).toEqual([
      "tool_execution_start",
      "turn_abort:cancel",
      "messages_reset:cancel",
      "agent_end",
    ]);
    expect(agent.state.messages).toEqual([{ role: "user", content: "cancel tool at start" }]);
  });

  it("stops before execution when cancellation occurs while approval is awaited", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "cancel-during-approval",
              toolName: "lookup",
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
    });
    const approvalEntered = deferred();
    const releaseApproval = deferred();
    const terminalEvents: string[] = [];
    let executions = 0;
    let normalizations = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          needsApproval: async () => {
            approvalEntered.resolve();
            await releaseApproval.promise;
            return false;
          },
          execute: () => {
            executions += 1;
            return "unexpected";
          },
        }),
      },
      normalizeToolResultOutput: (output) => {
        normalizations += 1;
        return output;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        terminalEvents.push(event.type);
      } else if (event.type === "turn_abort") {
        terminalEvents.push(`${event.type}:${event.reason}`);
      } else if (event.type === "messages_reset") {
        terminalEvents.push(`${event.type}:${event.reason}`);
      } else if (event.type === "agent_end") {
        terminalEvents.push(event.type);
      }
    });

    const run = agent.prompt("cancel during approval");
    await approvalEntered.promise;
    agent.cancel();
    releaseApproval.resolve();
    await run;

    expect(executions).toBe(0);
    expect(normalizations).toBe(0);
    expect(terminalEvents).toEqual([
      "tool_execution_start",
      "turn_abort:cancel",
      "messages_reset:cancel",
      "agent_end",
    ]);
    expect(agent.state.messages).toEqual([{ role: "user", content: "cancel during approval" }]);
  });

  it("closes a streaming tool iterator when cancellation interrupts its output", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "cancel-streaming-tool",
              toolName: "streaming",
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
    });
    let cleanedUp = false;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        streaming: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async function* () {
            try {
              yield "first";
              yield "unexpected";
            } finally {
              cleanedUp = true;
            }
          },
        }),
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_update") agent.cancel();
    });

    await agent.prompt("cancel streaming tool");

    expect(cleanedUp).toBe(true);
    expect(agent.state.messages).toEqual([{ role: "user", content: "cancel streaming tool" }]);
  });
});

describe("AiSdkPiAgent turn boundaries", () => {
  it("injects boundary messages after tool results and before the next model turn", async () => {
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
    const sequence: string[] = [];
    const modelInputs: Array<readonly ModelMessage[]> = [];
    let boundaryCount = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          description: "lookup",
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "lookup result",
        }),
      },
      turnBoundaryHandler: (context) => {
        boundaryCount += 1;
        sequence.push(`boundary:${context.executedToolCallCount}`);
        modelInputs.push(context.modelInputMessages);
        return boundaryCount === 1 ? { append: syntheticResultMessages("subagent-result-1") } : {};
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "tool") {
        const part = event.message.content[0];
        sequence.push(`tool:${part?.type === "tool-result" ? part.toolName : "unknown"}`);
      }
      if (event.type === "agent_end") sequence.push("agent_end");
    });

    await agent.prompt("start");

    expect(sequence.indexOf("tool:lookup")).toBeLessThan(sequence.indexOf("boundary:1"));
    expect(sequence.indexOf("boundary:1")).toBeLessThan(sequence.indexOf("tool:subagent_result"));
    expect(sequence.indexOf("tool:subagent_result")).toBeLessThan(
      sequence.lastIndexOf("boundary:0"),
    );
    expect(sequence.at(-1)).toBe("agent_end");
    expect(modelInputs).toHaveLength(2);
    expect(
      modelInputs[1]?.some(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) => part.type === "tool-result" && part.toolCallId === "subagent-result-1",
          ),
      ),
    ).toBe(true);
  });

  it("normalizes boundary tool messages before insertion, events, and the next model call", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
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
    const historyToolMessage: ToolModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "history-call",
          toolName: "history_tool",
          output: { type: "text", value: "existing history" },
        },
      ],
    };
    const boundaryToolMessage: ToolModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "boundary-1",
          toolName: "boundary_one",
          output: { type: "text", value: "raw boundary one" },
        },
        {
          type: "tool-approval-response",
          approvalId: "boundary-approval",
          approved: true,
          providerExecuted: true,
        },
        {
          type: "tool-result",
          toolCallId: "boundary-2",
          toolName: "boundary_two",
          output: { type: "text", value: "raw boundary two" },
        },
      ],
    };
    const normalizationContexts: Array<{
      toolCallId: string;
      toolName: string;
      bypassGenericOutputNormalizer?: boolean;
    }> = [];
    const toolEvents: ToolModelMessage[] = [];
    let boundaries = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "history-call",
              toolName: "history_tool",
              input: {},
            },
          ],
        },
        historyToolMessage,
      ],
      genericOutputNormalizerBypassTools: new Set(["history_tool", "boundary_one", "boundary_two"]),
      normalizeToolResultOutput: (_output, context) => {
        normalizationContexts.push(context);
        return { type: "text", value: `normalized:${context.toolCallId}` };
      },
      turnBoundaryHandler: () => {
        boundaries += 1;
        if (boundaries !== 1) return {};
        return {
          append: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "boundary-1",
                  toolName: "boundary_one",
                  input: {},
                  providerExecuted: true,
                },
                {
                  type: "tool-approval-request",
                  approvalId: "boundary-approval",
                  toolCallId: "boundary-1",
                },
                {
                  type: "tool-call",
                  toolCallId: "boundary-2",
                  toolName: "boundary_two",
                  input: {},
                  providerExecuted: true,
                },
              ],
            },
            boundaryToolMessage,
          ],
        };
      },
    });
    agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "tool" &&
        event.message.content.some(
          (part) => part.type === "tool-result" && part.toolCallId === "boundary-1",
        )
      ) {
        toolEvents.push(event.message);
      }
    });

    await agent.prompt("use boundary outputs");

    expect(normalizationContexts).toEqual([
      { toolCallId: "boundary-1", toolName: "boundary_one" },
      { toolCallId: "boundary-2", toolName: "boundary_two" },
    ]);
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "boundary-1",
        toolName: "boundary_one",
        output: { type: "text", value: "normalized:boundary-1" },
      },
      {
        type: "tool-approval-response",
        approvalId: "boundary-approval",
        approved: true,
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "boundary-2",
        toolName: "boundary_two",
        output: { type: "text", value: "normalized:boundary-2" },
      },
    ]);
    expect(agent.state.messages[1]).toEqual(historyToolMessage);
    expect(
      agent.state.messages.find(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) => part.type === "tool-result" && part.toolCallId === "boundary-1",
          ),
      ),
    ).toEqual(toolEvents[0]);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("normalized:boundary-1");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("normalized:boundary-2");
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("raw boundary one");
  });

  it("forces another model turn when a stop boundary injects a result", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-2" },
              { type: "text-delta", id: "text-2", delta: "used child result" },
              { type: "text-end", id: "text-2" },
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
    let boundaries = 0;
    let agentEnds = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      turnBoundaryHandler: () => {
        boundaries += 1;
        return boundaries === 1 ? { append: syntheticResultMessages("subagent-result-stop") } : {};
      },
    });
    agent.subscribe((event) => {
      if (event.type === "agent_end") agentEnds += 1;
    });

    await agent.prompt("start");

    expect(boundaries).toBe(2);
    expect(agentEnds).toBe(1);
    expect(agent.state.messages.at(-1)?.role).toBe("assistant");
  });

  it("waits for every parallel tool result before invoking the boundary", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "read-1", toolName: "read_file", input: "{}" },
              { type: "tool-call", toolCallId: "glob-1", toolName: "glob", input: "{}" },
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
    let appendedToolResults = 0;
    const firstBoundary: { executed: number; appended: number }[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        read_file: tool({
          description: "read",
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async () => {
            await Bun.sleep(5);
            return "read";
          },
        }),
        glob: tool({
          description: "glob",
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "glob",
        }),
      },
      turnBoundaryHandler: (context) => {
        if (context.executedToolCallCount > 0) {
          firstBoundary.push({
            executed: context.executedToolCallCount,
            appended: appendedToolResults,
          });
        }
        return {};
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "tool") {
        appendedToolResults += 1;
      }
    });

    await agent.prompt("start");

    expect(firstBoundary).toEqual([{ executed: 2, appended: 2 }]);
  });

  it("rejects other calls in a turn containing an exclusive tool", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "skill-1", toolName: "skill", input: "{}" },
              { type: "tool-call", toolCallId: "bash-1", toolName: "bash", input: "{}" },
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
    let skillCalls = 0;
    let bashCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        skill: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            skillCalls += 1;
            return { instructions: "read first" };
          },
        }),
        bash: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            bashCalls += 1;
            return "should not run";
          },
        }),
      },
      exclusiveToolNames: new Set(["skill"]),
    });

    await agent.prompt("start");

    expect(skillCalls).toBe(1);
    expect(bashCalls).toBe(0);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(
      "was not executed because an exclusive tool was selected",
    );
  });

  it("does not append a boundary decision after the run is aborted", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: zeroUsage(),
            },
          ],
        }),
      },
    });
    let enterBoundary = () => {};
    const boundaryEntered = new Promise<void>((resolve) => {
      enterBoundary = resolve;
    });
    let releaseBoundary = () => {};
    const boundaryReleased = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      turnBoundaryHandler: async () => {
        enterBoundary();
        await boundaryReleased;
        return { append: syntheticResultMessages("subagent-result-aborted") };
      },
    });

    const run = agent.prompt("start");
    await boundaryEntered;
    agent.abort();
    releaseBoundary();
    await run;

    expect(
      agent.state.messages.some(
        (message) =>
          message.role === "tool" &&
          message.content.some(
            (part) => part.type === "tool-result" && part.toolCallId === "subagent-result-aborted",
          ),
      ),
    ).toBe(false);
  });
});

describe("AiSdkPiAgent tool-call expansion", () => {
  it("appends synthetic child calls after the parent result and uses normal child semantics", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "batch-1",
                toolName: "batch",
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
    let deniedExecuted = false;
    const updates: string[] = [];
    const normalizedNames: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        batch: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () =>
            new ToolExpansion(
              {
                ok: true,
                total: 3,
                children: ["media-1", "denied-1", "stream-1"],
              },
              [
                { toolCallId: "media-1", toolName: "media", input: {} },
                { toolCallId: "denied-1", toolName: "denied", input: {} },
                { toolCallId: "stream-1", toolName: "streaming", input: {} },
              ],
            ),
        }),
        media: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => ({ filename: "pixel.png" }),
          toModelOutput: () => ({
            type: "content",
            value: [
              { type: "text", text: "attached" },
              {
                type: "file",
                mediaType: "image/png",
                filename: "pixel.png",
                data: { type: "data", data: "AA==" },
              },
            ],
          }),
        }),
        denied: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          needsApproval: true,
          execute: () => {
            deniedExecuted = true;
            return { ok: true };
          },
        }),
        streaming: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async function* () {
            yield "first";
            yield "last";
          },
        }),
      },
      normalizeToolResultOutput: (output, context) => {
        normalizedNames.push(context.toolName);
        return output;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_update") updates.push(event.toolName);
    });

    await agent.prompt("expand");

    expect(deniedExecuted).toBe(false);
    expect(updates).toEqual(["streaming", "streaming"]);
    expect(normalizedNames[0]).toBe("batch");
    expect(new Set(normalizedNames.slice(1))).toEqual(new Set(["media", "denied", "streaming"]));

    const roles = agent.state.messages.map((message) => message.role);
    expect(roles.slice(1, 7)).toEqual(["assistant", "tool", "assistant", "tool", "tool", "tool"]);

    const parentResult = agent.state.messages[2];
    expect(parentResult?.role).toBe("tool");
    if (parentResult?.role !== "tool") return;
    expect(parentResult.content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "batch-1",
      toolName: "batch",
      output: { type: "json", value: { ok: true, total: 3 } },
    });

    const synthetic = agent.state.messages[3];
    expect(synthetic?.role).toBe("assistant");
    if (synthetic?.role !== "assistant" || !Array.isArray(synthetic.content)) return;
    expect(
      synthetic.content.filter((part) => part.type === "tool-call").map((part) => part.toolName),
    ).toEqual(["media", "denied", "streaming"]);

    const mediaResult = agent.state.messages[4];
    expect(mediaResult?.role).toBe("tool");
    if (mediaResult?.role !== "tool") return;
    expect(mediaResult.content[0]).toMatchObject({
      type: "tool-result",
      toolName: "media",
      output: {
        type: "content",
        value: [
          { type: "text", text: "attached" },
          { type: "file", mediaType: "image/png", filename: "pixel.png" },
        ],
      },
    });

    const deniedResult = agent.state.messages[5];
    expect(deniedResult?.role).toBe("tool");
    if (deniedResult?.role !== "tool") return;
    expect(deniedResult.content[0]).toMatchObject({
      type: "tool-result",
      toolName: "denied",
      output: { type: "execution-denied" },
    });
  });

  it("runs all provider-emitted calls through the shared eight-worker scheduler", async () => {
    const toolNames = Array.from({ length: 8 }, (_, index) => `worker_${index + 1}`);
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              ...toolNames.map((toolName, index) => ({
                type: "tool-call" as const,
                toolCallId: `worker-call-${index + 1}`,
                toolName,
                input: "{}",
              })),
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        {
          stream: simulateReadableStream({
            chunks: [
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
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tools = Object.fromEntries(
      toolNames.map((toolName) => [
        toolName,
        tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async () => {
            active += 1;
            peak = Math.max(peak, active);
            if (active === 8) release?.();
            await gate;
            active -= 1;
            return { ok: true };
          },
        }),
      ]),
    );
    const agent = new AiSdkPiAgent({ system: "test", model, tools });

    await agent.prompt("run all workers");

    expect(peak).toBe(8);
    const resultIds = agent.state.messages
      .filter((message): message is ToolModelMessage => message.role === "tool")
      .flatMap((message) =>
        message.content
          .filter((part) => part.type === "tool-result")
          .map((part) => part.toolCallId),
      );
    expect(resultIds).toEqual(toolNames.map((_, index) => `worker-call-${index + 1}`));
  });

  it("closes the provider call group before processing expansion groups sequentially", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "batch-a", toolName: "batch_a", input: "{}" },
              { type: "tool-call", toolCallId: "batch-b", toolName: "batch_b", input: "{}" },
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
    const expansionTool = (childId: string) =>
      tool({
        inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
        execute: () =>
          new ToolExpansion({ ok: true, childId }, [
            { toolCallId: childId, toolName: "child", input: { childId } },
          ]),
      });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        batch_a: expansionTool("child-a"),
        batch_b: expansionTool("child-b"),
        child: tool({
          inputSchema: jsonSchema({
            type: "object",
            properties: { childId: { type: "string" } },
            required: ["childId"],
            additionalProperties: false,
          }),
          execute: ({ childId }) => ({ childId }),
        }),
      },
    });

    await agent.prompt("expand twice");

    expect(agent.state.messages.slice(1, 8).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "tool",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    const syntheticIds = agent.state.messages
      .filter((message) => message.role === "assistant" && Array.isArray(message.content))
      .flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.flatMap((part) =>
              part.type === "tool-call" && part.toolName === "child" ? [part.toolCallId] : [],
            )
          : [],
      );
    expect(syntheticIds).toEqual(["child-a", "child-b"]);
  });

  it("rejects an expansion returned by an expanded child", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "outer", toolName: "batch", input: "{}" },
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
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        batch: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () =>
            new ToolExpansion({ ok: true }, [
              { toolCallId: "nested", toolName: "nested_expander", input: {} },
            ]),
        }),
        nested_expander: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => new ToolExpansion({ ok: true }, []),
        }),
      },
    });

    await agent.prompt("expand");

    const nestedResult = agent.state.messages.find(
      (message): message is ToolModelMessage =>
        message.role === "tool" &&
        message.content.some((part) => part.type === "tool-result" && part.toolCallId === "nested"),
    );
    expect(nestedResult?.content[0]).toMatchObject({
      type: "tool-result",
      output: {
        type: "error-text",
        value: "Nested tool-call expansions are not supported.",
      },
    });
  });
});
