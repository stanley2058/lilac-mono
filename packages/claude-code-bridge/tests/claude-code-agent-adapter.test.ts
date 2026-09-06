import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import { Panic, Result } from "better-result";
import { AgentExecutor } from "@stanley2058/lilac-agent/agent-executor";
import {
  ClaudeCodeAgentAdapter,
  type ClaudeCodeAgentLifecycle,
} from "../claude-code-agent-adapter";
import type { MaterializedClaudeCodeRun } from "../claude-code-run";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
function fixture(options: { immediateDelivery?: boolean; accept?: boolean } = {}) {
  const started = Promise.withResolvers<void>();
  const secondStarted = Promise.withResolvers<void>();
  const injected = Promise.withResolvers<void>();
  let finish = () => {};
  let fail = (_error: Error) => {};
  let deliver: ((value: boolean) => void) | undefined;
  let interruptions = 0;
  let disposals = 0;
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            fail = (error) => controller.error(error);
            finish = () => {
              controller.enqueue({ type: "text-start", id: "answer" });
              controller.enqueue({ type: "text-delta", id: "answer", delta: "answer" });
              controller.enqueue({ type: "text-end", id: "answer" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              });
              controller.close();
            };
            started.resolve();
            if (calls === 2) secondStarted.resolve();
          },
        }),
      };
    },
  });
  const nativeRun: MaterializedClaudeCodeRun = {
    agentModel: model,
    createUtilityModelResult: () => Result.ok(model),
    createUtilityModel: () => model,
    control: {
      inject(_text, callback) {
        deliver = callback;
        if (options.immediateDelivery !== undefined) callback?.(options.immediateDelivery);
        injected.resolve();
        return options.accept !== false;
      },
      async interruptResult() {
        interruptions += 1;
        finish();
        return Result.ok(true);
      },
      async interrupt() {
        interruptions += 1;
        finish();
        return true;
      },
      clearResult: () => Result.ok(undefined),
      clear() {},
    },
    async disposeResult() {
      disposals += 1;
      return Result.ok(undefined);
    },
    async dispose() {
      disposals += 1;
    },
  };
  const lifecycle: ClaudeCodeAgentLifecycle = { currentRun: () => nativeRun };
  const adapter = new ClaudeCodeAgentAdapter({ system: "test", model }, lifecycle);
  return {
    model,
    nativeRun,
    lifecycle,
    adapter,
    started: started.promise,
    secondStarted: secondStarted.promise,
    injected: injected.promise,
    finish: () => finish(),
    fail: (error: Error) => fail(error),
    deliver: (value: boolean) => deliver?.(value),
    interruptions: () => interruptions,
    disposals: () => disposals,
    calls: () => calls,
  };
}

describe("ClaudeCodeAgentAdapter", () => {
  test.each([true, false])(
    "commits confirmed injection before the complete assistant turn, synchronous callback: %s",
    async (synchronous) => {
      const f = fixture(synchronous ? { immediateDelivery: true } : {});
      const checkpoints: { messages: readonly ModelMessage[]; ids: readonly string[] }[] = [];
      let ends = 0;
      const agent = new AgentExecutor({
        system: "test",
        adapter: f.adapter,
        recoveryCheckpointHandler(messages, ids) {
          checkpoints.push({ messages, ids });
        },
      });
      agent.subscribe((event) => {
        if (event.type === "agent_end") ends += 1;
      });
      const running = agent.prompt("question");
      await f.started;
      const id = agent.steer({ role: "user", content: "update" });
      await f.injected;
      if (!synchronous) f.deliver(true);
      expect(agent.state.messages.some((m) => m.content === "update")).toBe(false);
      f.finish();
      await running;
      expect(agent.state.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
      expect(agent.state.messages.filter((m) => m.content === "update")).toHaveLength(1);
      expect(checkpoints.some((checkpoint) => checkpoint.ids.includes(id))).toBe(true);
      expect(f.calls()).toBe(1);
      expect(f.disposals()).toBe(0);
      expect(ends).toBe(1);
      f.deliver(false);
      expect(agent.state.messages.filter((m) => m.content === "update")).toHaveLength(1);
    },
  );

  test("records successful native cursor before the host boundary mutates history", async () => {
    const f = fixture();
    const order: string[] = [];
    f.lifecycle.recordSuccessfulModelCall = async (messages) => {
      order.push("record");
      expect(messages.at(-1)?.role).toBe("assistant");
    };
    const agent = new AgentExecutor({
      system: "test",
      adapter: f.adapter,
      turnBoundaryHandler() {
        order.push("boundary");
        return {};
      },
    });
    const running = agent.prompt("question");
    await f.started;
    f.finish();
    await running;
    expect(order).toEqual(["record", "boundary"]);
  });

  test("unacknowledged injection ends with recoverable ownership instead of completion", async () => {
    const f = fixture();
    let retries = 0;
    const agent = new AgentExecutor({
      system: "test",
      adapter: f.adapter,
      turnErrorHandler() {
        retries += 1;
        return "retry";
      },
    });
    const running = agent.prompt("question");
    const rejected = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await f.started;
    const id = agent.steer({ role: "user", content: "uncertain" });
    await f.injected;
    f.finish();
    expect(await rejected).toBeDefined();
    expect(agent.state.recoveryRequired?.inputIds).toEqual([id]);
    expect(retries).toBe(0);
    f.deliver(true);
    expect(agent.state.messages.some((m) => m.content === "uncertain")).toBe(false);
  });

  test("cancel interrupts the current runtime and leaves persistent disposal to its owner", async () => {
    const f = fixture();
    const agent = new AgentExecutor({ system: "test", adapter: f.adapter });
    const running = agent.prompt("question");
    await f.started;
    agent.cancel();
    await running;
    expect(f.interruptions()).toBe(1);
    expect(f.disposals()).toBe(0);
  });

  test.each(["callback", "synchronous"] as const)(
    "definite %s rejection returns the input to the next model boundary",
    async (mode) => {
      const f = fixture(mode === "callback" ? { immediateDelivery: false } : { accept: false });
      const agent = new AgentExecutor({ system: "test", adapter: f.adapter });
      const running = agent.prompt("question");
      await f.started;
      agent.steer({ role: "user", content: "returned update" });
      await f.injected;
      f.finish();
      await f.secondStarted;
      f.finish();
      await running;
      expect(agent.state.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(
        agent.state.messages.filter((message) => message.content === "returned update"),
      ).toHaveLength(1);
      expect(f.calls()).toBe(2);
    },
  );

  test("returns later controls to the boundary while an earlier native input is pending", async () => {
    const f = fixture();
    let injectionCalls = 0;
    const inject = f.nativeRun.control.inject;
    f.nativeRun.control.inject = (...args) => {
      injectionCalls += 1;
      return inject(...args);
    };
    const agent = new AgentExecutor({ system: "test", adapter: f.adapter });
    const running = agent.prompt("question");
    await f.started;
    agent.steer({ role: "user", content: "first" });
    await f.injected;
    agent.steer({ role: "user", content: "second" });
    f.deliver(true);
    f.finish();
    await f.secondStarted;
    f.finish();
    await running;
    expect(injectionCalls).toBe(1);
    expect(
      agent.state.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["question", "first", "second"]);
  });

  test("preserves a preparation Panic and retires the execution without native work", async () => {
    const f = fixture();
    const panic = new Panic({ message: "preparation defect" });
    f.lifecycle.prepareModelCall = () => {
      throw panic;
    };
    const agent = new AgentExecutor({ system: "test", adapter: f.adapter });
    await expect(agent.prompt("question")).rejects.toBe(panic);
    expect(f.calls()).toBe(0);
    expect(f.disposals()).toBe(0);
  });

  test("waits for native retry retirement before preparing the replacement model call", async () => {
    const f = fixture();
    const retirementEntered = Promise.withResolvers<void>();
    const releaseRetirement = Promise.withResolvers<void>();
    const order: string[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        order.push("model");
        if (calls === 1) throw new Error("retry this call");
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage,
              });
              controller.close();
            },
          }),
        };
      },
    });
    const lifecycle: ClaudeCodeAgentLifecycle = {
      currentRun: () => f.nativeRun,
      prepareModelCall(context) {
        order.push("prepare");
        return { runtime: context.runtime, payload: context.payload };
      },
      async retireForRetry() {
        order.push("retire");
        retirementEntered.resolve();
        await releaseRetirement.promise;
      },
    };
    const adapter = new ClaudeCodeAgentAdapter(
      { system: "test", model, streamTextMaxRetries: 0 },
      lifecycle,
    );
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      turnErrorHandler() {
        order.push("policy");
        return "retry";
      },
    });
    const running = agent.prompt("question");
    await retirementEntered.promise;
    expect(calls).toBe(1);
    releaseRetirement.resolve();
    await running;
    expect(order).toEqual(["prepare", "model", "policy", "retire", "prepare", "model"]);
  });

  test("controls resolve the current native candidate after preparation", async () => {
    const f = fixture();
    let replacementInterruptions = 0;
    const replacement: MaterializedClaudeCodeRun = {
      ...f.nativeRun,
      control: {
        ...f.nativeRun.control,
        async interruptResult() {
          replacementInterruptions += 1;
          f.finish();
          return Result.ok(true);
        },
      },
    };
    let current = f.nativeRun;
    f.lifecycle.currentRun = () => current;
    const agent = new AgentExecutor({ system: "test", adapter: f.adapter });
    const running = agent.prompt("question");
    await f.started;
    current = replacement;
    agent.cancel();
    await running;
    expect(replacementInterruptions).toBe(1);
    expect(f.interruptions()).toBe(0);
  });

  test("an interruption Panic still settles SDK work and keeps the original defect", async () => {
    const f = fixture();
    const panic = new Panic({ message: "interrupt defect" });
    f.nativeRun.control.interruptResult = async () => {
      f.finish();
      throw panic;
    };
    const agent = new AgentExecutor({ system: "test", adapter: f.adapter });
    const running = agent.prompt("question");
    const failure = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await f.started;
    agent.cancel();
    expect(await failure).toBe(panic);
    expect(agent.state.isStreaming).toBe(false);
  });

  test.each(["pending", "throwing"] as const)(
    "settles %s injection before host retry and replays its original input once",
    async (mode) => {
      const f = fixture();
      const order: string[] = [];
      const error = new Error("injected before throwing");
      if (mode === "throwing")
        f.nativeRun.control.inject = () => {
          order.push("injected");
          throw error;
        };
      f.nativeRun.settleExecutionResult = async () => {
        order.push("settled");
        return Result.ok(undefined);
      };
      const agent = new AgentExecutor({
        system: "test",
        adapter: f.adapter,
        turnErrorHandler() {
          order.push("retry");
          return "retry";
        },
      });
      const running = agent.prompt("question");
      await f.started;
      const id = agent.steer({ role: "user", content: "replay" });
      if (mode === "pending") {
        await f.injected;
        f.finish();
      }
      await f.secondStarted;
      expect(order.indexOf("settled")).toBeLessThan(order.indexOf("retry"));
      f.deliver(true);
      f.finish();
      await running;
      expect(agent.state.messages.filter((message) => message.content === "replay")).toHaveLength(
        1,
      );
      expect(agent.state.recoveryRequired).toBeUndefined();
      expect(agent.getQueuedSteeringIds()).not.toContain(id);
      expect(f.calls()).toBe(2);
    },
  );

  test("execution Panic wins after unresolved runtime cleanup also panics", async () => {
    const f = fixture();
    const executionPanic = new Panic({ message: "execution defect" });
    const cleanupPanic = new Panic({ message: "retirement defect" });
    let retired = false;
    f.lifecycle.retireForRetry = async () => {
      retired = true;
      throw cleanupPanic;
    };
    const agent = new AgentExecutor({ system: "test", adapter: f.adapter });
    const running = agent.prompt("question");
    const failure = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    await f.started;
    agent.steer({ role: "user", content: "uncertain" });
    await f.injected;
    f.fail(executionPanic);
    expect(await failure).toBe(executionPanic);
    expect(retired).toBe(true);
  });

  test("steering accepted after a completed host boundary resumes after retirement", async () => {
    const f = fixture();
    let admitted = false;
    const agent = new AgentExecutor({
      system: "test",
      adapter: {
        createExecution(context) {
          return f.adapter.createExecution({
            ...context,
            host: {
              ...context.host,
              async finishBoundary(input) {
                const decision = await context.host.finishBoundary(input);
                if (decision === "break" && !admitted) {
                  admitted = true;
                  agent.steer({ role: "user", content: "late" });
                }
                return decision;
              },
            },
          });
        },
      },
    });
    const running = agent.prompt("question");
    await f.started;
    f.finish();
    await f.secondStarted;
    f.finish();
    await running;
    expect(agent.state.messages.filter((message) => message.content === "late")).toHaveLength(1);
    expect(f.calls()).toBe(2);
  });
});
