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
