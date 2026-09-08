import type {
  ResponsesClientEvent,
  ResponsesServerEvent,
} from "openai/resources/responses/responses";
import { describe, expect, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AiSdkAgentAdapter } from "../ai-sdk/adapter";
import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";
import {
  AgentAdapterFailure,
  type AgentAdapter,
  type AgentExecutionEvent,
  type AgentExecution,
} from "../../agent-adapter";
import { ToolExpansion } from "../../tool-call-expansion";
import { AgentExecutor } from "../../agent-executor";
import type { AgentExecutionHost } from "../../agent-execution-host";
import {
  OpenAIResponsesAgentAdapter,
  supportsOpenAINativeSteering,
  type OpenAIResponsesAdapterOptions,
} from "./adapter";
import {
  createResponsesDiagnostics,
  type ResponsesDiagnosticFields,
  type ResponsesDiagnostics,
} from "./diagnostics";
import type { OpenAIResponsesSocket } from "./socket";

class Mailbox<T> {
  private values: T[] = [];
  private readers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;
  push(value: T) {
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value });
    else this.values.push(value);
  }
  close() {
    this.closed = true;
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
  }
  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.closed) return { done: true, value: undefined };
    return await new Promise((resolve) => this.readers.push(resolve));
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}

class SocketFixture implements OpenAIResponsesSocket {
  readonly events = new Mailbox<ResultType<ResponsesServerEvent, AgentAdapterFailure>>();
  readonly sent: Record<string, unknown>[] = [];
  closeFailure: Panic | undefined;
  onClose: (() => void) | undefined;
  private readonly outgoing = new Mailbox<Record<string, unknown>>();
  send(payload: ResponsesClientEvent) {
    const value = { ...payload };
    this.sent.push(value);
    this.outgoing.push(value);
    return Result.ok(undefined);
  }
  close() {
    this.events.close();
    const onClose = this.onClose;
    this.onClose = undefined;
    onClose?.();
    if (this.closeFailure) throw this.closeFailure;
  }
  emit(value: object) {
    this.events.push(Result.ok(value as ResponsesServerEvent));
  }
  async nextSend() {
    return (await this.outgoing.next()).value;
  }
  created(id: string, previous?: string) {
    this.emit({
      type: "response.created",
      response: { id, previous_response_id: previous, status: "in_progress", output: [] },
    });
  }
  finished(id: string, text: string, steered = false, output?: object[]) {
    this.emit({
      type: steered ? "response.incomplete" : "response.completed",
      response: {
        id,
        status: steered ? "incomplete" : "completed",
        incomplete_details: steered ? { reason: "steered" } : undefined,
        output: output ?? [
          {
            type: "message",
            id: `${id}-message`,
            role: "assistant",
            content: [{ type: "output_text", text }],
          },
        ],
      },
    });
  }
  accepted(parent: string, id = "s1") {
    this.emit({ type: "response.steer.accepted", steer: { id, previous_response_id: parent } });
  }
}

function fixture(
  options: Partial<ConstructorParameters<typeof AgentExecutor>[0]> = {},
  nativeOptions: Partial<OpenAIResponsesAdapterOptions> = {},
) {
  const socket = new SocketFixture();
  const events = new Mailbox<AgentExecutionEvent>();
  const allEvents: AgentExecutionEvent[] = [];
  let currentExecution: AgentExecution | undefined;
  const native = new OpenAIResponsesAgentAdapter({
    model: "gpt-6-astra",
    transport: "websocket",
    nativeToolSearch: true,
    connect: async () => Result.ok(socket),
    ...nativeOptions,
  });
  const adapter: AgentAdapter<AgentExecutionHost> = {
    createExecution(context) {
      const execution = native.createExecution(context);
      currentExecution = execution;
      return {
        attemptId: execution.attemptId,
        get capabilities() {
          return execution.capabilities;
        },
        events: {
          async *[Symbol.asyncIterator]() {
            for await (const event of execution.events) {
              allEvents.push(event);
              yield event;
              events.push(event);
            }
          },
        },
        start: () => execution.start(),
        submitInput: (input) => execution.submitInput(input),
        interrupt: () => execution.interrupt(),
        cancel: () => execution.cancel(),
        dispose: () => execution.dispose(),
      };
    },
  };
  const retained: string[] = [];
  const agent = new AgentExecutor({
    system: "test",
    ...options,
    adapter,
    recoveryCheckpointHandler(_messages, ids) {
      retained.push(...ids);
    },
  });
  async function observed(type: AgentExecutionEvent["type"]) {
    for await (const event of events) if (event.type === type) return event;
    throw new Error(`No ${type} event`);
  }
  return {
    socket,
    agent,
    retained,
    observed,
    allEvents,
    getExecution: () => {
      if (!currentExecution) throw new Error("Execution has not started");
      return currentExecution;
    },
  };
}

function hasText(agent: AgentExecutor, text: string) {
  return agent.state.messages.some(
    (message) => message.role === "user" && message.content === text,
  );
}

function diagnosticFixture(
  flush: () => Promise<void> = async () => {},
  writeLog: (event: string) => void = () => {},
) {
  const logs: Array<{ event: string; fields: ResponsesDiagnosticFields; level: string }> = [];
  const base = createResponsesDiagnostics(
    {
      provider: "openai",
      model: "gpt-6-astra",
      requestId: "request-test",
      sessionId: "session-test",
    },
    (level, event, fields) => {
      logs.push({ level, event, fields });
      writeLog(event);
    },
  );
  const scoped = (diagnostics: ResponsesDiagnostics): ResponsesDiagnostics => ({
    ...diagnostics,
    withContext: (context) => scoped(diagnostics.withContext(context)),
    flush,
  });
  return { logs, diagnostics: scoped(base) };
}

describe("OpenAI Responses native execution", () => {
  for (const [model, steering] of [
    ["gpt-6-astra", "native"],
    ["gpt-5.4", "boundary"],
  ] as const)
    test(`logs ${steering} capability before any input delivery on ${model}`, async () => {
      const { diagnostics, logs } = diagnosticFixture();
      const { socket, agent } = fixture({}, { model, diagnostics });
      const run = agent.prompt("private prompt content");
      await socket.nextSend();
      socket.created("r1");
      socket.finished("r1", "private response content");
      await run;
      expect(logs.find((log) => log.event === "execution.started")).toMatchObject({
        fields: {
          requestId: "request-test",
          sessionId: "session-test",
          attemptId: expect.any(String),
          model,
          transport: "websocket",
          steering,
        },
      });
      expect(logs.find((log) => log.event === "execution.finished")).toMatchObject({
        fields: { status: "completed" },
      });
      expect(JSON.stringify(logs)).not.toContain("private");
    });

  test("ordinary trace flush failures do not fail a completed response", async () => {
    let flushes = 0;
    const { diagnostics } = diagnosticFixture(async () => {
      flushes++;
      throw new Error("disk unavailable");
    });
    const { socket, agent } = fixture({}, { diagnostics });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    socket.finished("r1", "answer");
    await run;
    expect(flushes).toBe(1);
  });

  for (const socketFails of [false, true])
    test(`trace cleanup Panic preserves ${socketFails ? "socket cleanup" : "its own"} identity`, async () => {
      const flushPanic = new Panic({ message: "trace cleanup" });
      const socketPanic = new Panic({ message: "socket cleanup" });
      const { diagnostics } = diagnosticFixture(async () => {
        throw flushPanic;
      });
      const { socket, agent } = fixture({}, { diagnostics });
      if (socketFails) socket.closeFailure = socketPanic;
      const run = agent.prompt("question").then(
        () => undefined,
        (error: unknown) => error,
      );
      await socket.nextSend();
      socket.created("r1");
      socket.finished("r1", "answer");
      expect(await run).toBe(socketFails ? socketPanic : flushPanic);
    });

  test("original execution Panic wins over trace flush Panic", async () => {
    const original = new Panic({ message: "original" });
    const cleanup = new Panic({ message: "trace cleanup" });
    const { diagnostics } = diagnosticFixture(async () => {
      throw cleanup;
    });
    const { agent } = fixture(
      {},
      {
        diagnostics,
        connect: async () => {
          throw original;
        },
      },
    );
    const error = await agent.prompt("question").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBe(original);
  });

  for (const failureSource of ["none", "execution", "socket", "flush"] as const)
    test(`terminal logging Panic settles event consumption after ${failureSource} failure`, async () => {
      const original = new Panic({ message: "original failure" });
      const loggerPanic = new Panic({ message: "terminal logger failure" });
      const { diagnostics, logs } = diagnosticFixture(
        async () => {
          if (failureSource === "flush") throw original;
        },
        (event) => {
          if (event === "execution.finished") throw loggerPanic;
        },
      );
      const { socket, agent, allEvents } = fixture(
        {},
        {
          diagnostics,
          ...(failureSource === "execution"
            ? {
                connect: async () => {
                  throw original;
                },
              }
            : {}),
        },
      );
      if (failureSource === "socket") socket.closeFailure = original;
      const run = agent.prompt("question").then(
        () => undefined,
        (error: unknown) => error,
      );
      if (failureSource !== "execution") {
        await socket.nextSend();
        socket.created("r1");
        socket.finished("r1", "answer");
      }
      const expected = failureSource === "none" ? loggerPanic : original;
      expect(await run).toBe(expected);
      const terminal = allEvents.find((event) => event.type === "terminal");
      expect(terminal).toMatchObject({ type: "terminal", outcome: { status: "failed" } });
      if (terminal?.type === "terminal" && terminal.outcome.status === "failed")
        expect(terminal.outcome.error.cause).toBe(expected);
      expect(logs.filter((log) => log.event === "execution.finished")).toHaveLength(1);
      expect(agent.state.isStreaming).toBe(false);
    });

  test("ordinary terminal logger failure does not change completion", async () => {
    const { diagnostics } = diagnosticFixture(undefined, (event) => {
      if (event === "execution.finished") throw new Error("log sink unavailable");
    });
    const { socket, agent, allEvents } = fixture({}, { diagnostics });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    socket.finished("r1", "answer");
    await run;
    expect(allEvents.find((event) => event.type === "terminal")).toMatchObject({
      outcome: { status: "completed" },
    });
  });

  for (const control of ["cancel", "interrupt"] as const)
    for (const failureKind of ["panic", "ordinary"] as const)
      test(`${control} always closes the socket when its diagnostic throws ${failureKind}`, async () => {
        const error =
          failureKind === "panic"
            ? new Panic({ message: "control log failed" })
            : new Error("log sink unavailable");
        const { diagnostics, logs } = diagnosticFixture(undefined, (event) => {
          if (event === `execution.${control}`) throw error;
        });
        const { socket, agent, getExecution, allEvents } = fixture({}, { diagnostics });
        let closed = false;
        socket.onClose = () => {
          closed = true;
        };
        const run = agent.prompt("question").then(
          () => undefined,
          (error: unknown) => error,
        );
        await socket.nextSend();
        expect((await getExecution()[control]()).isOk()).toBe(true);
        expect(await run).toBe(failureKind === "panic" ? error : undefined);
        expect(closed).toBe(true);
        expect(allEvents.find((event) => event.type === "terminal")).toMatchObject({
          outcome: {
            status:
              failureKind === "panic"
                ? "failed"
                : control === "cancel"
                  ? "cancelled"
                  : "interrupted",
          },
        });
        expect(logs.filter((log) => log.event === "execution.finished")).toHaveLength(1);
      });

  for (const fallbackFails of [false, true])
    for (const flushFails of [false, true])
      test(`fallback waits for diagnostic cleanup with fallback failure=${fallbackFails}, flush failure=${flushFails}`, async () => {
        const original = new Panic({ message: "fallback execution failed" });
        const cleanup = new Panic({ message: "trace flush failed" });
        const terminalLog = new Panic({ message: "terminal log failed" });
        const flushStarted = Promise.withResolvers<void>();
        const releaseFlush = Promise.withResolvers<void>();
        const failure = new AgentAdapterFailure({
          reason: "unavailable",
          replaySafety: "reconcile",
          message: "fallback failure",
          cause: original,
        });
        const fallback: AgentAdapter<AgentExecutionHost> = {
          createExecution({ attemptId }) {
            return {
              attemptId,
              capabilities: { steering: "boundary", followUp: "boundary", interruption: "restart" },
              events: {
                async *[Symbol.asyncIterator]() {
                  yield {
                    attemptId,
                    sequence: 0,
                    type: "terminal" as const,
                    outcome: fallbackFails
                      ? { status: "failed" as const, error: failure }
                      : { status: "completed" as const },
                  };
                },
              },
              start: () => Result.ok(undefined),
              submitInput: () => Result.err(failure),
              interrupt: async () => Result.ok(undefined),
              cancel: async () => Result.ok(undefined),
              dispose: async () => Result.ok(undefined),
            };
          },
        };
        const { diagnostics, logs } = diagnosticFixture(
          async () => {
            flushStarted.resolve();
            await releaseFlush.promise;
            if (flushFails) throw cleanup;
          },
          (event) => {
            if (event === "execution.finished") throw terminalLog;
          },
        );
        const { agent, allEvents } = fixture(
          {},
          {
            diagnostics,
            fallback,
            transport: "auto",
            connect: async () =>
              Result.err(
                new AgentAdapterFailure({
                  reason: "unavailable",
                  replaySafety: "safe",
                  message: "upgrade rejected",
                }),
              ),
          },
        );
        const run = agent.prompt("question").then(
          () => undefined,
          (error: unknown) => error,
        );
        await flushStarted.promise;
        expect(allEvents.some((event) => event.type === "terminal")).toBe(false);
        releaseFlush.resolve();
        const expected = fallbackFails ? original : flushFails ? cleanup : terminalLog;
        expect(await run).toBe(expected);
        expect(logs.filter((log) => log.event === "execution.finished")).toHaveLength(1);
        expect(allEvents.find((event) => event.type === "terminal")).toMatchObject({
          outcome: { status: "failed" },
        });
      });

  test("gates steering to exact Astra and compatible execution settings", () => {
    const eligible = { model: "gpt-6-astra", transport: "websocket" as const };
    expect(supportsOpenAINativeSteering(eligible, undefined)).toBe(true);
    for (const model of ["gpt-6-astra-preview", "gpt-6", "gpt-5.4", "openai/gpt-6-astra"])
      expect(supportsOpenAINativeSteering({ ...eligible, model }, undefined)).toBe(false);
    expect(
      supportsOpenAINativeSteering({ ...eligible, executionMode: "multi-agent" }, undefined),
    ).toBe(false);
    for (const openai of [
      { conversation: "c1" },
      { contextManagement: [{ type: "compaction" }] },
      { compactionTrigger: 100 },
    ])
      expect(supportsOpenAINativeSteering(eligible, { openai })).toBe(false);
  });

  for (const steered of [false, true])
    test(`acceptance waits for successor commitment after parent ${steered ? "incomplete steered" : "normal completion"}`, async () => {
      const { socket, agent, retained, observed } = fixture();
      const run = agent.prompt("question");
      expect((await socket.nextSend()).type).toBe("response.create");
      const inputId = agent.steer("correction");
      expect(socket.sent).toHaveLength(1);
      socket.created("r1");
      expect(await socket.nextSend()).toMatchObject({
        type: "response.steer",
        previous_response_id: "r1",
      });
      socket.accepted("r1");
      await observed("delivery");
      expect(hasText(agent, "correction")).toBe(false);
      expect(retained).toEqual([]);
      socket.finished("r1", "parent", steered);
      await observed("history-commit");
      expect(hasText(agent, "correction")).toBe(false);
      socket.created("r2", "r1");
      await observed("history-commit");
      expect(hasText(agent, "correction")).toBe(true);
      expect(retained).toEqual([inputId]);
      socket.finished("r2", "successor");
      await run;
      expect(socket.sent).toHaveLength(2);
      expect(agent.getQueuedSteeringIds()).toEqual([]);
    });

  test("normal parent completion before acceptance still waits for the automatic successor", async () => {
    const { socket, agent, observed } = fixture();
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    agent.steer("correction");
    await socket.nextSend();
    socket.finished("r1", "parent");
    await observed("history-commit");
    expect(socket.sent).toHaveLength(2);
    expect(agent.state.isStreaming).toBe(true);
    socket.accepted("r1");
    socket.created("r2", "r1");
    socket.finished("r2", "done");
    await run;
    expect(hasText(agent, "correction")).toBe(true);
    expect(socket.sent).toHaveLength(2);
  });

  test("steers during streamed output and keeps partial text out of canonical history", async () => {
    const { socket, agent, observed } = fixture();
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    socket.emit({ type: "response.output_text.delta", item_id: "m1", delta: "partial" });
    await observed("output");
    expect(agent.state.messages).toEqual([{ role: "user", content: "question" }]);
    agent.steer("correction");
    expect((await socket.nextSend()).type).toBe("response.steer");
    socket.accepted("r1");
    socket.finished("r1", "completed block", true);
    socket.created("r2", "r1");
    socket.finished("r2", "done");
    await run;
    expect(JSON.stringify(agent.state.messages)).not.toContain("partial");
    expect(hasText(agent, "correction")).toBe(true);
  });

  test("serializes multiple steering submissions against successive parents", async () => {
    const { socket, agent, retained, observed } = fixture();
    agent.setSteeringMode("one-at-a-time");
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    const first = agent.steer("first");
    await socket.nextSend();
    socket.accepted("r1");
    await observed("delivery");
    const second = agent.steer("second");
    expect(socket.sent).toHaveLength(2);
    socket.finished("r1", "parent", true);
    socket.created("r2", "r1");
    expect(await socket.nextSend()).toMatchObject({
      type: "response.steer",
      previous_response_id: "r2",
    });
    expect(retained).toEqual([first]);
    socket.accepted("r2", "s2");
    socket.finished("r2", "middle", true);
    socket.created("r3", "r2");
    socket.finished("r3", "done");
    await run;
    expect(retained).toEqual([first, second]);
  });

  test("returns a rejected steer for explicit boundary delivery", async () => {
    const { diagnostics, logs } = diagnosticFixture();
    const { socket, agent, retained } = fixture({}, { diagnostics });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    const id = agent.steer("correction");
    await socket.nextSend();
    socket.emit({
      type: "response.steer.failed",
      steer: { id: "s1", previous_response_id: "r1" },
      error: { message: "too late" },
    });
    socket.finished("r1", "parent");
    const continuation = await socket.nextSend();
    expect(continuation.type).toBe("response.create");
    expect(JSON.stringify(continuation.input)).toContain("correction");
    socket.created("r2");
    socket.finished("r2", "done");
    await run;
    expect(retained).toEqual([id]);
    expect(logs.find((log) => log.event === "execution.input_boundary")).toMatchObject({
      fields: {
        inputId: id,
        reason: "provider_rejected",
        steering: "boundary",
        attemptId: expect.any(String),
      },
    });
    expect(logs.find((log) => log.event === "execution.input_submitted")).toMatchObject({
      fields: { inputId: id, responseId: "r1", delivery: "native" },
    });
  });

  test("returns tool results once on the same socket despite repeated pending notifications", async () => {
    let calls = 0;
    const toolStarted = Promise.withResolvers<void>();
    const toolFinished = Promise.withResolvers<string>();
    const { socket, agent, retained } = fixture({
      tools: {
        lookup: tool({
          inputSchema: z.object({}),
          execute: async () => {
            calls++;
            toolStarted.resolve();
            return await toolFinished.promise;
          },
        }),
      },
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    const id = agent.steer("correction");
    await socket.nextSend();
    socket.accepted("r1");
    socket.finished("r1", "", false, [
      { type: "function_call", id: "fc1", call_id: "call1", name: "lookup", arguments: "{}" },
    ]);
    await toolStarted.promise;
    const pending = {
      type: "response.steer.pending",
      steer: { id: "s1", previous_response_id: "r1" },
      required_input: [{ type: "function_call_output", call_id: "call1" }],
    };
    socket.emit(pending);
    toolFinished.resolve("saved result");
    const continuation = await socket.nextSend();
    expect(continuation).toMatchObject({
      type: "response.create",
      previous_response_id: "r1",
      input: [
        { type: "function_call_output", call_id: "call1", output: JSON.stringify("saved result") },
      ],
    });
    socket.emit(pending);
    socket.emit(pending);
    socket.created("r2", "r1");
    socket.finished("r2", "done");
    await run;
    expect(calls).toBe(1);
    expect(socket.sent).toHaveLength(3);
    expect(retained).toEqual([id]);
  });

  for (const accepted of [false, true])
    test(`disconnect ${accepted ? "after acceptance" : "before acknowledgement"} preserves uncertain input`, async () => {
      const { socket, agent, retained, observed } = fixture();
      const run = agent.prompt("question").then(
        () => undefined,
        (error: unknown) => error,
      );
      await socket.nextSend();
      socket.created("r1");
      const id = agent.steer("correction");
      await socket.nextSend();
      if (accepted) {
        socket.accepted("r1");
        await observed("delivery");
      }
      socket.events.push(
        Result.err(
          new AgentAdapterFailure({
            reason: "unavailable",
            message: "disconnected",
            replaySafety: "reconcile",
          }),
        ),
      );
      const error = await run;
      expect(error).toBeInstanceOf(AgentAdapterFailure);
      expect(retained).toEqual([]);
      expect(agent.getQueuedSteeringIds()).toEqual([id]);
      expect(hasText(agent, "correction")).toBe(false);
      expect(socket.sent).toHaveLength(2);
    });
  for (const transport of ["auto", "websocket"] as const)
    test(`${transport} only permits configured fallback before connection establishment`, async () => {
      let fallbackStarts = 0;
      const fallback: AgentAdapter<AgentExecutionHost> = {
        createExecution(context) {
          return {
            attemptId: context.attemptId,
            capabilities: { steering: "boundary", followUp: "boundary", interruption: "restart" },
            events: {
              async *[Symbol.asyncIterator]() {
                yield {
                  attemptId: context.attemptId,
                  sequence: 0,
                  type: "history-commit" as const,
                  inputIds: [],
                  messages: [{ role: "assistant" as const, content: "fallback answer" }],
                };
                yield {
                  attemptId: context.attemptId,
                  sequence: 1,
                  type: "terminal" as const,
                  outcome: { status: "completed" as const },
                };
              },
            },
            start() {
              fallbackStarts++;
              return Result.ok(undefined);
            },
            submitInput() {
              return Result.err(
                new AgentAdapterFailure({
                  reason: "invalid-state",
                  message: "boundary only",
                  replaySafety: "safe",
                }),
              );
            },
            async interrupt() {
              return Result.ok(undefined);
            },
            async cancel() {
              return Result.ok(undefined);
            },
            async dispose() {
              return Result.ok(undefined);
            },
          };
        },
      };
      const error = new AgentAdapterFailure({
        reason: "unavailable",
        message: "upgrade rejected",
        replaySafety: "safe",
      });
      const { diagnostics, logs } = diagnosticFixture();
      const { agent } = fixture(
        {},
        { diagnostics, transport, fallback, connect: async () => Result.err(error) },
      );
      const outcome = await agent.prompt("question").then(
        () => "completed",
        (failure: unknown) => failure,
      );
      expect(fallbackStarts).toBe(transport === "auto" ? 1 : 0);
      const fallbackLogs = logs.filter((log) => log.event === "execution.fallback");
      expect(fallbackLogs).toHaveLength(transport === "auto" ? 1 : 0);
      if (transport === "auto")
        expect(fallbackLogs[0]).toMatchObject({
          level: "warn",
          fields: {
            reason: "unavailable",
            replaySafety: "safe",
            transport: "sse",
            steering: "boundary",
            requestId: "request-test",
            sessionId: "session-test",
            attemptId: expect.any(String),
          },
        });
      if (transport === "auto")
        expect(agent.state.messages.at(-1)?.content).toBe("fallback answer");
      else expect(outcome).toBe(error);
    });

  test("does not retry a transmitted response through fallback after disconnect", async () => {
    let fallbackStarts = 0;
    const fallback: AgentAdapter<AgentExecutionHost> = {
      createExecution() {
        fallbackStarts++;
        throw new Error("Unexpected fallback after send");
      },
    };
    const { socket, agent } = fixture({}, { transport: "auto", fallback });
    const run = agent.prompt("question").then(
      () => undefined,
      (error: unknown) => error,
    );
    await socket.nextSend();
    socket.events.push(
      Result.err(
        new AgentAdapterFailure({
          reason: "unavailable",
          message: "lost after send",
          replaySafety: "reconcile",
        }),
      ),
    );
    expect(await run).toBeInstanceOf(AgentAdapterFailure);
    expect(fallbackStarts).toBe(0);
    expect(socket.sent).toHaveLength(1);
  });

  test("changed tool authority sends steering at a fresh explicit boundary", async () => {
    const { socket, agent, observed, retained } = fixture({
      tools: {
        original: tool({ inputSchema: z.object({}), execute: () => "original" }),
        refreshed: tool({ inputSchema: z.object({}), execute: () => "refreshed" }),
      },
      beforeStep({ step }) {
        if (step === 2) agent.setActiveTools(new Set(["refreshed"]));
      },
    });
    agent.setActiveTools(new Set(["original"]));
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    const id = agent.steer("correction");
    const delivery = await observed("delivery");
    expect(delivery).toMatchObject({ status: "returned", inputIds: [id] });
    expect(socket.sent).toHaveLength(1);
    socket.finished("r1", "parent");
    const continuation = await socket.nextSend();
    expect(continuation.type).toBe("response.create");
    expect(continuation.tools).toMatchObject([{ name: "refreshed" }]);
    expect(JSON.stringify(continuation.input)).toContain("correction");
    socket.created("r2");
    socket.finished("r2", "done");
    await run;
    expect(retained).toEqual([id]);
  });

  test("accounts response usage once when a completed event is repeated while steering is pending", async () => {
    const { socket, agent, observed } = fixture();
    const usage: number[] = [];
    agent.subscribe((event) => {
      if (event.type === "agent_end") usage.push(event.totalUsage?.totalTokens ?? 0);
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    agent.steer("correction");
    await socket.nextSend();
    socket.accepted("r1");
    const completed = {
      type: "response.completed",
      response: {
        id: "r1",
        status: "completed",
        output: [
          {
            type: "message",
            id: "m1",
            role: "assistant",
            content: [{ type: "output_text", text: "parent" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    };
    socket.emit(completed);
    await observed("history-commit");
    socket.emit(completed);
    socket.created("r2", "r1");
    socket.emit({
      type: "response.completed",
      response: {
        id: "r2",
        status: "completed",
        output: [
          {
            type: "message",
            id: "m2",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 },
      },
    });
    await run;
    expect(usage).toEqual([42]);
  });

  test("fails an uncorrelated steering acceptance without acknowledging the local input", async () => {
    const { socket, agent, retained } = fixture();
    const run = agent.prompt("question").then(
      () => undefined,
      (error: unknown) => error,
    );
    await socket.nextSend();
    socket.created("r1");
    const id = agent.steer("correction");
    await socket.nextSend();
    socket.accepted("wrong-parent");
    expect(await run).toBeInstanceOf(AgentAdapterFailure);
    expect(retained).toEqual([]);
    expect(agent.getQueuedSteeringIds()).toEqual([id]);
  });

  test("cancellation waits for tool cleanup and preserves a completed text block", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const { socket, agent, observed } = fixture({
      tools: {
        slow: tool({
          inputSchema: z.object({}),
          execute: async (_input, { abortSignal }) => {
            started.resolve();
            abortSignal?.addEventListener("abort", () => aborted.resolve(), { once: true });
            return await release.promise;
          },
        }),
      },
    });
    let completed = false;
    const run = agent.prompt("question").then(() => {
      completed = true;
    });
    await socket.nextSend();
    socket.created("r1");
    const text = {
      type: "message",
      id: "m1",
      role: "assistant",
      content: [{ type: "output_text", text: "complete block" }],
    };
    socket.emit({ type: "response.output_item.done", item: text });
    await observed("history-checkpoint");
    socket.finished("r1", "", false, [
      text,
      { type: "function_call", id: "fc1", call_id: "call1", name: "slow", arguments: "{}" },
    ]);
    await started.promise;
    agent.cancel();
    await aborted.promise;
    expect(completed).toBe(false);
    release.resolve("discarded on cancel");
    await run;
    expect(JSON.stringify(agent.state.messages)).toContain("complete block");
    expect(JSON.stringify(agent.state.messages)).not.toContain("call1");
    const before = JSON.stringify(agent.state.messages);
    socket.created("stale");
    socket.finished("stale", "late callback");
    expect(JSON.stringify(agent.state.messages)).toBe(before);
  });

  test("cancellation keeps a completed sibling tool exchange while another tool is pending", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const { socket, agent, observed } = fixture({
      tools: {
        fast: tool({ inputSchema: z.object({}), execute: () => "retained result" }),
        slow: tool({
          inputSchema: z.object({}),
          execute: async (_input, { abortSignal }) => {
            started.resolve();
            abortSignal?.addEventListener("abort", () => aborted.resolve(), { once: true });
            return await release.promise;
          },
        }),
      },
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    socket.finished("r1", "", false, [
      { type: "function_call", id: "fc-fast", call_id: "fast-call", name: "fast", arguments: "{}" },
      { type: "function_call", id: "fc-slow", call_id: "slow-call", name: "slow", arguments: "{}" },
    ]);
    await started.promise;
    while (true) {
      const checkpoint = await observed("history-checkpoint");
      if (
        checkpoint.type === "history-checkpoint" &&
        JSON.stringify(checkpoint.messages).includes("retained result")
      )
        break;
    }
    agent.cancel();
    await aborted.promise;
    release.resolve("discarded");
    await run;
    const history = JSON.stringify(agent.state.messages);
    expect(history).toContain("retained result");
    expect(history).toContain("fast-call");
    expect(history).not.toContain("slow-call");
  });

  test("ordinary tool continuation reuses its parent with freshly prepared settings", async () => {
    const { socket, agent } = fixture({
      tools: { lookup: tool({ inputSchema: z.object({}), execute: () => "answer" }) },
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    socket.finished("r1", "", false, [
      { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "{}" },
    ]);
    expect(await socket.nextSend()).toMatchObject({
      type: "response.create",
      model: "gpt-6-astra",
      previous_response_id: "r1",
      input: [{ type: "function_call_output", call_id: "call", output: '"answer"' }],
    });
    socket.created("r2", "r1");
    socket.finished("r2", "done");
    await run;
    expect(agent.state.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  });

  test("recovers once from a length limit through an explicit continuation", async () => {
    const { socket, agent } = fixture();
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    const output = [
      {
        type: "message",
        id: "m1",
        role: "assistant",
        content: [{ type: "output_text", text: "partial completed answer" }],
      },
    ];
    socket.emit({
      type: "response.incomplete",
      response: {
        id: "r1",
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output,
      },
    });
    const continuation = await socket.nextSend();
    expect(continuation).toMatchObject({ type: "response.create", previous_response_id: "r1" });
    expect(JSON.stringify(continuation.input)).toContain("Continue");
    socket.created("r2", "r1");
    socket.finished("r2", "finished");
    await run;
  });

  test("preserves Panic identity when connection construction fails", async () => {
    const panic = new Panic({ message: "defect", cause: new Error("defect") });
    const { agent } = fixture(
      {},
      {
        connect: async () => {
          throw panic;
        },
      },
    );
    const error = await agent.prompt("question").then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBe(panic);
  });

  test("controls accepted during connection establishment survive automatic SSE fallback", async () => {
    const connecting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fallback = new AiSdkAgentAdapter({
      system: "test",
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t" });
              controller.enqueue({ type: "text-delta", id: "t", delta: "fallback answer" });
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: {
                  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 0, text: 0, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        }),
      }),
    });
    const { agent, socket, retained } = fixture(
      {},
      {
        transport: "auto",
        fallback,
        connect: async () => {
          connecting.resolve();
          await release.promise;
          return Result.err(
            new AgentAdapterFailure({
              reason: "unavailable",
              message: "upgrade refused",
              replaySafety: "safe",
            }),
          );
        },
      },
    );
    const run = agent.prompt("question");
    await connecting.promise;
    const id = agent.steer("early correction");
    release.resolve();
    await run;
    expect(
      agent.state.messages.filter(
        (message) => message.role === "user" && message.content === "early correction",
      ),
    ).toHaveLength(1);
    expect(retained).toEqual([id]);
    expect(socket.sent).toHaveLength(0);
  });
  for (const termination of ["failure", "cancel", "panic"] as const)
    test(`cleanup Panic takes precedence over ${termination} except an original Panic`, async () => {
      const { socket, agent } = fixture();
      const cleanupPanic = new Panic({ message: "socket cleanup defect" });
      const executionPanic = new Panic({ message: "execution defect" });
      const run = agent.prompt("question").then(
        () => undefined,
        (error: unknown) => error,
      );
      await socket.nextSend();
      socket.closeFailure = cleanupPanic;
      if (termination === "cancel") agent.cancel();
      else
        socket.events.push(
          Result.err(
            new AgentAdapterFailure({
              reason: "unavailable",
              message: "connection failed",
              replaySafety: "reconcile",
              ...(termination === "panic" ? { cause: executionPanic } : {}),
            }),
          ),
        );
      expect(await run).toBe(termination === "panic" ? executionPanic : cleanupPanic);
    });

  test("conversation-bound boundary steering does not resend stored assistant items or add a previous response ID", async () => {
    const { socket, agent } = fixture({
      providerOptions: { openai: { conversation: "conversation" } },
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    agent.steer("next instruction");
    socket.finished("r1", "stored answer");
    const next = await socket.nextSend();
    expect(next.conversation).toBe("conversation");
    expect(next.previous_response_id).toBeUndefined();
    expect(JSON.stringify(next.input)).not.toContain("r1-message");
    expect(JSON.stringify(next.input)).not.toContain("stored answer");
    expect(JSON.stringify(next.input)).toContain("next instruction");
    socket.created("r2");
    socket.finished("r2", "done");
    await run;
  });

  test("steering during an explicit continuation waits for that response creation", async () => {
    const { socket, agent } = fixture({
      tools: { lookup: tool({ inputSchema: z.object({}), execute: () => "answer" }) },
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    socket.finished("r1", "", false, [
      { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "{}" },
    ]);
    await socket.nextSend();
    agent.steer("new correction");
    socket.created("r2", "r1");
    expect(await socket.nextSend()).toMatchObject({
      type: "response.steer",
      previous_response_id: "r2",
    });
    socket.accepted("r2");
    socket.finished("r2", "parent", true);
    socket.created("r3", "r2");
    socket.finished("r3", "done");
    await run;
  });

  test("a failed accepted steer waits for the already transmitted tool successor", async () => {
    const { socket, agent, observed } = fixture({
      tools: { lookup: tool({ inputSchema: z.object({}), execute: () => "answer" }) },
    });
    agent.setSteeringMode("all");
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    agent.steer("returned correction");
    await socket.nextSend();
    socket.accepted("r1");
    socket.finished("r1", "", false, [
      { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "{}" },
    ]);
    await socket.nextSend();
    agent.steer("later correction");
    socket.emit({
      type: "response.steer.failed",
      steer: { id: "s1", previous_response_id: "r1" },
      error: { message: "cannot apply" },
    });
    while (true) {
      const event = await observed("delivery");
      if (event.type === "delivery" && event.status === "returned") break;
    }
    expect(socket.sent).toHaveLength(3);
    socket.created("r2", "r1");
    socket.finished("r2", "tool successor");
    const replay = await socket.nextSend();
    expect(replay.type).toBe("response.create");
    expect(JSON.stringify(replay.input)).toContain("returned correction");
    expect(JSON.stringify(replay.input)).toContain("later correction");
    socket.created("r3", "r2");
    socket.finished("r3", "done");
    await run;
    expect(socket.sent.filter((request) => request.type === "response.create")).toHaveLength(3);
  });

  test("accepted steering tool continuation includes normalized expansion children", async () => {
    const { socket, agent } = fixture({
      tools: {
        expand: tool({
          inputSchema: z.object({}),
          execute: () =>
            new ToolExpansion({ expanded: true }, [
              { toolCallId: "child-call", toolName: "child", input: {} },
            ]),
        }),
        child: tool({ inputSchema: z.object({}), execute: () => "child output" }),
      },
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    agent.steer("use those results");
    await socket.nextSend();
    socket.accepted("r1");
    socket.finished("r1", "", false, [
      { type: "function_call", id: "fc", call_id: "parent-call", name: "expand", arguments: "{}" },
    ]);
    const continuation = await socket.nextSend();
    expect(JSON.stringify(continuation.input)).toContain("child-call");
    expect(JSON.stringify(continuation.input)).toContain("child output");
    socket.created("r2", "r1");
    socket.finished("r2", "done");
    await run;
    expect(JSON.stringify(agent.state.messages)).toContain("child output");
  });
  test("a control admitted during socket cleanup runs once on a fresh attempt", async () => {
    const first = new SocketFixture();
    const second = new SocketFixture();
    let connections = 0;
    const { agent, retained } = fixture(
      {},
      { connect: async () => Result.ok(connections++ === 0 ? first : second) },
    );
    let inputId: string | undefined;
    first.onClose = () => {
      inputId = agent.steer("late correction");
    };
    const run = agent.prompt("question");
    await first.nextSend();
    first.created("r1");
    first.finished("r1", "first answer");
    const request = await Promise.race([
      second.nextSend(),
      run.then(() => {
        throw new Error("Run completed before executing late input");
      }),
    ]);
    expect(JSON.stringify(request.input)).toContain("late correction");
    second.created("r2");
    second.finished("r2", "late answer");
    await run;
    expect(connections).toBe(2);
    expect(retained).toEqual([inputId!]);
    expect(
      agent.state.messages.filter(
        (message) => message.role === "user" && message.content === "late correction",
      ),
    ).toHaveLength(1);
  });
  test("invalid tool arguments produce a host error while valid sibling calls still execute", async () => {
    const executed: string[] = [];
    const { socket, agent } = fixture({
      tools: {
        lookup: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: ({ query }) => {
            executed.push(query);
            return "valid sibling result";
          },
        }),
      },
    });
    const run = agent.prompt("question");
    await socket.nextSend();
    socket.created("r1");
    socket.finished("r1", "", false, [
      {
        type: "function_call",
        id: "bad-fc",
        call_id: "bad-call",
        name: "lookup",
        arguments: "not-json",
      },
      {
        type: "function_call",
        id: "good-fc",
        call_id: "good-call",
        name: "lookup",
        arguments: '{"query":"valid"}',
      },
    ]);
    const continuation = await socket.nextSend();
    expect(executed).toEqual(["valid"]);
    expect(continuation.previous_response_id).toBe("r1");
    expect(JSON.stringify(continuation.input)).toContain("bad-call");
    expect(JSON.stringify(continuation.input)).toContain("valid sibling result");
    socket.created("r2", "r1");
    socket.finished("r2", "done");
    await run;
    const results = agent.state.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content);
    const invalid = results.find(
      (part) => part.type === "tool-result" && part.toolCallId === "bad-call",
    );
    expect(invalid).toMatchObject({ type: "tool-result", output: { type: "error-text" } });
    expect(socket.sent).toHaveLength(2);
  });

  test("reports a delegated fallback disposal failure instead of clean retirement", async () => {
    const failure = new AgentAdapterFailure({
      reason: "unavailable",
      message: "fallback cleanup failed",
      replaySafety: "reconcile",
    });
    const fallback: AgentAdapter<AgentExecutionHost> = {
      createExecution({ attemptId }) {
        return {
          attemptId,
          capabilities: { steering: "boundary", followUp: "boundary", interruption: "restart" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                attemptId,
                sequence: 0,
                type: "terminal" as const,
                outcome: { status: "completed" as const },
              };
            },
          },
          start: () => Result.ok(undefined),
          submitInput: () => Result.err(failure),
          interrupt: async () => Result.ok(undefined),
          cancel: async () => Result.ok(undefined),
          dispose: async () => Result.err(failure),
        };
      },
    };
    const { agent } = fixture(
      {},
      {
        transport: "auto",
        fallback,
        connect: async () =>
          Result.err(
            new AgentAdapterFailure({
              reason: "unavailable",
              message: "upgrade refused",
              replaySafety: "safe",
            }),
          ),
      },
    );
    expect(
      await agent.prompt("question").then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toBe(failure);
  });
});

describe("native deferred tool loading", () => {
  test("search loads schemas through history while local authority and the request prefix stay stable", async () => {
    const selected = new Set(["find_tools"]);
    let calls = 0;
    const { agent, socket } = fixture({
      deferredToolNames: () => ["mcp_echo"],
      tools: {
        find_tools: tool({
          description: "Search deferred tools",
          inputSchema: z.object({ query: z.string() }),
          execute: () => {
            selected.add("mcp_echo");
            return { matches: [{ name: "mcp_echo" }] };
          },
        }),
        mcp_echo: tool({
          description: "Echo",
          inputSchema: z.object({ text: z.string() }),
          execute: ({ text }) => {
            calls++;
            return text;
          },
        }),
      },
      beforeStep: () => agent.setActiveTools(selected),
    });
    const run = agent.prompt("Find echo and use it");
    const first = await socket.nextSend();
    expect(first.tools).toEqual([
      expect.objectContaining({ type: "tool_search", execution: "client" }),
    ]);
    socket.created("search-response");
    socket.finished("search-response", "", false, [
      {
        type: "tool_search_call",
        id: "search-item",
        call_id: "search-call",
        execution: "client",
        status: "completed",
        arguments: { query: "echo" },
      },
    ]);
    const second = await socket.nextSend();
    expect(second.tools).toEqual(first.tools);
    expect(second.input).toContainEqual(
      expect.objectContaining({
        type: "tool_search_output",
        call_id: "search-call",
        tools: [
          expect.objectContaining({ type: "function", name: "mcp_echo", defer_loading: true }),
        ],
      }),
    );
    socket.created("echo-response");
    socket.finished("echo-response", "", false, [
      {
        type: "function_call",
        id: "echo-item",
        call_id: "echo-call",
        name: "mcp_echo",
        arguments: '{"text":"hello"}',
      },
    ]);
    const third = await socket.nextSend();
    expect(third.tools).toEqual(first.tools);
    expect(calls).toBe(1);
    socket.created("final-response");
    socket.finished("final-response", "done");
    await run;
    const result = agent.state.messages.find(
      (message) =>
        message.role === "tool" &&
        message.content.some(
          (part) => part.type === "tool-result" && part.toolCallId === "search-call",
        ),
    );
    expect(result).toMatchObject({
      content: [
        expect.objectContaining({
          providerOptions: {
            openai: {
              toolSearchTools: [expect.objectContaining({ name: "mcp_echo" })],
            },
          },
        }),
      ],
    });
  });

  test("unselected calls do not gain execution authority from the local catalog", async () => {
    let calls = 0;
    const { agent, socket } = fixture({
      deferredToolNames: () => ["hidden"],
      tools: {
        find_tools: tool({ inputSchema: z.object({}), execute: () => ({ matches: [] }) }),
        hidden: tool({
          inputSchema: z.object({}),
          execute: () => {
            calls++;
            return "bad";
          },
        }),
      },
    });
    agent.setActiveTools(new Set(["find_tools"]));
    const run = agent.prompt("test");
    await socket.nextSend();
    socket.created("r1");
    socket.finished("r1", "", false, [
      { type: "function_call", id: "i", call_id: "c", name: "hidden", arguments: "{}" },
    ]);
    await socket.nextSend();
    expect(calls).toBe(0);
    socket.created("r2");
    socket.finished("r2", "done");
    await run;
  });
});

test("accepted steering across a delayed search refreshes authority and returns native search output", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const selected = new Set(["find_tools"]);
  let calls = 0;
  const { agent, socket } = fixture({
    deferredToolNames: () => ["mcp_echo"],
    tools: {
      find_tools: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async () => {
          started.resolve();
          await release.promise;
          selected.add("mcp_echo");
          return { matches: [{ name: "mcp_echo" }] };
        },
      }),
      mcp_echo: tool({
        inputSchema: z.object({}),
        execute: () => {
          calls++;
          return "hello";
        },
      }),
    },
    beforeStep: () => agent.setActiveTools(selected),
  });
  const run = agent.prompt("Find echo");
  const first = await socket.nextSend();
  socket.created("r1");
  agent.steer("Use the result");
  expect((await socket.nextSend()).type).toBe("response.steer");
  socket.accepted("r1");
  socket.finished("r1", "", true, [
    {
      type: "tool_search_call",
      id: "search",
      call_id: "s1",
      execution: "client",
      status: "completed",
      arguments: { query: "echo" },
    },
  ]);
  await started.promise;
  socket.emit({
    type: "response.steer.pending",
    steer: { id: "s1", previous_response_id: "r1" },
    required_input: [{ type: "tool_search_output", call_id: "s1" }],
  });
  release.resolve();
  const continuation = await socket.nextSend();
  expect(continuation.tools).toEqual(first.tools);
  expect(continuation.input).toContainEqual(
    expect.objectContaining({ type: "tool_search_output", call_id: "s1" }),
  );
  socket.created("r2", "r1");
  socket.finished("r2", "", false, [
    { type: "function_call", id: "echo", call_id: "e1", name: "mcp_echo", arguments: "{}" },
  ]);
  await socket.nextSend();
  expect(calls).toBe(1);
  socket.created("r3");
  socket.finished("r3", "done");
  await run;
  expect(hasText(agent, "Use the result")).toBe(true);
});

test("inherited native seed is committed to canonical history and remains stable on the next step", async () => {
  const { agent, socket } = fixture({
    deferredToolNames: () => ["echo"],
    tools: {
      find_tools: tool({ inputSchema: z.object({}), execute: () => ({ matches: [] }) }),
      echo: tool({ inputSchema: z.object({}), execute: () => "echo" }),
    },
  });
  agent.setActiveTools(new Set(["find_tools", "echo"]));
  const run = agent.prompt("Resume");
  const first = await socket.nextSend();
  expect(first.input).toContainEqual(expect.objectContaining({ type: "additional_tools" }));
  expect(agent.state.messages[0]?.providerOptions?.openai?.toolSearchSeed).toBeDefined();
  socket.created("r1");
  socket.finished("r1", "", false, [
    { type: "function_call", id: "echo", call_id: "e1", name: "echo", arguments: "{}" },
  ]);
  const second = await socket.nextSend();
  expect(second.tools).toEqual(first.tools);
  socket.created("r2");
  socket.finished("r2", "done");
  await run;
  expect(agent.state.messages[0]?.providerOptions?.openai?.toolSearchSeed).toBeDefined();
});

test("native search snapshots use original results even when the model view is truncated", async () => {
  const selected = new Set(["find_tools"]);
  const { agent, socket } = fixture({
    deferredToolNames: () => ["echo"],
    tools: {
      find_tools: tool({
        inputSchema: z.object({}),
        execute: () => {
          selected.add("echo");
          return { matches: [{ name: "echo" }] };
        },
      }),
      echo: tool({ inputSchema: z.object({}), execute: () => "echo" }),
    },
    beforeStep: () => agent.setActiveTools(selected),
    normalizeToolResultOutput: async () => ({ type: "text", value: "Truncated; see artifact" }),
  });
  const run = agent.prompt("Search");
  const first = await socket.nextSend();
  socket.created("r1");
  socket.finished("r1", "", false, [
    {
      type: "tool_search_call",
      id: "i",
      call_id: "s",
      execution: "client",
      status: "completed",
      arguments: {},
    },
  ]);
  const next = await socket.nextSend();
  expect(next.tools).toEqual(first.tools);
  expect(next.input).toContainEqual(
    expect.objectContaining({
      type: "tool_search_output",
      tools: [expect.objectContaining({ name: "echo" })],
    }),
  );
  expect(next.input).not.toContainEqual(expect.objectContaining({ type: "additional_tools" }));
  socket.created("r2");
  socket.finished("r2", "done");
  await run;
});
