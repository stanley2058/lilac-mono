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
  retryOwner: AgentExecution["retryOwner"];
  onStart: (() => void) | undefined;
  beforeDispose: (() => Promise<void>) | undefined;
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

  emit(payload: ExecutionPayload): number {
    const sequence = this.sequence++;
    this.queued.push({ attemptId: this.attemptId, sequence, ...payload });
    this.available.resolve();
    return sequence;
  }

  start() {
    this.onStart?.();
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
    await this.beforeDispose?.();
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
  test.each(["steer", "followUp"] as const)(
    "%s after a rich host completed boundary waits for a fresh attempt",
    async (kind) => {
      const controlled = new ControlledAdapter();
      const hostCreated = Promise.withResolvers<AgentExecutionHost>();
      const adapter: AgentAdapter<AgentExecutionHost> = {
        createExecution(context) {
          hostCreated.resolve(context.host);
          return controlled.createExecution(context);
        },
      };
      const retained: string[] = [];
      let ended = 0;
      let retries = 0;
      const agent = new AgentExecutor({
        system: "test",
        adapter,
        turnErrorHandler() {
          retries += 1;
          return "fail";
        },
        recoveryCheckpointHandler(_messages, ids) {
          retained.push(...ids);
        },
      });
      agent.subscribe((event) => {
        if (event.type === "agent_end") ended += 1;
      });
      const run = agent.prompt("question");
      const first = await controlled.created.promise;
      const host = await hostCreated.promise;
      await first.started.promise;
      const boundary = await host.finishBoundary({
        finishReason: "stop",
        modelInputMessages: first.initialMessages,
        executedToolCallCount: 0,
        naturallyRequiresContinuation: false,
      });
      expect(boundary).toBe("break");
      const replacementCreated = controlled.nextCreated.promise;
      const id = agent[kind]("late update");
      first.emit({ type: "terminal", outcome: { status: "completed" } });
      const continuation = await Promise.race([
        replacementCreated.then((execution) => ({ status: "replacement" as const, execution })),
        run.then(() => ({ status: "ended" as const })),
      ]);
      expect(continuation.status).toBe("replacement");
      if (continuation.status !== "replacement")
        throw new Error("Completed boundary lost accepted input");
      const replacement = continuation.execution;
      await replacement.started.promise;
      expect(first.submitted).toEqual([]);
      expect(first.disposed).toBe(true);
      expect(replacement.initialMessages).toEqual([
        { role: "user", content: "question" },
        { role: "user", content: "late update" },
      ]);
      replacement.emit({
        type: "history-commit",
        inputIds: [],
        messages: [{ role: "assistant", content: "answer" }],
      });
      replacement.emit({ type: "terminal", outcome: { status: "completed" } });
      await run;
      expect(retained).toEqual([id]);
      expect(ended).toBe(1);
      expect(retries).toBe(0);
    },
  );

  test.each(["steer", "followUp"] as const)(
    "%s accepted during successful attempt disposal continues the same logical run",
    async (kind) => {
      const adapter = new ControlledAdapter();
      const disposalEntered = Promise.withResolvers<void>();
      const releaseDisposal = Promise.withResolvers<void>();
      const retained: string[] = [];
      let ended = 0;
      let retries = 0;
      const agent = new AgentExecutor({
        system: "test",
        adapter,
        turnErrorHandler() {
          retries += 1;
          return "fail";
        },
        recoveryCheckpointHandler(_messages, ids) {
          retained.push(...ids);
        },
      });
      agent.subscribe((event) => {
        if (event.type === "agent_end") ended += 1;
      });
      const run = agent.prompt("question");
      const first = await adapter.created.promise;
      await first.started.promise;
      first.beforeDispose = async () => {
        disposalEntered.resolve();
        await releaseDisposal.promise;
      };
      first.emit({ type: "terminal", outcome: { status: "completed" } });
      await disposalEntered.promise;
      expect(agent.state.isStreaming).toBe(true);
      const replacementCreated = adapter.nextCreated.promise;
      const id = agent[kind]("late update");
      releaseDisposal.resolve();
      const continuation = await Promise.race([
        replacementCreated.then((execution) => ({ status: "replacement" as const, execution })),
        run.then(() => ({ status: "ended" as const })),
      ]);
      expect(continuation.status).toBe("replacement");
      if (continuation.status !== "replacement")
        throw new Error("Accepted input outlived the logical run");
      const replacement = continuation.execution;
      await replacement.started.promise;
      expect(first.disposed).toBe(true);
      expect(ended).toBe(0);
      expect(replacement.initialMessages).toEqual([
        { role: "user", content: "question" },
        { role: "user", content: "late update" },
      ]);
      replacement.emit({
        type: "history-commit",
        inputIds: [],
        messages: [{ role: "assistant", content: "answer" }],
      });
      replacement.emit({ type: "terminal", outcome: { status: "completed" } });
      await run;
      expect(retained).toEqual([id]);
      expect(ended).toBe(1);
      expect(retries).toBe(0);
      expect(adapter.executions).toHaveLength(2);
    },
  );

  test("host retry retires the failed attempt and retains each committed or uncertain input ID once", async () => {
    const timeline: string[] = [];
    const adapter = new ControlledAdapter(undefined, (execution) => {
      execution.onStart = () => {
        timeline.push(`start:${execution.attemptId}`);
      };
      execution.beforeDispose = async () => {
        timeline.push(`dispose:${execution.attemptId}`);
      };
    });
    const cause = new Error("connection lost");
    const failure = new AgentAdapterFailure({
      reason: "unavailable",
      message: "native connection lost",
      replaySafety: "reconcile",
      cause,
    });
    const handled: unknown[] = [];
    const retained: string[] = [];
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      turnErrorHandler(error) {
        handled.push(error);
        timeline.push("handler");
        expect(adapter.executions[0]?.disposed).toBe(true);
        return "retry";
      },
      recoveryCheckpointHandler(_messages, ids) {
        retained.push(...ids);
      },
    });
    const run = agent.prompt("question");
    const first = await adapter.created.promise;
    await first.started.promise;
    const committedId = agent.steer("committed correction");
    const committed = await first.inputSubmitted.promise;
    const commitSequence = first.emit({
      type: "history-commit",
      inputIds: [committedId],
      messages: committed.messages,
    });
    expect(
      (
        await first.host.awaitEvent({ attemptId: first.attemptId, sequence: commitSequence })
      ).isOk(),
    ).toBe(true);
    const pendingSubmission = first.nextSubmitted.promise;
    const pendingId = agent.steer("uncertain correction");
    await pendingSubmission;
    const acceptedSequence = first.emit({
      type: "delivery",
      status: "provider-owned",
      inputIds: [pendingId],
    });
    await first.host.awaitEvent({ attemptId: first.attemptId, sequence: acceptedSequence });
    const replacementCreated = adapter.nextCreated.promise;
    first.emit({ type: "terminal", outcome: { status: "failed", error: failure } });
    const replacement = await replacementCreated;
    await replacement.started.promise;
    expect(handled).toEqual([failure]);
    expect(failure.cause).toBe(cause);
    expect(timeline).toEqual([
      `start:${first.attemptId}`,
      `dispose:${first.attemptId}`,
      "handler",
      `start:${replacement.attemptId}`,
    ]);
    expect(replacement.initialMessages).toEqual([
      { role: "user", content: "question" },
      { role: "user", content: "committed correction" },
      { role: "user", content: "uncertain correction" },
    ]);
    expect(replacement.submitted).toEqual([]);
    replacement.emit({
      type: "history-commit",
      inputIds: [],
      messages: [{ role: "assistant", content: "answer" }],
    });
    replacement.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(retained).toEqual([committedId, pendingId]);
    expect(agent.state.recoveryRequired).toBeUndefined();
    expect(adapter.executions).toHaveLength(2);
  });

  test.each(["fail", "throw"] as const)(
    "host retry budget survives attempts and %s leaves recovery required before terminal publication",
    async (decision) => {
      const adapter = new ControlledAdapter();
      const firstFailure = new AgentAdapterFailure({
        reason: "unavailable",
        message: "first lost acknowledgement",
        replaySafety: "reconcile",
        cause: new Error("first"),
      });
      const secondCause = new Error("second");
      const secondFailure = new AgentAdapterFailure({
        reason: "unavailable",
        message: "second lost acknowledgement",
        replaySafety: "reconcile",
        cause: secondCause,
      });
      const handlerFailure = new Error("retry handler failed");
      const failures: unknown[] = [];
      let recoveryAtEnd: typeof agent.state.recoveryRequired;
      const agent = new AgentExecutor({
        system: "test",
        adapter,
        turnErrorHandler(error) {
          failures.push(error);
          if (failures.length === 1) return "retry";
          if (decision === "throw") throw handlerFailure;
          return "fail";
        },
      });
      agent.subscribe((event) => {
        if (event.type === "agent_end") recoveryAtEnd = agent.state.recoveryRequired;
      });
      const run = agent.prompt("question");
      const observedRun = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      const first = await adapter.created.promise;
      await first.started.promise;
      const firstId = agent.steer("first uncertain update");
      await first.inputSubmitted.promise;
      first.emit({ type: "delivery", status: "provider-owned", inputIds: [firstId] });
      const replacementCreated = adapter.nextCreated.promise;
      first.emit({ type: "terminal", outcome: { status: "failed", error: firstFailure } });
      const second = await replacementCreated;
      await second.started.promise;
      const secondId = agent.steer("second uncertain update");
      await second.inputSubmitted.promise;
      second.emit({ type: "delivery", status: "provider-owned", inputIds: [secondId] });
      second.emit({ type: "terminal", outcome: { status: "failed", error: secondFailure } });
      expect(await observedRun).toBe(decision === "throw" ? handlerFailure : secondCause);
      expect(failures).toEqual([firstFailure, secondFailure]);
      expect(recoveryAtEnd).toEqual({
        attemptId: second.attemptId,
        inputIds: [secondId],
      });
      expect(agent.state.recoveryRequired).toEqual(recoveryAtEnd);
      expect(agent.getQueuedSteeringIds()).toEqual([secondId]);
      expect(adapter.executions).toHaveLength(2);
      expect(second.disposed).toBe(true);
    },
  );

  test("failed replay input preparation keeps the original recovery requirement before agent_end", async () => {
    const adapter = new ControlledAdapter();
    const failure = new AgentAdapterFailure({
      reason: "unavailable",
      message: "lost acknowledgement",
      replaySafety: "reconcile",
      cause: new Error("connection lost"),
    });
    let preparations = 0;
    let handled = 0;
    let recoveryAtEnd: typeof agent.state.recoveryRequired;
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      async beforeSteeringDelivery() {
        preparations += 1;
        if (preparations === 2) throw new Error("replay input preparation failed");
      },
      turnErrorHandler() {
        handled += 1;
        return "retry";
      },
    });
    agent.subscribe((event) => {
      if (event.type === "agent_end") recoveryAtEnd = agent.state.recoveryRequired;
    });
    const run = agent.prompt("question");
    const observedRun = run.then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const id = agent.steer("uncertain correction");
    await execution.inputSubmitted.promise;
    execution.emit({ type: "delivery", status: "provider-owned", inputIds: [id] });
    execution.emit({ type: "terminal", outcome: { status: "failed", error: failure } });
    expect((await observedRun).status).toBe("failed");
    expect(preparations).toBe(2);
    expect(handled).toBe(1);
    expect(recoveryAtEnd).toEqual({ attemptId: execution.attemptId, inputIds: [id] });
    expect(agent.getQueuedSteeringIds()).toEqual([id]);
    expect(adapter.executions).toHaveLength(1);
  });

  test.each(["cancel", "interrupt"] as const)(
    "Panic identity survives simultaneous %s during failed-attempt retirement",
    async (control) => {
      const adapter = new ControlledAdapter();
      const panic = new Panic({ message: "native execution invariant failed" });
      const failure = new AgentAdapterFailure({
        reason: "protocol",
        message: panic.message,
        replaySafety: "reconcile",
        cause: panic,
      });
      let handled = 0;
      const agent = new AgentExecutor({
        system: "test",
        adapter,
        turnErrorHandler() {
          handled += 1;
          return "retry";
        },
      });
      const run = agent.prompt("question");
      const observedRun = run.then(
        () => undefined,
        (error: unknown) => error,
      );
      const execution = await adapter.created.promise;
      await execution.started.promise;
      execution.beforeDispose = async () => {
        if (control === "cancel") {
          agent.cancel();
          return;
        }
        await agent.interrupt("correction");
      };
      execution.emit({ type: "terminal", outcome: { status: "failed", error: failure } });
      expect(await observedRun).toBe(panic);
      expect(execution.disposed).toBe(true);
      expect(handled).toBe(0);
      expect(adapter.executions).toHaveLength(1);
      expect(agent.state.isStreaming).toBe(false);
    },
  );

  test("adapter-owned retries do not invoke the host error handler again", async () => {
    const adapter = new ControlledAdapter(undefined, (execution) => {
      execution.retryOwner = "adapter";
    });
    const cause = new Error("adapter exhausted its own retries");
    const failure = new AgentAdapterFailure({
      reason: "unavailable",
      message: cause.message,
      replaySafety: "safe",
      cause,
    });
    let handled = 0;
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      turnErrorHandler() {
        handled += 1;
        return "retry";
      },
    });
    const run = agent.prompt("question");
    const observedRun = run.then(
      () => undefined,
      (error: unknown) => error,
    );
    const execution = await adapter.created.promise;
    await execution.started.promise;
    execution.emit({ type: "terminal", outcome: { status: "failed", error: failure } });
    expect(await observedRun).toBe(cause);
    expect(execution.disposed).toBe(true);
    expect(handled).toBe(0);
    expect(adapter.executions).toHaveLength(1);
  });

  test.each(["direct", "queued"] as const)(
    "%s native interruption starts a fresh execution after retirement without invoking retry policy",
    async (kind) => {
      const timeline: string[] = [];
      const adapter = new ControlledAdapter(
        { steering: "boundary", followUp: "boundary", interruption: "native" },
        (execution) => {
          execution.onStart = () => {
            timeline.push(`start:${execution.attemptId}`);
          };
          execution.beforeDispose = async () => {
            timeline.push(`dispose:${execution.attemptId}`);
          };
        },
      );
      let handled = 0;
      const retained: string[] = [];
      const agent = new AgentExecutor({
        system: "test",
        adapter,
        turnErrorHandler() {
          handled += 1;
          return "fail";
        },
        recoveryCheckpointHandler(_messages, ids) {
          retained.push(...ids);
        },
      });
      const run = agent.prompt("question");
      const first = await adapter.created.promise;
      await first.started.promise;
      const replacementCreated = adapter.nextCreated.promise;
      const id = kind === "queued" ? agent.steer("correction") : undefined;
      const interruption =
        kind === "queued" ? agent.interruptQueuedSteeringAsync() : agent.interrupt("correction");
      const replacement = await replacementCreated;
      await replacement.started.promise;
      const result = await interruption;
      if (kind === "queued") {
        if (!id) throw new Error("Queued interrupt has no input ID");
        expect(result).toEqual({ status: "interrupted", steeringIds: [id] });
      }
      expect(timeline).toEqual([
        `start:${first.attemptId}`,
        `dispose:${first.attemptId}`,
        `start:${replacement.attemptId}`,
      ]);
      expect(first.disposed).toBe(true);
      expect(replacement.initialMessages).toEqual([
        { role: "user", content: "question" },
        { role: "user", content: "correction" },
      ]);
      replacement.emit({
        type: "history-commit",
        inputIds: [],
        messages: [{ role: "assistant", content: "answer" }],
      });
      replacement.emit({ type: "terminal", outcome: { status: "completed" } });
      await run;
      expect(handled).toBe(0);
      expect(agent.state.recoveryRequired).toBeUndefined();
      if (id) expect(retained).toEqual([id]);
    },
  );

  test("event barriers acknowledge canonical projection and reject wrong or retired attempts", async () => {
    const adapter = new ControlledAdapter();
    const agent = new AgentExecutor({ system: "test", adapter });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    expect(
      (await execution.host.awaitEvent({ attemptId: "different-attempt", sequence: 0 })).isErr(),
    ).toBe(true);
    const sequence = execution.emit({
      type: "history-commit",
      inputIds: [],
      messages: [{ role: "assistant", content: "committed" }],
    });
    const barrier = await execution.host.awaitEvent({ attemptId: execution.attemptId, sequence });
    expect(barrier.isOk()).toBe(true);
    expect(agent.state.messages).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "committed" },
    ]);
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(
      (await execution.host.awaitEvent({ attemptId: execution.attemptId, sequence })).isErr(),
    ).toBe(true);
  });

  test("an invalid history event rejects its barrier before disposal waits for it", async () => {
    const adapter = new ControlledAdapter();
    const agent = new AgentExecutor({ system: "test", adapter });
    const run = agent.prompt("question");
    const observedRun = run.then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const barrier = execution.host.awaitEvent({ attemptId: execution.attemptId, sequence: 0 });
    let disposalObservedBarrier = false;
    execution.beforeDispose = async () => {
      const result = await barrier;
      disposalObservedBarrier = result.isErr();
    };
    execution.emit({
      type: "history-commit",
      inputIds: [],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "orphan",
              toolName: "read",
              output: { type: "text", value: "invalid" },
            },
          ],
        },
      ],
    });
    expect((await barrier).isErr()).toBe(true);
    expect((await observedRun).status).toBe("failed");
    expect(disposalObservedBarrier).toBe(true);
    expect(execution.disposed).toBe(true);
    expect(agent.state.messages).toEqual([{ role: "user", content: "question" }]);
  });

  test("continuation preparation refreshes authority without starting or counting the candidate step", async () => {
    const adapter = new ControlledAdapter();
    const beforeSteps: number[] = [];
    let starts = 0;
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      tools: {
        original: tool({ inputSchema: z.object({}), execute: () => "original" }),
        refreshed: tool({ inputSchema: z.object({}), execute: () => "refreshed" }),
      },
      beforeStep({ step }) {
        beforeSteps.push(step);
        if (step === 2) agent.setActiveTools(new Set(["refreshed"]));
      },
    });
    agent.setActiveTools(new Set(["original"]));
    agent.subscribe((event) => {
      if (event.type === "turn_start") starts += 1;
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const initial = await execution.host.prepareContext({
      attemptId: execution.attemptId,
      messages: execution.initialMessages,
      step: 1,
      signal: execution.abort.signal,
    });
    if (initial.isErr()) throw initial.error;
    expect(initial.value.step).toBe(1);
    expect(initial.value.tools.map((entry) => entry.name)).toEqual(["original"]);
    expect(starts).toBe(1);
    const candidate = await execution.host.prepareContinuation({
      attemptId: execution.attemptId,
      scopeId: initial.value.scopeId,
      signal: execution.abort.signal,
    });
    if (candidate.isErr()) throw candidate.error;
    expect(candidate.value.step).toBe(2);
    expect(candidate.value.tools.map((entry) => entry.name)).toEqual(["refreshed"]);
    expect(beforeSteps).toEqual([1, 2]);
    expect(starts).toBe(1);
    const begun = await execution.host.beginContinuation({
      attemptId: execution.attemptId,
      scopeId: candidate.value.scopeId,
      signal: execution.abort.signal,
    });
    expect(begun.isOk()).toBe(true);
    expect(starts).toBe(2);
    expect(
      (
        await execution.host.beginContinuation({
          attemptId: execution.attemptId,
          scopeId: candidate.value.scopeId,
          signal: execution.abort.signal,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await execution.host.prepareContinuation({
          attemptId: execution.attemptId,
          scopeId: initial.value.scopeId,
          signal: execution.abort.signal,
        })
      ).isErr(),
    ).toBe(true);
    expect(starts).toBe(2);
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
  });

  test("a failed continuation candidate does not consume a step and cannot activate a stale scope", async () => {
    const adapter = new ControlledAdapter();
    const beforeSteps: number[] = [];
    let rejectCandidate = true;
    let starts = 0;
    const agent = new AgentExecutor({
      system: "test",
      adapter,
      beforeStep({ step }) {
        beforeSteps.push(step);
        if (step === 2 && rejectCandidate) throw new Error("candidate preparation rejected");
      },
    });
    agent.subscribe((event) => {
      if (event.type === "turn_start") starts += 1;
    });
    const run = agent.prompt("question");
    const execution = await adapter.created.promise;
    await execution.started.promise;
    const initial = await execution.host.prepareContext({
      attemptId: execution.attemptId,
      messages: execution.initialMessages,
      step: 1,
      signal: execution.abort.signal,
    });
    if (initial.isErr()) throw initial.error;
    expect(
      (
        await execution.host.prepareContinuation({
          attemptId: execution.attemptId,
          scopeId: "unknown",
          signal: execution.abort.signal,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await execution.host.prepareContinuation({
          attemptId: execution.attemptId,
          scopeId: initial.value.scopeId,
          signal: execution.abort.signal,
        })
      ).isErr(),
    ).toBe(true);
    expect(starts).toBe(1);
    rejectCandidate = false;
    const candidate = await execution.host.prepareContinuation({
      attemptId: execution.attemptId,
      scopeId: initial.value.scopeId,
      signal: execution.abort.signal,
    });
    if (candidate.isErr()) throw candidate.error;
    expect(candidate.value.step).toBe(2);
    expect(beforeSteps).toEqual([1, 2, 2]);
    expect(starts).toBe(1);
    expect(
      (
        await execution.host.beginContinuation({
          attemptId: execution.attemptId,
          scopeId: initial.value.scopeId,
          signal: execution.abort.signal,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await execution.host.beginContinuation({
          attemptId: "wrong-attempt",
          scopeId: candidate.value.scopeId,
          signal: execution.abort.signal,
        })
      ).isErr(),
    ).toBe(true);
    expect(
      (
        await execution.host.beginContinuation({
          attemptId: execution.attemptId,
          scopeId: candidate.value.scopeId,
          signal: execution.abort.signal,
        })
      ).isOk(),
    ).toBe(true);
    expect(starts).toBe(2);
    execution.emit({ type: "terminal", outcome: { status: "completed" } });
    await run;
    expect(
      (
        await execution.host.beginContinuation({
          attemptId: execution.attemptId,
          scopeId: candidate.value.scopeId,
          signal: execution.abort.signal,
        })
      ).isErr(),
    ).toBe(true);
  });

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
          outputSchema: z.number(),
          strict: true,
          providerOptions: { openai: { deferLoading: false } },
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
    expect(prepared.value.step).toBe(1);
    expect(prepared.value.tools[0]?.strict).toBe(true);
    expect(prepared.value.tools[0]?.providerOptions).toEqual({ openai: { deferLoading: false } });
    expect(JSON.parse(prepared.value.tools[0]?.outputSchemaJson ?? "null")).toMatchObject({
      type: "number",
    });
    expect(prepared.value.tools[0]).not.toHaveProperty("execute");
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
