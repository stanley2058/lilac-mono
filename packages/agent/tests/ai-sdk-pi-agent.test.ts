import { describe, expect, it } from "bun:test";
import {
  APICallError,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolModelMessage,
} from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import {
  AiSdkPiAgent,
  extractToolCallsFromMessages,
  type IdleRecoveryResult,
} from "../ai-sdk-pi-agent";

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

function textStream(id: string, text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id },
        { type: "text-delta" as const, id, delta: text },
        { type: "text-end" as const, id },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function retryableApiCallError(): APICallError {
  return new APICallError({
    message: "Service unavailable",
    url: "https://api.example.test/v1/messages",
    requestBodyValues: {},
    statusCode: 503,
    responseHeaders: { "retry-after-ms": "0" },
    isRetryable: true,
  });
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

    agent.setExperimentalDownload(undefined);
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

describe("AiSdkPiAgent recovery checkpoints", () => {
  it("awaits the replay-safe checkpoint before starting the model call", async () => {
    const gate = deferred();
    let checkpointCalls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => textStream("answer", "done"),
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      recoveryCheckpointHandler: async () => {
        checkpointCalls += 1;
        if (checkpointCalls === 1) await gate.promise;
      },
    });

    const run = agent.prompt("persist first");
    await Promise.resolve();
    expect(model.doStreamCalls).toHaveLength(0);
    gate.resolve();
    await run;

    expect(model.doStreamCalls).toHaveLength(1);
    expect(checkpointCalls).toBeGreaterThanOrEqual(2);
  });

  it("checkpoints a completed local tool result before the continuation model call", async () => {
    const checkpointEntered = deferred();
    const releaseCheckpoint = deferred();
    let resultCheckpoint: readonly ModelMessage[] | undefined;
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "lookup-1", toolName: "lookup", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        textStream("answer", "used lookup result"),
      ],
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "local lookup result",
        }),
      },
      recoveryCheckpointHandler: async (messages) => {
        if (!JSON.stringify(messages).includes("local lookup result")) return;
        resultCheckpoint = messages;
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      },
    });

    const run = agent.prompt("look it up");
    await checkpointEntered.promise;

    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(resultCheckpoint)).toContain("lookup-1");
    expect(JSON.stringify(resultCheckpoint)).toContain("local lookup result");

    releaseCheckpoint.resolve();
    await run;

    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("checkpoints delivered steering and its follow-up before the next model call", async () => {
    const checkpointEntered = deferred();
    const releaseCheckpoint = deferred();
    let deliveredCheckpoint: readonly ModelMessage[] | undefined;
    let deliveredInputIds: readonly string[] | undefined;
    const prematureInputIds: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: [textStream("first", "initial answer"), textStream("second", "redirected")],
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      recoveryCheckpointHandler: async (messages, canonicalInputIds) => {
        const includesDeliveredMessage = messages.some(
          (message) =>
            message.role === "user" && message.content === "queued follow-up\n\nchange direction",
        );
        if (!includesDeliveredMessage) prematureInputIds.push(...canonicalInputIds);
        if (!includesDeliveredMessage) return;
        deliveredCheckpoint = messages;
        deliveredInputIds = canonicalInputIds;
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      },
    });
    const followUpId = agent.followUp("queued follow-up");
    const steeringId = agent.steer("change direction");

    const run = agent.prompt("start");
    await checkpointEntered.promise;

    expect(model.doStreamCalls).toHaveLength(1);
    expect(deliveredCheckpoint).toContainEqual({
      role: "user",
      content: "queued follow-up\n\nchange direction",
    });
    expect(prematureInputIds).toEqual([]);
    expect(deliveredInputIds).toEqual([followUpId, steeringId]);

    releaseCheckpoint.resolve();
    await run;

    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("lists queued follow-ups until a turn takes them", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        textStream("first", "initial answer"),
        textStream("second", "first follow-up answer"),
        textStream("third", "second follow-up answer"),
      ],
    });
    const agent = new AiSdkPiAgent({ system: "test", model });
    const firstId = agent.followUp("first follow-up");
    const secondId = agent.followUp("second follow-up");

    expect(agent.getQueuedFollowUpIds()).toEqual([firstId, secondId]);
    await agent.prompt("start");

    expect(agent.getQueuedFollowUpIds()).toEqual([]);
  });

  it("hands canonical input IDs off once the checkpoint handler accepts them", async () => {
    const checkpointAttempts: string[][] = [];
    const model = new MockLanguageModelV4({
      doStream: [textStream("first", "initial answer"), textStream("second", "redirected")],
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      recoveryCheckpointHandler: (_messages, canonicalInputIds) => {
        if (canonicalInputIds.length === 0) return;
        checkpointAttempts.push([...canonicalInputIds]);
      },
    });
    const followUpId = agent.followUp("queued follow-up");
    const steeringId = agent.steer("change direction");

    await agent.prompt("start");

    expect(checkpointAttempts).toEqual([[followUpId, steeringId]]);
  });

  it("checkpoints only the replay-safe tool prefix after idle recovery normalization", async () => {
    const checkpointEntered = deferred();
    const releaseCheckpoint = deferred();
    let normalizedCheckpoint: readonly ModelMessage[] | undefined;
    let recovery: Promise<IdleRecoveryResult> | undefined;
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "completed", toolName: "fast", input: "{}" },
              { type: "tool-call", toolCallId: "incomplete", toolName: "slow", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        textStream("recovered", "continued safely"),
      ],
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        fast: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "fast result",
        }),
        slow: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: (_input, { abortSignal }) =>
            new Promise<string>((_resolve, reject) => {
              const abort = () => reject(new DOMException("recovery", "AbortError"));
              if (abortSignal?.aborted) abort();
              else abortSignal?.addEventListener("abort", abort, { once: true });
            }),
        }),
      },
      recoveryCheckpointHandler: async (messages) => {
        if (!JSON.stringify(messages).includes("fast result")) return;
        normalizedCheckpoint = messages;
        checkpointEntered.resolve();
        await releaseCheckpoint.promise;
      },
    });
    agent.subscribe((event) => {
      if (event.type !== "tool_execution_end" || event.toolCallId !== "completed") return;
      recovery = agent.requestIdleRecovery(new Error("idle"), () => "retry");
    });

    const run = agent.prompt("run tools");
    await checkpointEntered.promise;

    expect(model.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(normalizedCheckpoint)).toContain("completed");
    expect(JSON.stringify(normalizedCheckpoint)).toContain("fast result");
    expect(JSON.stringify(normalizedCheckpoint)).not.toContain("incomplete");

    releaseCheckpoint.resolve();
    await run;
    await expect(recovery).resolves.toEqual({ status: "retried" });

    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("does not write checkpoints for streaming deltas alone", async () => {
    let checkpointCalls = 0;
    const checkpointCountsAtDeltas: number[] = [];
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: "first" },
            { type: "text-delta", id: "answer", delta: " second" },
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
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      recoveryCheckpointHandler: () => {
        checkpointCalls += 1;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        checkpointCountsAtDeltas.push(checkpointCalls);
      }
    });

    await agent.prompt("stream answer");

    expect(checkpointCountsAtDeltas).toEqual([1, 1]);
    expect(checkpointCalls).toBe(3);
  });
});

describe("AiSdkPiAgent streamText retries", () => {
  it("preserves AI SDK retries when no stream retry limit is supplied", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) throw retryableApiCallError();
        return textStream("answer", "recovered");
      },
    });
    const agent = new AiSdkPiAgent({ system: "test", model });

    await agent.prompt("retry internally");

    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("lets a replacement runtime disable AI SDK retries for only that call", async () => {
    const originalModel = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("original runtime must not be invoked");
      },
    });
    const replacementModel = new MockLanguageModelV4({
      doStream: async () => {
        throw retryableApiCallError();
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: originalModel,
      streamTextMaxRetries: 1,
      prepareModelCall: ({ payload }) => ({
        runtime: {
          model: replacementModel,
          executionMode: "provider-tools",
          streamTextMaxRetries: 0,
        },
        payload,
      }),
    });

    await expect(agent.prompt("do not retry internally")).rejects.toBeInstanceOf(APICallError);

    expect(originalModel.doStreamCalls).toHaveLength(0);
    expect(replacementModel.doStreamCalls).toHaveLength(1);
  });

  it("lets an omitted replacement runtime retry limit inherit the constructor default", async () => {
    let calls = 0;
    const originalModel = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("original runtime must not be invoked");
      },
    });
    const replacementModel = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) throw retryableApiCallError();
        return textStream("answer", "recovered");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model: originalModel,
      streamTextMaxRetries: 1,
      prepareModelCall: ({ payload }) => ({
        runtime: {
          model: replacementModel,
          executionMode: "provider-tools",
        },
        payload,
      }),
    });

    await agent.prompt("inherit retry default");

    expect(originalModel.doStreamCalls).toHaveLength(0);
    expect(replacementModel.doStreamCalls).toHaveLength(2);
  });

  it("lets the agent handler control the exact call count when SDK retries are disabled", async () => {
    let calls = 0;
    let retries = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls <= 2) throw retryableApiCallError();
        return textStream("answer", "recovered");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      streamTextMaxRetries: 0,
      turnErrorHandler: () => {
        retries += 1;
        return "retry";
      },
    });

    await agent.prompt("retry through the agent");

    expect(retries).toBe(2);
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it("keeps provider-tool retry unsafe across outer calls of one persistent attempt", async () => {
    const laterFailure = new Error("later same-attempt failure");
    const retrySafety: boolean[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          await agent.executeExternalToolCall({
            toolCallId: "persistent-tool",
            toolName: "external_tool",
            input: {},
          });
          return textStream("first", "first response");
        }
        return {
          stream: simulateReadableStream({ chunks: [{ type: "error", error: laterFailure }] }),
        };
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        external_tool: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "completed",
        }),
      },
      prepareModelCall: ({ payload }) => ({
        runtime: {
          model,
          executionMode: "provider-tools",
          persistentAttemptIdentity: "candidate-a",
          streamTextMaxRetries: 0,
        },
        payload,
      }),
      turnBoundaryHandler: () =>
        calls === 1 ? { append: [{ role: "user", content: "continue" }] } : {},
      turnErrorHandler: (_error, context) => {
        retrySafety.push(context.retrySafety.canRetry);
        return "retry";
      },
    });

    await expect(agent.prompt("start")).rejects.toBe(laterFailure);
    expect(retrySafety).toEqual([false]);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("resets provider-tool retry safety after installing a distinct persistent attempt", async () => {
    const nextAttemptFailure = new Error("new-attempt failure");
    const retrySafety: boolean[] = [];
    let attemptIdentity = "candidate-a";
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          await agent.executeExternalToolCall({
            toolCallId: "first-attempt-tool",
            toolName: "external_tool",
            input: {},
          });
          return textStream("first", "first response");
        }
        return {
          stream: simulateReadableStream({
            chunks: [{ type: "error", error: nextAttemptFailure }],
          }),
        };
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        external_tool: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "completed",
        }),
      },
      prepareModelCall: ({ payload }) => ({
        runtime: {
          model,
          executionMode: "provider-tools",
          persistentAttemptIdentity: attemptIdentity,
          streamTextMaxRetries: 0,
        },
        payload,
      }),
      turnErrorHandler: (_error, context) => {
        retrySafety.push(context.retrySafety.canRetry);
        return "fail";
      },
    });

    await agent.prompt("first attempt");
    attemptIdentity = "candidate-b";
    await expect(agent.prompt("second attempt")).rejects.toBe(nextAttemptFailure);
    expect(retrySafety).toEqual([true]);
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

  it("classifies failures after response tool normalization as post-model", async () => {
    const localError = Object.assign(new Error("socket connection closed unexpectedly"), {
      code: "ECONNRESET",
    });
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "provider-call",
              toolName: "provider_tool",
              input: "{}",
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: zeroUsage(),
            },
          ],
        }),
      }),
    });
    const phases: Array<string | undefined> = [];
    const retryReasons: string[] = [];
    let normalizations = 0;
    let switchAttempts = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        provider_tool: tool({
          inputSchema: jsonSchema(
            { type: "object", additionalProperties: false },
            { validate: () => ({ success: false, error: new Error("provider validation") }) },
          ),
        }),
      },
      normalizeToolResultOutput: (output) => {
        normalizations += 1;
        return output;
      },
      turnErrorHandler: (_error, context) => {
        phases.push(context.phase);
        if (!context.retrySafety.canRetry) retryReasons.push(context.retrySafety.reason);
        if (context.phase === "model-call" && switchAttempts === 0) {
          switchAttempts += 1;
          return "retry";
        }
        return "fail";
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "tool") throw localError;
    });

    await expect(agent.prompt("use provider tool")).rejects.toBe(localError);

    expect(normalizations).toBe(1);
    expect(phases).toEqual(["post-model"]);
    expect(retryReasons).toEqual(["post-model-phase"]);
    expect(switchAttempts).toBe(0);
    expect(model.doStreamCalls).toHaveLength(1);
  });
});

describe("AiSdkPiAgent queued steering and cancellation", () => {
  it("awaits ordinary steering preparation before queue removal or the next provider call", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        textStream("first", "initial answer"),
        textStream("second", "first steer"),
        textStream("third", "second steer"),
      ],
    });
    const hookEntered = deferred();
    const releaseHook = deferred();
    const preparedIds: string[][] = [];
    const steeringMessageStarts: ModelMessage[] = [];
    let hookCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: async ({ deliveryKind, batch }) => {
        expect(deliveryKind).toBe("queued");
        preparedIds.push(batch.map(({ id }) => id));
        hookCalls += 1;
        if (hookCalls === 1) {
          hookEntered.resolve();
          await releaseHook.promise;
        }
      },
    });
    agent.subscribe((event) => {
      if (
        event.type === "message_start" &&
        event.message.role === "user" &&
        event.message.content !== "start"
      ) {
        steeringMessageStarts.push(event.message);
      }
    });
    const firstId = agent.steer("first steering");
    const secondId = agent.steer("second steering");

    const run = agent.prompt("start");
    await hookEntered.promise;

    expect(agent.getQueuedSteeringIds()).toEqual([firstId, secondId]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(steeringMessageStarts).toEqual([]);

    releaseHook.resolve();
    await run;

    expect(preparedIds).toEqual([[firstId], [secondId]]);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
  });

  it("retains steering and emits no steering user message when preparation rejects", async () => {
    const model = new MockLanguageModelV4({
      doStream: textStream("first", "initial answer"),
    });
    const preparationError = new Error("history capture failed");
    const userMessageStarts: ModelMessage[] = [];
    const failures: Array<{
      deliveryKind: string;
      steeringIds: string[];
      error: string;
    }> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: () => {
        throw preparationError;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "user") {
        userMessageStarts.push(event.message);
      }
      if (event.type === "steering_delivery_failed") {
        failures.push({
          deliveryKind: event.deliveryKind,
          steeringIds: event.steeringIds,
          error: event.error,
        });
      }
    });
    const steeringId = agent.steer("do not deliver");

    await agent.prompt("start");

    expect(agent.getQueuedSteeringIds()).toEqual([steeringId]);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(agent.state.error).toBeUndefined();
    expect(failures).toEqual([
      {
        deliveryKind: "queued",
        steeringIds: [steeringId],
        error: preparationError.message,
      },
    ]);
    expect(userMessageStarts).toEqual([{ role: "user", content: "start" }]);
    expect(
      agent.state.messages.some(
        (message) => message.role === "user" && message.content === "do not deliver",
      ),
    ).toBe(false);
  });

  it("exposes all-mode steering batches in FIFO order and preserves follow-up ordering", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        textStream("first", "initial answer"),
        textStream("second", "steered answer"),
        textStream("third", "late steered answer"),
      ],
    });
    const firstHookEntered = deferred();
    const releaseFirstHook = deferred();
    const deliveries: Array<{
      batch: readonly { readonly id: string; readonly message: ModelMessage }[];
      canonicalMessages: readonly ModelMessage[];
    }> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: async ({ batch, canonicalMessages }) => {
        expect(Object.isFrozen(batch)).toBe(true);
        expect(batch.every((entry) => Object.isFrozen(entry))).toBe(true);
        expect(Object.isFrozen(canonicalMessages)).toBe(true);
        deliveries.push({ batch, canonicalMessages });
        if (deliveries.length === 1) {
          firstHookEntered.resolve();
          await releaseFirstHook.promise;
        }
      },
    });
    agent.setSteeringMode("all");
    agent.followUp("queued follow-up");
    const firstId = agent.steer("first steering");
    const secondId = agent.steer("second steering");

    const run = agent.prompt("start");
    await firstHookEntered.promise;

    agent.followUp("late follow-up");
    const lateId = agent.steer("late steering");
    expect(agent.getQueuedSteeringIds()).toEqual([firstId, secondId, lateId]);

    releaseFirstHook.resolve();
    await run;

    expect(deliveries).toEqual([
      {
        batch: [
          { id: firstId, message: { role: "user", content: "first steering" } },
          { id: secondId, message: { role: "user", content: "second steering" } },
        ],
        canonicalMessages: [
          {
            role: "user",
            content: "queued follow-up\n\nfirst steering",
          },
          { role: "user", content: "second steering" },
        ],
      },
      {
        batch: [{ id: lateId, message: { role: "user", content: "late steering" } }],
        canonicalMessages: [{ role: "user", content: "late follow-up\n\nlate steering" }],
      },
    ]);
    expect(deliveries[0]?.canonicalMessages.slice(0, 1)).toEqual([
      { role: "user", content: "queued follow-up\n\nfirst steering" },
    ]);
    expect(deliveries[0]?.canonicalMessages.slice(0, 2)).toEqual([
      { role: "user", content: "queued follow-up\n\nfirst steering" },
      { role: "user", content: "second steering" },
    ]);
    const firstCanonicalContent = "queued follow-up\n\nfirst steering";
    const firstCanonicalIndex = agent.state.messages.findIndex(
      (message) => message.role === "user" && message.content === firstCanonicalContent,
    );
    expect(agent.state.messages.slice(firstCanonicalIndex, firstCanonicalIndex + 2)).toEqual([
      { role: "user", content: firstCanonicalContent },
      { role: "user", content: "second steering" },
    ]);
    const providerPrefix = model.doStreamCalls[1]?.prompt.slice(-2);
    expect(providerPrefix?.map((message) => message.role)).toEqual(["user", "user"]);
    expect(providerPrefix?.[0]?.content).toEqual([{ type: "text", text: firstCanonicalContent }]);
    expect(providerPrefix?.[1]?.content).toEqual([{ type: "text", text: "second steering" }]);
    expect(
      agent.state.messages.some(
        (message) =>
          message.role === "user" && message.content === "late follow-up\n\nlate steering",
      ),
    ).toBe(true);
    expect(model.doStreamCalls).toHaveLength(3);
  });

  it("prepares steering only after local tool execution settles", async () => {
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
        textStream("second", "steered answer"),
      ],
    });
    const toolEntered = deferred();
    const releaseTool = deferred();
    const hookEntered = deferred();
    const order: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async () => {
            toolEntered.resolve();
            await releaseTool.promise;
            order.push("tool-returned");
            return "result";
          },
        }),
      },
      beforeSteeringDelivery: () => {
        order.push("hook");
        hookEntered.resolve();
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") order.push("tool-execution-end");
    });
    agent.steer("after tools");

    const run = agent.prompt("start");
    await toolEntered.promise;

    expect(order).toEqual([]);
    expect(model.doStreamCalls).toHaveLength(1);

    releaseTool.resolve();
    await hookEntered.promise;
    await run;

    expect(order).toEqual(["tool-returned", "tool-execution-end", "hook"]);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("does not prepare a successful steering batch again when the loop retries", async () => {
    const retryError = new Error("retry second provider call");
    const model = new MockLanguageModelV4({
      doStream: [
        textStream("first", "initial answer"),
        {
          stream: simulateReadableStream({
            chunks: [{ type: "error", error: retryError }],
          }),
        },
        textStream("retry", "steered answer"),
      ],
    });
    const preparedIds: string[][] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: ({ batch }) => {
        preparedIds.push(batch.map(({ id }) => id));
      },
      turnErrorHandler: (_error, { retrySafety }) => (retrySafety.canRetry ? "retry" : "fail"),
    });
    const steeringId = agent.steer("prepare once");

    await agent.prompt("start");

    expect(preparedIds).toEqual([[steeringId]]);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls[2]?.prompt).toEqual(model.doStreamCalls[1]?.prompt);
  });

  it("retries failed queued preparation only after a naturally required tool continuation", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "lookup-retry",
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
        textStream("continued", "tool continuation"),
        textStream("steered", "steered response"),
      ],
    });
    let hookCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "result",
        }),
      },
      beforeSteeringDelivery: () => {
        hookCalls += 1;
        if (hookCalls === 1) throw new Error("first preparation failed");
      },
    });
    agent.steer("retry later");

    await agent.prompt("start");

    expect(hookCalls).toBe(2);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("retry later");
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain("retry later");
  });

  it("rejects native acknowledgement while a durable delivery is being prepared", async () => {
    const model = new MockLanguageModelV4({
      doStream: [textStream("first", "initial answer"), textStream("second", "steered")],
    });
    const hookEntered = deferred();
    const releaseHook = deferred();
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: async () => {
        hookEntered.resolve();
        await releaseHook.promise;
      },
    });
    const steeringId = agent.steer("exactly once");

    const run = agent.prompt("start");
    await hookEntered.promise;

    expect(() => agent.acknowledgeSteeringDelivery(steeringId)).toThrow(
      "while its delivery is being prepared",
    );
    expect(agent.getQueuedSteeringIds()).toEqual([steeringId]);

    releaseHook.resolve();
    await run;

    expect(
      agent.state.messages.filter(
        (message) => message.role === "user" && message.content === "exactly once",
      ),
    ).toHaveLength(1);
  });

  it("cooperatively aborts a blocked hook when cancellation happens before commit", async () => {
    const model = new MockLanguageModelV4({
      doStream: textStream("first", "initial answer"),
    });
    const hookEntered = deferred();
    const failures: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: async ({ abortSignal }) => {
        hookEntered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const rejectForAbort = () => reject(new Error("preparation aborted"));
          if (abortSignal?.aborted) {
            rejectForAbort();
            return;
          }
          abortSignal?.addEventListener("abort", rejectForAbort, { once: true });
        });
      },
    });
    agent.subscribe((event) => {
      if (event.type === "steering_delivery_failed") failures.push(event.error);
    });
    agent.steer("cancel before commit");

    const run = agent.prompt("start");
    await hookEntered.promise;
    agent.cancel();
    await run;

    expect(failures).toEqual(["preparation aborted"]);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
    expect(
      agent.state.messages.some(
        (message) => message.role === "user" && message.content === "cancel before commit",
      ),
    ).toBe(false);
    expect(agent.state.error).toBeUndefined();
  });

  it("retains canonical steering when cancellation happens before a successful hook resolves", async () => {
    const model = new MockLanguageModelV4({
      doStream: textStream("first", "initial answer"),
    });
    const hookEntered = deferred();
    const releaseHook = deferred();
    let hookSignal: AbortSignal | undefined;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: async ({ abortSignal }) => {
        hookSignal = abortSignal;
        hookEntered.resolve();
        await releaseHook.promise;
      },
    });
    agent.steer("committed before cancellation");

    const run = agent.prompt("start");
    await hookEntered.promise;
    agent.cancel();
    expect(hookSignal?.aborted).toBe(true);
    releaseHook.resolve();
    await run;

    expect(agent.getQueuedSteeringIds()).toEqual([]);
    expect(
      agent.state.messages.some(
        (message) => message.role === "user" && message.content === "committed before cancellation",
      ),
    ).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("deeply isolates queued messages from caller and hook mutations", async () => {
    const model = new MockLanguageModelV4({
      doStream: [textStream("first", "initial answer"), textStream("second", "steered")],
    });
    const steeringMessage = {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "original nested text",
          providerOptions: { test: { label: "original" } },
        },
      ],
    };
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: ({ batch, canonicalMessages }) => {
        const batchMessage = batch[0]?.message;
        if (batchMessage?.role === "user" && Array.isArray(batchMessage.content)) {
          const textPart = batchMessage.content[0];
          if (textPart?.type === "text") textPart.text = "hook-mutated batch";
        }
        const canonicalMessage = canonicalMessages[0];
        if (canonicalMessage?.role === "user" && Array.isArray(canonicalMessage.content)) {
          const textPart = canonicalMessage.content[0];
          if (textPart?.type === "text") textPart.text = "hook-mutated canonical";
        }
      },
    });
    agent.steer(steeringMessage);
    const callerPart = steeringMessage.content[0];
    if (!callerPart) throw new Error("expected caller text part");
    callerPart.text = "caller-mutated text";
    callerPart.providerOptions.test.label = "caller-mutated provider options";

    await agent.prompt("start");

    const delivered = agent.state.messages.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    expect(delivered).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "original nested text",
          providerOptions: { test: { label: "original" } },
        },
      ],
    });
  });

  it("clones AI SDK URL file data without retaining caller or hook aliases", async () => {
    const model = new MockLanguageModelV4({
      doStream: [textStream("first", "initial answer"), textStream("second", "steered")],
    });
    const originalUrl = new URL("data:text/plain;base64,b3JpZ2luYWw=");
    const steeringMessage: ModelMessage = {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "text/plain",
          filename: "direction.txt",
          data: { type: "url", url: originalUrl },
        },
      ],
    };
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      beforeSteeringDelivery: ({ batch, canonicalMessages }) => {
        for (const message of [batch[0]?.message, canonicalMessages[0]]) {
          if (message?.role !== "user" || !Array.isArray(message.content)) continue;
          const part = message.content[0];
          if (
            part?.type === "file" &&
            typeof part.data === "object" &&
            part.data !== null &&
            "type" in part.data &&
            part.data.type === "url"
          ) {
            expect(part.data.url).toBeInstanceOf(URL);
            part.data.url.hash = "hook-mutated";
          }
        }
      },
    });
    agent.steer(steeringMessage);
    originalUrl.hash = "caller-mutated";

    await agent.prompt("start");

    const delivered = agent.state.messages.find(
      (message) =>
        message.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "file"),
    );
    if (delivered?.role !== "user" || !Array.isArray(delivered.content)) {
      throw new Error("expected delivered file message");
    }
    const deliveredPart = delivered.content[0];
    if (
      deliveredPart?.type !== "file" ||
      typeof deliveredPart.data !== "object" ||
      deliveredPart.data === null ||
      !("type" in deliveredPart.data) ||
      deliveredPart.data.type !== "url"
    ) {
      throw new Error("expected delivered URL file part");
    }
    expect(deliveredPart.data.url).toBeInstanceOf(URL);
    expect(deliveredPart.data.url.href).toBe("data:text/plain;base64,b3JpZ2luYWw=");
  });

  it("fails clearly when a steering message is not safely cloneable", () => {
    const agent = new AiSdkPiAgent({ system: "test", model: fakeModel() });
    const unsupportedMessage = {
      role: "user" as const,
      content: "unsupported",
      callback: () => {},
    };

    expect(() => agent.steer(unsupportedMessage)).toThrow(
      "steering message: messages must be safely cloneable",
    );
    expect(agent.getQueuedSteeringIds()).toEqual([]);
  });

  it("prepares an awaited interrupt after local-tool settlement and delivers exactly once", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "interrupt-tool",
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
        textStream("interrupted", "after interrupt"),
      ],
    });
    const toolEntered = deferred();
    const releaseTool = deferred();
    const hookEntered = deferred();
    const order: string[] = [];
    const interruptContexts: Array<{
      ids: string[];
      canonicalMessages: readonly ModelMessage[];
    }> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async () => {
            toolEntered.resolve();
            await releaseTool.promise;
            order.push("tool-returned");
            return "result";
          },
        }),
      },
      beforeSteeringDelivery: ({ deliveryKind, batch, canonicalMessages, abortSignal }) => {
        if (deliveryKind !== "interrupt") return;
        expect(abortSignal?.aborted).toBe(false);
        order.push("hook");
        interruptContexts.push({
          ids: batch.map((entry) => entry.id),
          canonicalMessages,
        });
        hookEntered.resolve();
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") order.push("tool-execution-end");
    });

    const run = agent.prompt("start");
    await toolEntered.promise;
    agent.followUp("interrupt follow-up");
    const firstId = agent.steer("first interrupt steering");
    const secondId = agent.steer("second interrupt steering");

    const interrupt = agent.interruptQueuedSteeringAsync();
    expect(order).toEqual([]);
    expect(agent.getQueuedSteeringIds()).toEqual([firstId, secondId]);

    releaseTool.resolve();
    await hookEntered.promise;
    await expect(interrupt).resolves.toEqual({
      status: "interrupted",
      steeringIds: [firstId, secondId],
    });
    await run;

    expect(order).toEqual(["tool-returned", "tool-execution-end", "hook"]);
    expect(interruptContexts).toEqual([
      {
        ids: [firstId, secondId],
        canonicalMessages: [
          {
            role: "user",
            content: "interrupt follow-up\n\nfirst interrupt steering",
          },
          { role: "user", content: "second interrupt steering" },
        ],
      },
    ]);
    expect(interruptContexts[0]?.canonicalMessages.slice(0, 1)).toEqual([
      { role: "user", content: "interrupt follow-up\n\nfirst interrupt steering" },
    ]);
    expect(interruptContexts[0]?.canonicalMessages.slice(0, 2)).toEqual([
      { role: "user", content: "interrupt follow-up\n\nfirst interrupt steering" },
      { role: "user", content: "second interrupt steering" },
    ]);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
    const interruptPrefixStart = agent.state.messages.findIndex(
      (message) =>
        message.role === "user" &&
        message.content === "interrupt follow-up\n\nfirst interrupt steering",
    );
    expect(agent.state.messages.slice(interruptPrefixStart, interruptPrefixStart + 2)).toEqual([
      { role: "user", content: "interrupt follow-up\n\nfirst interrupt steering" },
      { role: "user", content: "second interrupt steering" },
    ]);
    const providerPrefix = model.doStreamCalls[1]?.prompt.slice(-2);
    expect(providerPrefix?.map((message) => message.role)).toEqual(["user", "user"]);
    expect(providerPrefix?.[0]?.content).toEqual([
      { type: "text", text: "interrupt follow-up\n\nfirst interrupt steering" },
    ]);
    expect(providerPrefix?.[1]?.content).toEqual([
      { type: "text", text: "second interrupt steering" },
    ]);
  });

  it("resumes without steering after stable-boundary interrupt preparation rejects", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "rejected-interrupt-tool",
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
    const toolEntered = deferred();
    const releaseTool = deferred();
    const resumedTransformEntered = deferred();
    const releaseResumedTransform = deferred();
    const resumedInputs: ModelMessage[][] = [];
    const failures: string[] = [];
    let transformCalls = 0;
    let interruptHookCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async () => {
            toolEntered.resolve();
            await releaseTool.promise;
            return "result";
          },
        }),
      },
      canonicalModelCallPreflight: async (messages) => {
        transformCalls += 1;
        if (transformCalls === 2) {
          resumedInputs.push([...messages]);
          resumedTransformEntered.resolve();
          await releaseResumedTransform.promise;
        }
      },
      beforeSteeringDelivery: ({ deliveryKind }) => {
        if (deliveryKind !== "interrupt") return;
        interruptHookCalls += 1;
        throw new Error("interrupt preparation failed");
      },
    });
    agent.subscribe((event) => {
      if (event.type === "steering_delivery_failed") failures.push(event.error);
    });

    const run = agent.prompt("start");
    await toolEntered.promise;
    agent.followUp("retained follow-up");
    const steeringId = agent.steer("retained steering");
    const interrupt = agent.interruptQueuedSteeringAsync();
    expect(interruptHookCalls).toBe(0);

    releaseTool.resolve();
    await expect(interrupt).resolves.toEqual({
      status: "failed",
      steeringIds: [steeringId],
      error: "interrupt preparation failed",
    });
    await resumedTransformEntered.promise;

    expect(interruptHookCalls).toBe(1);
    expect(agent.getQueuedSteeringIds()).toEqual([steeringId]);
    expect(failures).toEqual(["interrupt preparation failed"]);
    expect(JSON.stringify(resumedInputs[0])).not.toContain("retained steering");
    expect(JSON.stringify(resumedInputs[0])).not.toContain("retained follow-up");

    agent.abort();
    releaseResumedTransform.resolve();
    await run;
    expect(agent.getQueuedSteeringIds()).toEqual([steeringId]);
  });

  it("settles an awaited interrupt when cancellation wins during local-tool settlement", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "cancelled-interrupt-tool",
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
    const toolEntered = deferred();
    const releaseTool = deferred();
    let hookCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async () => {
            toolEntered.resolve();
            await releaseTool.promise;
            return "result";
          },
        }),
      },
      beforeSteeringDelivery: () => {
        hookCalls += 1;
      },
    });

    const run = agent.prompt("start");
    await toolEntered.promise;
    agent.steer("cancelled interrupt");
    const interrupt = agent.interruptQueuedSteeringAsync();
    agent.cancel();
    releaseTool.resolve();

    await expect(interrupt).resolves.toEqual({ status: "inactive" });
    await run;
    expect(hookCalls).toBe(0);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
  });

  it("settles an awaited interrupt when manual abort wins before the stable boundary", async () => {
    const transformEntered = deferred();
    const releaseTransform = deferred();
    let hookCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      prepareFullModelView: async (messages) => {
        transformEntered.resolve();
        await releaseTransform.promise;
        return [...messages];
      },
      beforeSteeringDelivery: () => {
        hookCalls += 1;
      },
    });

    const run = agent.prompt("start");
    await transformEntered.promise;
    const steeringId = agent.steer("retained after manual abort");
    const interrupt = agent.interruptQueuedSteeringAsync();
    agent.abort();

    await expect(interrupt).resolves.toEqual({ status: "inactive" });
    releaseTransform.resolve();
    await run;

    expect(hookCalls).toBe(0);
    expect(agent.getQueuedSteeringIds()).toEqual([steeringId]);
  });

  it("records provider-delivered steering once without replaying it at a boundary", async () => {
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
    let steeringId = "";
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      canonicalModelCallPreflight: () => {
        expect(agent.acknowledgeSteeringDelivery(steeringId)).toBe(true);
      },
    });
    steeringId = agent.steer("change direction");

    await agent.prompt("start");

    expect(model.doStreamCalls).toHaveLength(1);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      { role: "user", content: "change direction" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
  });

  it("keeps delivered steering but drops queued steering when a run is cancelled", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "text-1" },
              { type: "text-delta" as const, id: "text-1", delta: "done" },
              { type: "text-end" as const, id: "text-1" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        };
      },
    });
    const agent = new AiSdkPiAgent({ system: "test", model });
    agent.setSteeringMode("all");
    const running = agent.prompt("start");
    while (!agent.state.isStreaming) await Promise.resolve();

    const delivered = agent.steer("use typescript");
    agent.steer("never sent");
    // Only the first message reached the model, so only it belongs in the
    // transcript once the run is cancelled.
    expect(agent.acknowledgeSteeringDelivery(delivered)).toBe(true);
    agent.cancel();
    release?.();
    await running;

    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      { role: "user", content: "use typescript" },
    ]);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
  });

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
      canonicalModelCallPreflight: async (messages) => {
        modelInputs.push(messages);
        transformCount += 1;
        if (transformCount === 1) {
          firstTransformEntered.resolve();
          await releaseFirstTransform.promise;
        }
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
      canonicalModelCallPreflight: async (messages) => {
        modelInputs.push(messages);
        transformCount += 1;
        if (transformCount === 1) {
          firstTransformEntered.resolve();
          await releaseFirstTransform.promise;
        }
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
      canonicalModelCallPreflight: (messages) => {
        modelInputs.push(messages);
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

  it("prepares full budget context before selecting and independently preparing a replacement-runtime suffix", async () => {
    const order: string[] = [];
    const originalModel = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("original runtime must not be invoked");
      },
    });
    const replacementModel = new MockLanguageModelV4({
      doStream: async () => {
        order.push("model");
        return textStream("replacement", "replacement response");
      },
    });
    let overlayRevision = 0;
    const budgetInputs: Array<{ messages: ModelMessage[]; canonicalStartIndex?: number }> = [];
    const payloadInputs: ModelMessage[][] = [];
    const canonicalBefore: ModelMessage[] = [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old response" },
    ];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: originalModel,
      modelSpecifier: "test/original",
      messages: canonicalBefore,
      prepareFullBudgetView: (messages, context) => {
        budgetInputs.push({
          messages: [...messages],
          canonicalStartIndex: context.canonicalStartIndex,
        });
        order.push("prepare-budget");
        return messages.map((message) =>
          message.role === "user" && typeof message.content === "string"
            ? { ...message, content: `${message.content} [budget]` }
            : message,
        );
      },
      prepareFullModelView: (messages) => {
        payloadInputs.push([...messages]);
        order.push("prepare-suffix");
        return messages.map((message) =>
          message.role === "user" && typeof message.content === "string"
            ? { ...message, content: `${message.content} [prepared]` }
            : message,
        );
      },
      buildEphemeralOverlay: () => {
        overlayRevision += 1;
        order.push(`overlay-${overlayRevision}`);
        return [{ role: "user", content: `overlay-${overlayRevision}` }];
      },
      prepareModelCall: ({ canonicalMessages, fullBudgetView }) => {
        order.push("seam");
        expect(canonicalMessages).toEqual([...canonicalBefore, { role: "user", content: "new" }]);
        expect(JSON.stringify(fullBudgetView)).toContain("old request [budget]");
        expect(JSON.stringify(fullBudgetView)).toContain("overlay-1");
        return {
          runtime: {
            model: replacementModel,
            modelSpecifier: "test/replacement",
            executionMode: "provider-tools",
          },
          payload: { mode: "suffix", startIndex: 2 },
        };
      },
      decorateRequestPayload: (payload) => {
        order.push("decorate");
        const last = payload.at(-1);
        if (last?.role !== "user") throw new Error("expected overlay user message");
        return [
          ...payload.slice(0, -1),
          { ...last, providerOptions: { test: { decorated: true } } },
        ];
      },
    });

    await agent.prompt("new");

    expect(order).toEqual([
      "prepare-budget",
      "overlay-1",
      "seam",
      "prepare-suffix",
      "overlay-2",
      "decorate",
      "model",
    ]);
    expect(budgetInputs).toEqual([
      {
        messages: [...canonicalBefore, { role: "user", content: "new" }],
        canonicalStartIndex: 0,
      },
    ]);
    expect(payloadInputs).toEqual([[{ role: "user", content: "new" }]]);
    expect(originalModel.doStreamCalls).toHaveLength(0);
    expect(replacementModel.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(replacementModel.doStreamCalls[0]?.prompt)).not.toContain("old request");
    expect(JSON.stringify(replacementModel.doStreamCalls[0]?.prompt)).toContain("overlay-2");
    expect(replacementModel.doStreamCalls[0]?.prompt.at(-1)?.providerOptions).toEqual({
      test: { decorated: true },
    });
    expect(JSON.stringify(agent.state.messages)).not.toContain("overlay-");
    expect(JSON.stringify(agent.state.messages)).not.toContain("decorated");
  });

  it("re-enters model-call preparation from unchanged canonical history on a safe Agent retry", async () => {
    const firstError = retryableApiCallError();
    const firstModel = new MockLanguageModelV4({
      doStream: async () => {
        throw firstError;
      },
    });
    const replacementModel = new MockLanguageModelV4({
      doStream: async () => textStream("replacement", "replacement response"),
    });
    const canonicalBefore: ModelMessage[] = [
      { role: "user", content: "old request" },
      { role: "assistant", content: "old response" },
    ];
    const preparedCanonicalHistory: ModelMessage[][] = [];
    const fullBudgetViews: ModelMessage[][] = [];
    let preparations = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: firstModel,
      modelSpecifier: "test/first",
      streamTextMaxRetries: 0,
      messages: canonicalBefore,
      prepareFullModelView: (messages) =>
        messages.map((message) =>
          message.role === "user" && typeof message.content === "string"
            ? { ...message, content: `${message.content} [prepared]` }
            : message,
        ),
      buildEphemeralOverlay: () => [{ role: "user", content: "full-budget-overlay" }],
      prepareModelCall: ({ canonicalMessages, fullBudgetView, runtime, payload }) => {
        preparations += 1;
        preparedCanonicalHistory.push([...canonicalMessages]);
        fullBudgetViews.push([...fullBudgetView]);
        if (preparations === 1) return { runtime, payload };
        return {
          runtime: {
            model: replacementModel,
            modelSpecifier: "test/replacement",
            executionMode: "provider-tools",
          },
          payload: { mode: "suffix", startIndex: 2 },
        };
      },
      turnErrorHandler: (error, context) => {
        expect(error).toBe(firstError);
        expect(context.retrySafety).toEqual({ canRetry: true });
        return "retry";
      },
    });

    await agent.prompt("new request");

    const expectedCanonical: ModelMessage[] = [
      ...canonicalBefore,
      { role: "user", content: "new request" },
    ];
    expect(preparedCanonicalHistory).toEqual([expectedCanonical, expectedCanonical]);
    expect(fullBudgetViews).toHaveLength(2);
    for (const fullBudgetView of fullBudgetViews) {
      expect(JSON.stringify(fullBudgetView)).toContain("old request [prepared]");
      expect(JSON.stringify(fullBudgetView)).toContain("old response");
      expect(JSON.stringify(fullBudgetView)).toContain("new request [prepared]");
      expect(JSON.stringify(fullBudgetView)).toContain("full-budget-overlay");
    }
    expect(firstModel.doStreamCalls).toHaveLength(1);
    expect(replacementModel.doStreamCalls).toHaveLength(1);
    expect(JSON.stringify(replacementModel.doStreamCalls[0]?.prompt)).not.toContain("old request");
    expect(JSON.stringify(replacementModel.doStreamCalls[0]?.prompt)).toContain("new request");
    expect(agent.state.messages).toEqual([
      ...expectedCanonical,
      {
        role: "assistant",
        content: [{ type: "text", text: "replacement response" }],
      },
    ]);
  });

  it("reports whether a turn error came from setup, transformation, or the model call", async () => {
    const phases: Array<string | undefined> = [];
    const handler = (_error: unknown, context: { phase?: string }) => {
      phases.push(context.phase);
      return "fail" as const;
    };
    const beforeStepError = new Error("before step failed");
    const beforeStepAgent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      beforeStep: () => {
        throw beforeStepError;
      },
      turnErrorHandler: handler,
    });
    await expect(beforeStepAgent.prompt("before step")).rejects.toBe(beforeStepError);

    const transformError = new Error("transform failed");
    const transformAgent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      prepareFullModelView: () => {
        throw transformError;
      },
      turnErrorHandler: handler,
    });
    await expect(transformAgent.prompt("transform")).rejects.toBe(transformError);

    const modelError = new Error("model failed");
    const modelAgent = new AiSdkPiAgent({
      system: "test",
      model: new MockLanguageModelV4({
        doStream: {
          stream: simulateReadableStream({ chunks: [{ type: "error", error: modelError }] }),
        },
      }),
      turnErrorHandler: handler,
    });
    await expect(modelAgent.prompt("model")).rejects.toBe(modelError);

    expect(phases).toEqual(["before-step", "transform-messages", "model-call"]);
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
        prepareFullModelView: () => {
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
      prepareFullModelView: () => {
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
      prepareFullModelView: () => {
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
      prepareFullModelView: () => {
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

  it("does not replay when external tool execution precedes provider tool stream activity", async () => {
    const streamError = new Error("Provider failed before reporting external tool activity");
    let executions = 0;
    const retryReasons: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await agent.executeExternalToolCall({
          toolCallId: "external-call",
          toolName: "external_tool",
          input: {},
        });
        return {
          stream: simulateReadableStream({ chunks: [{ type: "error", error: streamError }] }),
        };
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        external_tool: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            executions += 1;
            return "result";
          },
        }),
      },
      turnErrorHandler: async (_error, context) => {
        if (!context.retrySafety.canRetry) retryReasons.push(context.retrySafety.reason);
        return "retry" as const;
      },
    });

    await expect(agent.prompt("run external tool")).rejects.toBe(streamError);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(executions).toBe(1);
    expect(retryReasons).toEqual(["provider-executed-tool"]);
  });

  it("resets the external tool latch for a newly started model attempt", async () => {
    const streamError = new Error("New attempt failed without external tool activity");
    let calls = 0;
    let executions = 0;
    const retrySafety: boolean[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          await agent.executeExternalToolCall({
            toolCallId: "external-call",
            toolName: "external_tool",
            input: {},
          });
          return textStream("first-answer", "first");
        }
        if (calls === 2) {
          return {
            stream: simulateReadableStream({ chunks: [{ type: "error", error: streamError }] }),
          };
        }
        return textStream("second-answer", "second");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        external_tool: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            executions += 1;
            return "result";
          },
        }),
      },
      turnErrorHandler: (_error, context) => {
        retrySafety.push(context.retrySafety.canRetry);
        return context.retrySafety.canRetry ? "retry" : "fail";
      },
    });

    await agent.prompt("first attempt");
    await agent.prompt("second attempt");

    expect(model.doStreamCalls).toHaveLength(3);
    expect(executions).toBe(1);
    expect(retrySafety).toEqual([true]);
  });

  it("clears prior external tool activity before the next attempt prepares", async () => {
    const preparationError = new Error("Next attempt preparation failed");
    let executions = 0;
    let failPreparation = false;
    const retrySafety: boolean[] = [];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (model.doStreamCalls.length === 1) {
          await agent.executeExternalToolCall({
            toolCallId: "external-call",
            toolName: "external_tool",
            input: {},
          });
          return textStream("first-answer", "first");
        }
        return textStream("second-answer", "second");
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        external_tool: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            executions += 1;
            return "result";
          },
        }),
      },
      prepareFullModelView: (messages) => {
        if (failPreparation) {
          failPreparation = false;
          throw preparationError;
        }
        return [...messages];
      },
      turnErrorHandler: (error, context) => {
        if (error === preparationError) retrySafety.push(context.retrySafety.canRetry);
        return context.retrySafety.canRetry ? "retry" : "fail";
      },
    });

    await agent.prompt("first attempt");
    failPreparation = true;
    await agent.prompt("second attempt");

    expect(executions).toBe(1);
    expect(retrySafety).toEqual([true]);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("does not replay after a provider-executed tool result", async () => {
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
    expect(agent.getRecoverableMessages()).toEqual([
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "provider-call",
            toolName: "provider_search",
            input: {},
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "provider-call",
            toolName: "provider_search",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ]);
  });

  it("rewinds cancellation to the last completed streamed content block", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "completed-call",
              toolName: "provider_search",
              input: "{}",
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "completed-call",
              toolName: "provider_search",
              input: {},
              result: "result",
              providerExecuted: true,
            },
            { type: "text-start", id: "completed-text" },
            { type: "text-delta", id: "completed-text", delta: "kept text" },
            { type: "text-end", id: "completed-text" },
            { type: "reasoning-start", id: "discarded-reasoning" },
            { type: "reasoning-delta", id: "discarded-reasoning", delta: "discard me" },
            { type: "reasoning-end", id: "discarded-reasoning" },
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
    let cancelled = false;
    agent.subscribe((event) => {
      if (
        !cancelled &&
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "thinking_delta" &&
        event.assistantMessageEvent.id === "discarded-reasoning"
      ) {
        cancelled = true;
        agent.cancel();
      }
    });

    await agent.prompt("start");

    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "completed-call",
            toolName: "provider_search",
            input: {},
            providerExecuted: true,
          },
          {
            type: "tool-result",
            toolCallId: "completed-call",
            toolName: "provider_search",
            output: { type: "text", value: "result" },
          },
          { type: "text", text: "kept text" },
        ],
      },
    ]);
    expect(JSON.stringify(agent.state.messages)).not.toContain("discard me");
  });

  it("drops open text while retaining completed reasoning", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "reasoning-start", id: "completed-reasoning" },
            { type: "reasoning-delta", id: "completed-reasoning", delta: "kept reasoning" },
            { type: "reasoning-end", id: "completed-reasoning" },
            { type: "text-start", id: "discarded-text" },
            { type: "text-delta", id: "discarded-text", delta: "discard me" },
            { type: "text-end", id: "discarded-text" },
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
    agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta" &&
        event.assistantMessageEvent.id === "discarded-text"
      ) {
        agent.cancel();
      }
    });

    await agent.prompt("start");

    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "reasoning", text: "kept reasoning" }] },
    ]);
  });

  it("drops an unresolved provider tool while retaining the preceding text", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "completed-text" },
            { type: "text-delta", id: "completed-text", delta: "kept text" },
            { type: "text-end", id: "completed-text" },
            {
              type: "tool-call",
              toolCallId: "discarded-call",
              toolName: "provider_search",
              input: "{}",
              providerExecuted: true,
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
    agent.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        Array.isArray(event.message.content) &&
        event.message.content.some(
          (part) => part.type === "tool-call" && part.toolCallId === "discarded-call",
        )
      ) {
        agent.cancel();
      }
    });

    await agent.prompt("start");

    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "text", text: "kept text" }] },
    ]);
  });

  it("drops a cancelled local tool while retaining preceding assistant content", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "completed-text" },
            { type: "text-delta", id: "completed-text", delta: "kept text" },
            { type: "text-end", id: "completed-text" },
            {
              type: "tool-call",
              toolCallId: "discarded-local-call",
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
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "unexpected",
        }),
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolCallId === "discarded-local-call") {
        agent.cancel();
      }
    });

    await agent.prompt("start");

    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "text", text: "kept text" }] },
    ]);
  });

  it("keeps an inline tool pair when a later local tool is cancelled", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call",
              toolCallId: "completed-inline",
              toolName: "provider_search",
              input: "{}",
              providerExecuted: true,
            },
            {
              type: "tool-result",
              toolCallId: "completed-inline",
              toolName: "provider_search",
              input: {},
              result: "inline result",
              providerExecuted: true,
            },
            {
              type: "tool-call",
              toolCallId: "discarded-local",
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
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "unexpected",
        }),
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolCallId === "discarded-local") {
        agent.cancel();
      }
    });

    await agent.prompt("start");

    expect(JSON.stringify(agent.state.messages)).toContain("completed-inline");
    expect(JSON.stringify(agent.state.messages)).toContain("inline result");
    expect(JSON.stringify(agent.state.messages)).not.toContain("discarded-local");
  });

  it("normalizes an inline provider tool result and continues the completed exchange", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: "provider-call",
                toolName: "mcp__lilac__read",
                input: '{"path":"README.md"}',
                providerExecuted: true,
              },
              {
                type: "tool-result",
                toolCallId: "provider-call",
                toolName: "mcp__lilac__read",
                input: { path: "README.md" },
                result: "raw result",
                providerExecuted: true,
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
    const normalized: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      sendToolsToModel: false,
      normalizeToolResultOutput: (_output, context) => {
        normalized.push(context.toolName);
        return { type: "text", value: "normalized result" };
      },
    });

    await agent.prompt("read");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(normalized).toEqual(["mcp__lilac__read"]);
    expect(agent.state.messages).toHaveLength(3);
    expect(model.doStreamCalls[1]?.prompt.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "provider-call", providerExecuted: true },
        {
          type: "tool-result",
          toolCallId: "provider-call",
          output: { type: "text", value: "normalized result" },
        },
      ],
    });
    expect(agent.state.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "provider-call", providerExecuted: true },
        {
          type: "tool-result",
          toolCallId: "provider-call",
          output: { type: "text", value: "normalized result" },
        },
      ],
    });
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
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
    const errorPhases: Array<string | undefined> = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      turnBoundaryHandler: () => {
        throw boundaryError;
      },
      turnErrorHandler: async (_error, context) => {
        errorPhases.push(context.phase);
        if (!context.retrySafety.canRetry) retryReasons.push(context.retrySafety.reason);
        return "retry" as const;
      },
    });

    await expect(agent.prompt("finish")).rejects.toBe(boundaryError);

    expect(model.doStreamCalls).toHaveLength(1);
    expect(retryReasons).toEqual(["post-model-phase"]);
    expect(errorPhases).toEqual(["post-model"]);
    expect(agent.state.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "committed" }],
    });
  });

  it("stops before execution when cancellation is requested by a tool start subscriber", async () => {
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
    let executions = 0;
    let normalizations = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        lookup: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
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

  it("keeps completed siblings when a parallel tool batch is cancelled", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "prefix" },
            { type: "text-delta", id: "prefix", delta: "kept prefix" },
            { type: "text-end", id: "prefix" },
            { type: "tool-call", toolCallId: "completed", toolName: "fast", input: "{}" },
            { type: "tool-call", toolCallId: "discarded", toolName: "slow", input: "{}" },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: zeroUsage(),
            },
          ],
        }),
      },
    });
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        fast: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "fast result",
        }),
        slow: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: (_input, { abortSignal }) =>
            new Promise<string>((_resolve, reject) => {
              const abort = () => reject(new DOMException("cancelled", "AbortError"));
              if (abortSignal?.aborted) abort();
              else abortSignal?.addEventListener("abort", abort, { once: true });
            }),
        }),
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "completed") agent.cancel();
    });

    await agent.prompt("start");

    expect(JSON.stringify(agent.state.messages)).toContain("kept prefix");
    expect(JSON.stringify(agent.state.messages)).toContain("fast result");
    expect(JSON.stringify(agent.state.messages)).not.toContain('"toolCallId":"discarded"');
  });
});

describe("AiSdkPiAgent idle recovery", () => {
  it("rolls back an active model draft before retrying", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "partial" },
              { type: "text-delta", id: "partial", delta: "discarded partial" },
              { type: "text-end", id: "partial" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        textStream("recovered", "recovered answer"),
      ],
    });
    let recovery: Promise<IdleRecoveryResult> | null = null;
    const agent = new AiSdkPiAgent({ system: "test", model });
    agent.subscribe((event) => {
      if (
        recovery === null &&
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_end"
      ) {
        recovery = agent.requestIdleRecovery(new Error("model idle"), () => "retry");
      }
    });

    await agent.prompt("start");

    expect(recovery).not.toBeNull();
    await expect(recovery!).resolves.toEqual({ status: "retried" });
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("discarded partial");
    expect(agent.state.messages).toEqual([
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "text", text: "recovered answer" }] },
    ]);
  });

  it("settles tools, rewinds completed parallel work, and retries in event order", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call", toolCallId: "completed", toolName: "fast", input: "{}" },
              { type: "tool-call", toolCallId: "incomplete", toolName: "slow", input: "{}" },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: "tool-calls" },
                usage: zeroUsage(),
              },
            ],
          }),
        },
        textStream("recovered", "recovered answer"),
      ],
    });
    const idleError = new Error("agent idle timeout");
    const order: string[] = [];
    let recoveryPromise: Promise<IdleRecoveryResult> | null = null;
    let overlappingPromise: Promise<IdleRecoveryResult> | null = null;
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        fast: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => "fast result",
        }),
        slow: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: (_input, { abortSignal }) =>
            new Promise<string>((_resolve, reject) => {
              const abort = () => {
                order.push("slow-settled");
                reject(new DOMException("recovery", "AbortError"));
              };
              if (abortSignal?.aborted) abort();
              else abortSignal?.addEventListener("abort", abort, { once: true });
            }),
        }),
      },
    });
    let turnStarts = 0;
    agent.subscribe((event) => {
      if (event.type === "turn_start") {
        turnStarts += 1;
        order.push(`turn-start-${turnStarts}`);
      }
      if (event.type === "tool_execution_end" && event.toolCallId === "completed") {
        order.push("fast-completed");
        recoveryPromise = agent.requestIdleRecovery(idleError, async (error, context) => {
          expect(error).toBe(idleError);
          expect(context.abortSignal.aborted).toBe(false);
          order.push("decision");
          return "retry" as const;
        });
        overlappingPromise = agent.requestIdleRecovery(idleError, () => "retry");
        void overlappingPromise.catch(() => undefined);
      }
      if (event.type === "turn_abort" && event.reason === "recovery") {
        order.push("turn-abort-recovery");
      }
      if (event.type === "messages_reset" && event.reason === "recovery") {
        order.push("messages-reset-recovery");
      }
    });

    await agent.prompt("run both");

    expect(recoveryPromise).not.toBeNull();
    await expect(recoveryPromise!).resolves.toEqual({ status: "retried" });
    expect(overlappingPromise).not.toBeNull();
    await expect(overlappingPromise!).rejects.toThrow("Idle recovery already pending");
    expect(order).toEqual([
      "turn-start-1",
      "fast-completed",
      "slow-settled",
      "turn-abort-recovery",
      "messages-reset-recovery",
      "decision",
      "turn-start-2",
    ]);
    const replay = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(replay).toContain("completed");
    expect(replay).toContain("fast result");
    expect(replay).not.toContain("incomplete");
    expect(JSON.stringify(agent.state.messages)).not.toContain("incomplete");
  });

  it("rewinds before refusal and fails the run with the original error", async () => {
    const preparationEntered = deferred();
    const releasePreparation = deferred();
    const idleError = new Error("idle watchdog exhausted");
    const events: string[] = [];
    let preparationCalls = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      canonicalModelCallPreflight: async () => {
        preparationCalls += 1;
        if (preparationCalls === 1) {
          preparationEntered.resolve();
          await releasePreparation.promise;
        }
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_abort") events.push(`${event.type}:${event.reason}`);
      if (event.type === "messages_reset") events.push(`${event.type}:${event.reason}`);
      if (event.type === "agent_end") events.push(event.type);
    });

    const run = agent.prompt("refuse recovery");
    void run.catch(() => undefined);
    await preparationEntered.promise;
    const recovery = agent.requestIdleRecovery(idleError, () => "fail");
    releasePreparation.resolve();

    await expect(recovery).resolves.toEqual({ status: "failed" });
    await expect(run).rejects.toBe(idleError);
    expect(events).toEqual(["turn_abort:recovery", "messages_reset:recovery", "agent_end"]);
    expect(agent.state.error).toBe(idleError.message);
    expect(agent.state.messages).toEqual([{ role: "user", content: "refuse recovery" }]);
  });

  it("lets cancellation supersede recovery before the retry decision", async () => {
    const preparationEntered = deferred();
    const releasePreparation = deferred();
    let decisionCalls = 0;
    const events: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      canonicalModelCallPreflight: async () => {
        preparationEntered.resolve();
        await releasePreparation.promise;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_abort") events.push(`${event.type}:${event.reason}`);
      if (event.type === "messages_reset") events.push(`${event.type}:${event.reason}`);
      if (event.type === "agent_end") events.push(event.type);
    });

    const run = agent.prompt("cancel recovery");
    await preparationEntered.promise;
    const recovery = agent.requestIdleRecovery(new Error("idle"), () => {
      decisionCalls += 1;
      return "retry";
    });
    agent.cancel();
    releasePreparation.resolve();

    await run;
    await expect(recovery).resolves.toEqual({ status: "superseded", reason: "cancel" });
    expect(decisionCalls).toBe(0);
    expect(events).toEqual(["turn_abort:cancel", "messages_reset:cancel", "agent_end"]);
    expect(agent.state.error).toBeUndefined();
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
    agent.setGenericOutputNormalizerBypassTools(
      new Set(["history_tool", "boundary_one", "boundary_two"]),
    );
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
    const executedToolNames: string[] = [];
    const firstBoundary: { executed: number; appended: number }[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model,
      tools: {
        read: tool({
          description: "read",
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: async () => {
            // test-wait-justification: keeps one tool active to verify parallel tool completion boundary accounting
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
      if (event.type === "tool_execution_start") executedToolNames.push(event.toolName);
      if (event.type === "message_end" && event.message.role === "tool") {
        appendedToolResults += 1;
      }
    });

    await agent.prompt("start");

    expect(firstBoundary).toEqual([{ executed: 2, appended: 2 }]);
    expect(executedToolNames).toEqual(["read", "glob"]);
  });

  it("executes provider-originated legacy tool names through canonical tools", async () => {
    let executions = 0;
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      tools: {
        patch: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => {
            executions += 1;
            return "patched";
          },
        }),
      },
    });

    const outcome = await agent.executeExternalToolCall({
      toolCallId: "legacy-patch",
      toolName: "apply_patch",
      input: {},
    });

    expect(executions).toBe(1);
    expect(outcome.isError).toBe(false);
    expect(outcome.result).toBe("patched");
  });

  it("does not alias an exact legacy-named tool", async () => {
    const executions: string[] = [];
    const agent = new AiSdkPiAgent({
      system: "test",
      model: fakeModel(),
      tools: {
        read: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => executions.push("read"),
        }),
        read_file: tool({
          inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
          execute: () => executions.push("read_file"),
        }),
      },
    });

    await agent.executeExternalToolCall({
      toolCallId: "exact-legacy-read",
      toolName: "read_file",
      input: {},
    });

    expect(executions).toEqual(["read_file"]);
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
});
