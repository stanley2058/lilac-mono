import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ModelMessage } from "ai";
import { AiSdkPiAgent, type AiSdkPiAgentOptions } from "../ai-sdk-pi-agent";
import { AiSdkAgentAdapter } from "../adapters/ai-sdk/adapter";
import type { AgentAdapter } from "../agent-adapter";
import type { AgentExecutionHost } from "../agent-execution-host";

type FactoryOptions = Omit<AiSdkPiAgentOptions, "adapterFactory">;

function textResponse(text: string): Awaited<ReturnType<MockLanguageModelV4["doStream"]>> {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: text },
        { type: "text-end", id: "text" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
    }),
  };
}

function trackedSdkAdapter(
  settings: FactoryOptions,
  label: string,
  timeline: string[],
): AgentAdapter<AgentExecutionHost> {
  const adapter = new AiSdkAgentAdapter(settings);
  return {
    createExecution(context) {
      const execution = adapter.createExecution(context);
      return {
        ...execution,
        start() {
          timeline.push(`start:${label}`);
          return execution.start();
        },
        async dispose() {
          const result = await execution.dispose();
          timeline.push(`dispose:${label}`);
          return result;
        },
      };
    },
  };
}

function assistantText(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    if (typeof message.content === "string") return [message.content];
    return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
  });
}

describe("agent adapter factory", () => {
  test("factory construction is lazy and observes model and settings overridden before the first prompt", async () => {
    let originalCalls = 0;
    const original = new MockLanguageModelV4({
      doStream: async () => {
        originalCalls += 1;
        return textResponse("old");
      },
    });
    const replacement = new MockLanguageModelV4({ doStream: async () => textResponse("new") });
    const received: FactoryOptions[] = [];
    const agent = new AiSdkPiAgent({
      model: original,
      system: "initial",
      modelSpecifier: "test/original",
      adapterFactory(settings) {
        received.push(settings);
        return new AiSdkAgentAdapter(settings);
      },
    });
    const history = agent.state.messages;
    agent.state.model = replacement;
    agent.setSystem("updated");
    agent.state.providerOptions = { test: { flag: true } };
    expect(received).toEqual([]);
    expect(agent.state.messages).toBe(history);
    await agent.prompt("question");
    expect(received).toHaveLength(1);
    expect(received[0]?.model).toBe(replacement);
    expect(received[0]?.system).toBe("updated");
    expect(received[0]?.providerOptions).toEqual({ test: { flag: true } });
    expect(received[0]?.messages).toBe(agent.state.messages);
    expect(agent.state.messages).toBe(history);
    expect(originalCalls).toBe(0);
    expect(assistantText(agent.state.messages)).toEqual(["new"]);
  });

  test("idle setModel reaches the next factory with current options and keeps the facade history reference", async () => {
    const first = new MockLanguageModelV4({ doStream: async () => textResponse("first answer") });
    const second = new MockLanguageModelV4({ doStream: async () => textResponse("second answer") });
    const received: FactoryOptions[] = [];
    const agent = new AiSdkPiAgent({
      model: first,
      system: "test",
      modelSpecifier: "test/first",
      adapterFactory(settings) {
        received.push(settings);
        return new AiSdkAgentAdapter(settings);
      },
    });
    await agent.prompt("first question");
    const history = agent.state.messages;
    agent.setModel(second, { test: { updated: true } }, "test/second", "low");
    expect(agent.state.messages).toBe(history);
    expect(received).toHaveLength(1);
    await agent.prompt("second question");
    expect(received).toHaveLength(2);
    expect(received[1]?.model).toBe(second);
    expect(received[1]?.modelSpecifier).toBe("test/second");
    expect(received[1]?.reasoning).toBe("low");
    expect(received[1]?.providerOptions).toEqual({ test: { updated: true } });
    expect(received[1]?.messages).toBe(history);
    expect(agent.state.messages).toBe(history);
    expect(assistantText(agent.state.messages)).toEqual(["first answer", "second answer"]);
  });

  test("SDK fallback setModel retires the old execution before the new factory and handles the failure once", async () => {
    const timeline: string[] = [];
    const failure = new Error("first provider failed");
    let firstCalls = 0;
    const first = new MockLanguageModelV4({
      doStream: async () => {
        firstCalls += 1;
        timeline.push("call:first");
        throw failure;
      },
    });
    const second = new MockLanguageModelV4({
      doStream: async () => {
        timeline.push("call:second");
        return textResponse("recovered");
      },
    });
    const received: FactoryOptions[] = [];
    const handled: unknown[] = [];
    const agent = new AiSdkPiAgent({
      model: first,
      system: "test",
      streamTextMaxRetries: 0,
      adapterFactory(settings) {
        received.push(settings);
        const label = settings.model === first ? "first" : "second";
        timeline.push(`factory:${label}`);
        return trackedSdkAdapter(settings, label, timeline);
      },
      turnErrorHandler(error) {
        handled.push(error);
        timeline.push("handler");
        agent.setModel(second, undefined, "test/fallback");
        return "retry";
      },
    });
    let ends = 0;
    agent.subscribe((event) => {
      if (event.type === "agent_end") ends += 1;
    });
    await agent.prompt("question");
    expect(firstCalls).toBe(1);
    expect(handled).toEqual([failure]);
    expect(received.map((settings) => settings.model)).toEqual([first, second]);
    expect(received[1]?.modelSpecifier).toBe("test/fallback");
    expect(timeline).toEqual([
      "factory:first",
      "start:first",
      "call:first",
      "handler",
      "dispose:first",
      "factory:second",
      "start:second",
      "call:second",
      "dispose:second",
    ]);
    expect(assistantText(agent.state.messages)).toEqual(["recovered"]);
    expect(ends).toBe(1);
  });

  test("changing the model after a final answer waits for the next prompt when the boundary adds no work", async () => {
    const first = new MockLanguageModelV4({ doStream: async () => textResponse("first answer") });
    let secondCalls = 0;
    const second = new MockLanguageModelV4({
      doStream: async () => {
        secondCalls += 1;
        return textResponse("second answer");
      },
    });
    const received: FactoryOptions[] = [];
    const agent = new AiSdkPiAgent({
      model: first,
      system: "test",
      adapterFactory(settings) {
        received.push(settings);
        return new AiSdkAgentAdapter(settings);
      },
      turnBoundaryHandler() {
        agent.setModel(second, undefined, "test/next");
        return {};
      },
    });
    await agent.prompt("first question");
    expect(received.map((settings) => settings.model)).toEqual([first]);
    expect(secondCalls).toBe(0);
    expect(assistantText(agent.state.messages)).toEqual(["first answer"]);
    await agent.prompt("second question");
    expect(received.map((settings) => settings.model)).toEqual([first, second]);
    expect(secondCalls).toBe(1);
    expect(assistantText(agent.state.messages)).toEqual(["first answer", "second answer"]);
  });

  test("a boundary model change starts the next request only after the old execution is disposed", async () => {
    const timeline: string[] = [];
    let firstCalls = 0;
    const first = new MockLanguageModelV4({
      doStream: async () => {
        firstCalls += 1;
        return textResponse("first answer");
      },
    });
    const second = new MockLanguageModelV4({ doStream: async () => textResponse("second answer") });
    let boundaries = 0;
    const agent = new AiSdkPiAgent({
      model: first,
      system: "test",
      adapterFactory(settings) {
        const label = settings.model === first ? "first" : "second";
        timeline.push(`factory:${label}`);
        return trackedSdkAdapter(settings, label, timeline);
      },
      turnBoundaryHandler() {
        boundaries += 1;
        if (boundaries > 1) return {};
        agent.setModel(second, undefined, "test/second");
        return { append: [{ role: "user", content: "continue with new model" }] };
      },
    });
    const history = agent.state.messages;
    await agent.prompt("question");
    expect(firstCalls).toBe(1);
    expect(timeline).toEqual([
      "factory:first",
      "start:first",
      "dispose:first",
      "factory:second",
      "start:second",
      "dispose:second",
    ]);
    expect(assistantText(agent.state.messages)).toEqual(["first answer", "second answer"]);
    expect(agent.state.messages).toBe(history);
    expect(boundaries).toBe(2);
  });
});
