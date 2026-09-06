import { describe, expect, test } from "bun:test";
import { Panic, Result } from "better-result";
import { AgentExecutor } from "../agent-executor";
import type { AgentExecutionHost } from "../agent-execution-host";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  AgentAdapterFailure,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentExecution,
  type AgentExecutionEvent,
  type AgentHostServices,
  type AgentInput,
} from "../agent-adapter";

type ExecutionPayload = AgentExecutionEvent extends infer Event
  ? Event extends AgentExecutionEvent
    ? Omit<Event, "attemptId" | "sequence">
    : never
  : never;

class ControlledExecution implements AgentExecution {
  readonly events: AsyncIterable<AgentExecutionEvent>;
  readonly started = Promise.withResolvers<void>();
  readonly inputSubmitted = Promise.withResolvers<AgentInput>();
  nextSubmitted = Promise.withResolvers<AgentInput>();
  submissionResult: ReturnType<AgentExecution["submitInput"]> = Result.ok(undefined);
  startResult: ReturnType<AgentExecution["start"]> = Result.ok(undefined);
  startPanic: Panic | undefined;
  readonly submitted: AgentInput[] = [];
  readonly abort = new AbortController();
  private readonly queued: AgentExecutionEvent[] = [];
  private available = Promise.withResolvers<void>();
  private sequence = 0;
  private closed = false;
  cancelled = false;
  disposed = false;

  constructor(
    readonly attemptId: string,
    readonly capabilities: AgentCapabilities,
    readonly host: AgentHostServices,
    readonly initialMessages: readonly ModelMessage[],
  ) {
    this.events = this.readEvents();
  }

  private async *readEvents(): AsyncIterable<AgentExecutionEvent> {
    while (!this.closed || this.queued.length > 0) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      await this.available.promise;
      this.available = Promise.withResolvers<void>();
    }
  }

  emit(payload: ExecutionPayload): void {
    this.queued.push({ attemptId: this.attemptId, sequence: this.sequence++, ...payload });
    this.available.resolve();
  }

  start() {
    this.started.resolve();
    if (this.startPanic) throw this.startPanic;
    return this.startResult;
  }

  submitInput(input: AgentInput) {
    this.submitted.push(input);
    this.inputSubmitted.resolve(input);
    this.nextSubmitted.resolve(input);
    this.nextSubmitted = Promise.withResolvers<AgentInput>();
    return this.submissionResult;
  }

  async interrupt() {
    this.abort.abort();
    this.emit({ type: "terminal", outcome: { status: "interrupted" } });
    return Result.ok(undefined);
  }

  async cancel() {
    this.cancelled = true;
    this.abort.abort();
    this.emit({ type: "terminal", outcome: { status: "cancelled" } });
    return Result.ok(undefined);
  }

  async dispose() {
    this.disposed = true;
    this.closed = true;
    this.available.resolve();
    return Result.ok(undefined);
  }
}

class ControlledAdapter implements AgentAdapter {
  readonly created = Promise.withResolvers<ControlledExecution>();
  readonly executions: ControlledExecution[] = [];
  nextCreated = Promise.withResolvers<ControlledExecution>();

  constructor(
    readonly capabilities: AgentCapabilities = {
      steering: "native",
      followUp: "boundary",
      interruption: "native",
    },
    readonly configure?: (execution: ControlledExecution) => void,
  ) {}

  createExecution(context: Parameters<AgentAdapter["createExecution"]>[0]) {
    const execution = new ControlledExecution(
      context.attemptId,
      this.capabilities,
      context.host,
      context.messages,
    );
    this.configure?.(execution);
    this.executions.push(execution);
    this.created.resolve(execution);
    this.nextCreated.resolve(execution);
    this.nextCreated = Promise.withResolvers<ControlledExecution>();
    return execution;
  }
}

describe("provider-neutral agent executor", () => {
  test("adapter state views cannot mutate canonical history or nested message content", async () => {
    const controlled = new ControlledAdapter();
    const hostCreated = Promise.withResolvers<AgentExecutionHost>();
    const adapter: AgentAdapter<AgentExecutionHost> = {
      createExecution(context) {
        hostCreated.resolve(context.host);
        return controlled.createExecution(context);
      },
    };
    const agent = new AgentExecutor({
      system: { role: "system", content: "original system" },
      providerOptions: { test: { nested: { value: "original option" } } },
      adapter,
    });
    const run = agent.prompt({ role: "user", content: [{ type: "text", text: "question" }] });
    const execution = await controlled.created.promise;
    const host = await hostCreated.promise;
    await execution.started.promise;
    const view = host.readState();
    const mutableMessages = view.messages as ModelMessage[];
    mutableMessages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "orphan",
          toolName: "read",
          output: { type: "text", value: "injected" },
        },
      ],
    });
    const first = view.messages[0];
    if (first?.role !== "user" || typeof first.content === "string")
      throw new Error("Expected multipart user message");
    const part = first.content[0];
    if (part?.type !== "text") throw new Error("Expected user text part");
    part.text = "mutated";
    const system = view.system;
    if (typeof system === "string" || !("role" in system))
      throw new Error("Expected system message");
    system.content = "mutated system";
    const nestedOption = view.providerOptions?.test?.nested;
    if (!nestedOption || typeof nestedOption !== "object" || Array.isArray(nestedOption))
      throw new Error("Expected nested provider option");
    nestedOption.value = "mutated option";
    (view.pendingToolCalls as Set<string>).add("forged-call");
    expect(host.readState().messages).toEqual([
      { role: "user", content: [{ type: "text", text: "question" }] },
    ]);
    expect(host.readState().system).toEqual({ role: "system", content: "original system" });
    expect(host.readState().providerOptions).toEqual({
      test: { nested: { value: "original option" } },
    });
    expect(host.readState().pendingToolCalls.size).toBe(0);
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(agent.state.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "question" }] },
    ]);
  });

  test("failed start disposes and retires its attempt before a replacement prompt", async () => {
    const failure = new AgentAdapterFailure({
      reason: "unavailable",
      message: "Start rejected",
      replaySafety: "safe",
    });
    let created = 0;
    const adapter = new ControlledAdapter(undefined, (execution) => {
      if (++created === 1) execution.startResult = Result.err(failure);
    });
    const agent = new AgentExecutor({ system: "test", adapter });
    const run = agent.prompt("first");
    const observedRun = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    const first = await adapter.created.promise;
    expect(await observedRun).toBe(failure);
    expect(first.disposed).toBe(true);
    expect(agent.state.isStreaming).toBe(false);
    const retiredHost = await first.host.prepareContext({
      attemptId: first.attemptId,
      messages: first.initialMessages,
      step: 1,
      signal: new AbortController().signal,
    });
    expect(retiredHost.isErr()).toBe(true);
    const replacementCreated = adapter.nextCreated.promise;
    const nextRun = agent.prompt("second");
    const next = await replacementCreated;
    await next.started.promise;
    expect(next.attemptId).not.toBe(first.attemptId);
    next.emit({
      type: "history-commit",
      inputIds: [],
      messages: [{ role: "assistant", content: "answer" }],
    });
    next.emit({ type: "terminal", outcome: { status: "completed" } });
    await nextRun;
    expect(agent.state.messages.at(-1)?.content).toBe("answer");
  });

  test("a Panic thrown by start is preserved after attempt disposal", async () => {
    const panic = new Panic({ message: "start invariant failed" });
    const adapter = new ControlledAdapter(undefined, (execution) => {
      execution.startPanic = panic;
    });
    const agent = new AgentExecutor({ system: "test", adapter });
    const run = agent.prompt("question");
    const observedRun = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    const execution = await adapter.created.promise;
    expect(await observedRun).toBe(panic);
    expect(execution.disposed).toBe(true);
    expect(agent.state.isStreaming).toBe(false);
  });

  test("a custom adapter streams output and commits history without an AI SDK model", async () => {
    const adapter = new ControlledAdapter();
    const agent = new AgentExecutor({ system: "test", adapter });
    const deltaObserved = Promise.withResolvers<void>();
    const lifecycle: string[] = [];
    agent.subscribe((event) => {
      lifecycle.push(event.type);
      if (event.type === "message_update") deltaObserved.resolve();
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    expect(lifecycle[0]).toBe("agent_start");
    expect(execution.initialMessages).toEqual([{ role: "user", content: "question" }]);
    execution.emit({ type: "output", output: { kind: "text", phase: "start", id: "answer" } });
    execution.emit({
      type: "output",
      output: { kind: "text", phase: "delta", id: "answer", delta: "partial" },
    });
    await deltaObserved.promise;
    expect(agent.state.messages).toEqual([{ role: "user", content: "question" }]);
    execution.emit({
      type: "history-commit",
      inputIds: [],
      messages: [{ role: "assistant", content: "complete" }],
    });
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(agent.state.messages).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "complete" },
    ]);
    expect(lifecycle.filter((type) => type === "agent_end")).toHaveLength(1);
    expect(execution.disposed).toBe(true);
  });

  test("native steering stays noncanonical until its ordered input commit", async () => {
    const adapter = new ControlledAdapter();
    const prepared = Promise.withResolvers<void>();
    const retained: string[] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      beforeSteeringDelivery() {
        prepared.resolve();
      },
      recoveryCheckpointHandler(_messages, inputIds) {
        retained.push(...inputIds);
      },
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const id = agent.steer("correction");
    const submitted = await execution.inputSubmitted.promise;
    await prepared.promise;
    expect(submitted.id).toBe(id);
    expect(retained).toEqual([]);
    expect(agent.state.messages).toEqual([{ role: "user", content: "question" }]);
    execution.emit({ type: "delivery", status: "provider-owned", inputIds: [id] });
    execution.emit({
      type: "history-commit",
      inputIds: [id],
      messages: [
        { role: "assistant", content: "predecessor" },
        ...submitted.messages,
        { role: "assistant", content: "successor" },
      ],
    });
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(agent.state.messages).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "predecessor" },
      { role: "user", content: "correction" },
      { role: "assistant", content: "successor" },
    ]);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
    expect(execution.submitted).toHaveLength(1);
    expect(retained).toEqual([id]);
  });

  test("one native submission commits every input absorbed into its canonical message", async () => {
    const adapter = new ControlledAdapter();
    const retained: string[] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      recoveryCheckpointHandler(_messages, ids) {
        retained.push(...ids);
      },
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const followUpId = agent.followUp("background");
    const steeringId = agent.steer("correction");
    const submitted = await execution.inputSubmitted.promise;
    expect(submitted.messages).toEqual([{ role: "user", content: "background\n\ncorrection" }]);
    expect(retained).toEqual([]);
    execution.emit({ type: "delivery", status: "provider-owned", inputIds: [submitted.id] });
    execution.emit({
      type: "history-commit",
      inputIds: [submitted.id],
      messages: submitted.messages,
    });
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(agent.state.messages).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "background\n\ncorrection" },
    ]);
    expect(retained).toEqual([followUpId, steeringId]);
    expect(agent.getQueuedSteeringIds()).toEqual([]);
    expect(execution.submitted).toHaveLength(1);
  });

  test("definite native submission failure returns input to the boundary queue", async () => {
    const adapter = new ControlledAdapter();
    const retained: string[] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      recoveryCheckpointHandler(_messages, ids) {
        retained.push(...ids);
      },
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    execution.submissionResult = Result.err(
      new AgentAdapterFailure({
        reason: "unavailable",
        message: "Request was not transmitted",
        replaySafety: "safe",
      }),
    );
    const id = agent.steer("correction");
    await execution.inputSubmitted.promise;
    expect(agent.getQueuedSteeringIds()).toEqual([id]);
    expect(retained).toEqual([]);
    const boundary = await execution.host.boundary({
      attemptId: execution.attemptId,
      finishReason: "stop",
      modelInputMessages: execution.initialMessages,
      executedToolCallCount: 0,
      naturallyRequiresContinuation: false,
      signal: execution.abort.signal,
    });
    expect(boundary.isOk()).toBe(true);
    expect(agent.state.messages.at(-1)?.content).toBe("correction");
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(retained).toEqual([id]);
    expect(execution.submitted).toHaveLength(1);
  });

  test("uncertain submission after asynchronous preparation fails the run and preserves uncommitted input", async () => {
    const adapter = new ControlledAdapter();
    const preparationStarted = Promise.withResolvers<void>();
    const preparationFinished = Promise.withResolvers<void>();
    const failure = new AgentAdapterFailure({
      reason: "unavailable",
      message: "Acknowledgement was lost",
      replaySafety: "reconcile",
    });
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      beforeSteeringDelivery() {
        preparationStarted.resolve();
        return preparationFinished.promise;
      },
    });
    const run = agent.prompt("question");
    const observedRun = run.then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    const execution = await adapter.created.promise;
    await execution.started.promise;
    execution.submissionResult = Result.err(failure);
    const id = agent.steer("correction");
    await preparationStarted.promise;
    expect(execution.submitted).toEqual([]);
    preparationFinished.resolve();
    await execution.inputSubmitted.promise;
    expect(await observedRun).toEqual({ status: "failed", error: failure });
    expect(execution.cancelled).toBe(true);
    expect(execution.disposed).toBe(true);
    expect(agent.getQueuedSteeringIds()).toEqual([id]);
    expect(agent.getRecoverableMessages()).toEqual([{ role: "user", content: "question" }]);
    expect(execution.submitted).toHaveLength(1);
  });

  test("a second native batch waits for the first input commitment and then starts", async () => {
    const adapter = new ControlledAdapter();
    const agent = new AgentExecutor({ system: "test", adapter });
    agent.setSteeringMode("one-at-a-time");
    const outputObserved = Promise.withResolvers<void>();
    agent.subscribe((event) => {
      if (event.type === "message_update") outputObserved.resolve();
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const firstId = agent.steer("first correction");
    const first = await execution.inputSubmitted.promise;
    execution.emit({ type: "delivery", status: "provider-owned", inputIds: [firstId] });
    const secondSubmitted = execution.nextSubmitted.promise;
    const secondId = agent.steer("second correction");
    execution.emit({
      type: "output",
      output: { kind: "text", phase: "delta", id: "out", delta: "progress" },
    });
    await outputObserved.promise;
    expect(execution.submitted).toHaveLength(1);
    execution.emit({ type: "history-commit", inputIds: [firstId], messages: first.messages });
    const second = await secondSubmitted;
    expect(second.id).toBe(secondId);
    execution.emit({ type: "delivery", status: "provider-owned", inputIds: [secondId] });
    execution.emit({ type: "history-commit", inputIds: [secondId], messages: second.messages });
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(execution.submitted.map((entry) => entry.id)).toEqual([firstId, secondId]);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "first correction" },
      { role: "user", content: "second correction" },
    ]);
  });

  test("boundary steering uses host preparation and never calls native submission", async () => {
    const adapter = new ControlledAdapter({
      steering: "boundary",
      followUp: "boundary",
      interruption: "restart",
    });
    const delivered: string[] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      beforeSteeringDelivery(context) {
        delivered.push(...context.batch.map((entry) => entry.id));
      },
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const id = agent.steer("correction");
    const wrongAttemptBoundary = await execution.host.boundary({
      attemptId: "different-attempt",
      finishReason: "stop",
      modelInputMessages: execution.initialMessages,
      executedToolCallCount: 0,
      naturallyRequiresContinuation: false,
      signal: execution.abort.signal,
    });
    expect(wrongAttemptBoundary.isErr()).toBe(true);
    expect(agent.getQueuedSteeringIds()).toEqual([id]);
    expect(delivered).toEqual([]);
    const boundary = await execution.host.boundary({
      attemptId: execution.attemptId,
      finishReason: "stop",
      modelInputMessages: execution.initialMessages,
      executedToolCallCount: 0,
      naturallyRequiresContinuation: false,
      signal: execution.abort.signal,
    });
    expect(boundary.isOk()).toBe(true);
    if (boundary.isErr()) throw boundary.error;
    expect(boundary.value.action).toBe("continue");
    expect(delivered).toEqual([id]);
    expect(execution.submitted).toEqual([]);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "correction" },
    ]);
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(agent.getQueuedSteeringIds()).toEqual([]);
  });
  test("absorbed follow-up and steering retain both checkpoint IDs for their merged message", async () => {
    const adapter = new ControlledAdapter({
      steering: "boundary",
      followUp: "boundary",
      interruption: "restart",
    });
    const retained: string[] = [];
    const checkpointMessages: ModelMessage[][] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      recoveryCheckpointHandler(messages, inputIds) {
        retained.push(...inputIds);
        checkpointMessages.push([...messages]);
      },
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const followUpId = agent.followUp("background");
    const steeringId = agent.steer("correction");
    const boundary = await execution.host.boundary({
      attemptId: execution.attemptId,
      finishReason: "stop",
      modelInputMessages: execution.initialMessages,
      executedToolCallCount: 0,
      naturallyRequiresContinuation: false,
      signal: execution.abort.signal,
    });
    expect(boundary.isOk()).toBe(true);
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(agent.state.messages).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "background\n\ncorrection" },
    ]);
    expect(retained).toEqual([followUpId, steeringId]);
    expect(checkpointMessages.at(-1)).toEqual(agent.state.messages);
  });

  test("custom adapter tool requests use immutable host scopes and normalized results", async () => {
    const adapter = new ControlledAdapter();
    const calls: number[] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      tools: {
        double: tool({
          description: "Double a number",
          inputSchema: z.object({ value: z.number() }),
          execute: ({ value }) => {
            calls.push(value);
            return value * 2;
          },
        }),
      },
      normalizeToolResultOutput: () => ({ type: "text", value: "host normalized" }),
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const wrongAttemptPreparation = await execution.host.prepareContext({
      attemptId: "different-attempt",
      messages: execution.initialMessages,
      step: 1,
      signal: execution.abort.signal,
    });
    expect(wrongAttemptPreparation.isErr()).toBe(true);
    const prepared = await execution.host.prepareContext({
      attemptId: execution.attemptId,
      messages: execution.initialMessages,
      step: 1,
      signal: execution.abort.signal,
    });
    expect(prepared.isOk()).toBe(true);
    if (prepared.isErr()) throw prepared.error;
    expect(prepared.value.tools.map((entry) => entry.name)).toEqual(["double"]);
    const denied = await execution.host.executeTools({
      attemptId: execution.attemptId,
      scopeId: "forged-scope",
      calls: [{ callId: "forged", name: "double", inputJson: '{"value":3}' }],
      signal: execution.abort.signal,
    });
    expect(denied.isErr()).toBe(true);
    expect(calls).toEqual([]);
    agent.setTools({
      double: tool({
        description: "Replacement for the next scope",
        inputSchema: z.object({ value: z.number() }),
        execute: ({ value }) => {
          calls.push(value + 100);
          return 999;
        },
      }),
    });
    const executed = await execution.host.executeTools({
      attemptId: execution.attemptId,
      scopeId: prepared.value.scopeId,
      calls: [{ callId: "call", name: "double", inputJson: '{"value":3}' }],
      signal: execution.abort.signal,
    });
    expect(executed.isOk()).toBe(true);
    if (executed.isErr()) throw executed.error;
    expect(calls).toEqual([3]);
    expect(executed.value[0]?.message.content).toEqual([
      {
        type: "tool-result",
        toolCallId: "call",
        toolName: "double",
        output: { type: "text", value: "host normalized" },
      },
    ]);
    execution.emit({
      type: "history-commit",
      inputIds: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "call", toolName: "double", input: { value: 3 } },
          ],
        },
        ...executed.value.map((entry) => entry.message),
      ],
    });
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
  });

  test("an exclusive tool suppresses ordinary tools throughout the native request cohort", async () => {
    const adapter = new ControlledAdapter();
    const calls: string[] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      exclusiveToolNames: new Set(["exclusive"]),
      tools: {
        normal: tool({
          inputSchema: z.object({}),
          execute: () => {
            calls.push("normal");
            return "normal";
          },
        }),
        exclusive: tool({
          inputSchema: z.object({}),
          execute: () => {
            calls.push("exclusive");
            return "exclusive";
          },
        }),
      },
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const prepared = await execution.host.prepareContext({
      attemptId: execution.attemptId,
      messages: execution.initialMessages,
      step: 1,
      signal: execution.abort.signal,
    });
    if (prepared.isErr()) throw prepared.error;
    const executed = await execution.host.executeTools({
      attemptId: execution.attemptId,
      scopeId: prepared.value.scopeId,
      signal: execution.abort.signal,
      calls: [
        { callId: "normal-call", name: "normal", inputJson: "{}" },
        { callId: "exclusive-call", name: "exclusive", inputJson: "{}" },
      ],
    });
    expect(executed.isOk()).toBe(true);
    if (executed.isErr()) throw executed.error;
    expect(calls).toEqual(["exclusive"]);
    expect(JSON.stringify(executed.value[0]?.message)).toContain("exclusive tool");
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
  });

  test("cancel retires the active adapter before another execution accepts history", async () => {
    const adapter = new ControlledAdapter();
    const agent = new AgentExecutor({ system: "test", adapter });
    const firstRun = agent.prompt("first");
    const first = await adapter.created.promise;
    await first.started.promise;
    agent.cancel();
    await firstRun;
    expect(first.cancelled).toBe(true);
    expect(first.disposed).toBe(true);
    const retiredPreparation = await first.host.prepareContext({
      attemptId: first.attemptId,
      messages: first.initialMessages,
      step: 2,
      signal: new AbortController().signal,
    });
    expect(retiredPreparation.isErr()).toBe(true);
    const replacementCreated = adapter.nextCreated.promise;
    const secondRun = agent.prompt("second");
    const second = await replacementCreated;
    await second.started.promise;
    first.emit({
      type: "history-commit",
      inputIds: [],
      messages: [{ role: "assistant", content: "stale" }],
    });
    second.emit({
      type: "history-commit",
      inputIds: [],
      messages: [{ role: "assistant", content: "current" }],
    });
    second.emit({ type: "terminal", outcome: { status: "completed" } });
    await secondRun;
    expect(agent.state.messages.some((message) => message.content === "stale")).toBe(false);
    expect(agent.state.messages.at(-1)?.content).toBe("current");
  });
});
