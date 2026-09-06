import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  AgentAdapterFailure,
  AgentAttempt,
  type AgentAdapter,
  type AgentExecution,
  type AgentExecutionEvent,
  type AgentHostServices,
  type AgentInput,
} from "../agent-adapter";

function input(id: string): AgentInput {
  return { id, intent: "steer", messages: [{ role: "user", content: id }] };
}

function event(
  sequence: number,
  payload: AgentExecutionEvent extends infer Event
    ? Event extends AgentExecutionEvent
      ? Omit<Event, "attemptId" | "sequence">
      : never
    : never,
): AgentExecutionEvent {
  return { attemptId: "first", sequence, ...payload };
}

function fixture(host: AgentHostServices) {
  const entries: AgentExecutionEvent[] = [];
  const submissions: AgentInput[] = [];
  let available = Promise.withResolvers<void>();
  let started = false;
  let ended = false;
  let sequence = 0;
  const adapter: AgentAdapter = {
    createExecution({ attemptId }) {
      const execution: AgentExecution = {
        attemptId,
        capabilities: { steering: "native", followUp: "boundary", interruption: "native" },
        events: {
          async *[Symbol.asyncIterator]() {
            while (!ended || entries.length > 0) {
              const next = entries.shift();
              if (next) {
                yield next;
                continue;
              }
              await available.promise;
              available = Promise.withResolvers<void>();
            }
          },
        },
        start() {
          started = true;
          return Result.ok(undefined);
        },
        submitInput(value) {
          submissions.push(value);
          return Result.ok(undefined);
        },
        async interrupt() {
          return Result.ok(undefined);
        },
        async cancel() {
          return Result.ok(undefined);
        },
        async dispose() {
          ended = true;
          available.resolve();
          return Result.ok(undefined);
        },
      };
      return execution;
    },
  };
  return {
    execution: adapter.createExecution({ attemptId: "first", messages: [], host }),
    submissions,
    get started() {
      return started;
    },
    emit(payload: Parameters<typeof event>[1]) {
      if (!started) throw new Error("Fixture execution is dormant");
      entries.push(event(sequence++, payload));
      available.resolve();
    },
  };
}

const host: AgentHostServices = {
  async boundary() {
    return Result.ok({ action: "complete", messages: [] });
  },
  async prepareContext() {
    return Result.ok({
      scopeId: "scope",
      system: "",
      messages: [],
      canonicalMessages: [],
      tools: [],
    });
  },
  async executeTools() {
    return Result.err(
      new AgentAdapterFailure({
        reason: "invalid-state",
        message: "No authorized tools",
        replaySafety: "safe",
      }),
    );
  },
};

describe("agent adapter ownership", () => {
  test("caller mutation cannot rewrite queued input, prepared content, or canonical history", () => {
    const attempt = new AgentAttempt("first");
    const original = {
      id: "a",
      intent: "steer",
      messages: [{ role: "user", content: "original" }],
    } satisfies AgentInput;
    attempt.register(original);
    original.messages[0]!.content = "changed";
    expect(attempt.pendingInputs[0]!.messages[0]!.content).toBe("original");
    const exposed = attempt.boundaryInputs[0]!.messages[0]!;
    exposed.content = "changed through getter";
    expect(attempt.pendingInputs[0]!.messages[0]!.content).toBe("original");
    attempt.reserve(["a"]);
    const prepared = {
      ...original,
      messages: [{ role: "user", content: "prepared" }],
    } satisfies AgentInput;
    attempt.prepared(prepared);
    prepared.messages[0]!.content = "changed";
    const messages = [{ role: "user", content: "prepared" }] satisfies AgentInput["messages"];
    expect(
      attempt.accept(event(0, { type: "history-commit", inputIds: ["a"], messages })).isOk(),
    ).toBe(true);
    messages[0]!.content = "changed after commit";
    attempt.messages[0]!.content = "changed through history getter";
    expect(attempt.messages[0]!.content).toBe("prepared");
  });

  test("checkpoints remain separate from canonical history and host rebase keeps accepted input", () => {
    const attempt = new AgentAttempt("first");
    attempt.register(input("a"));
    attempt.reserve(["a"]);
    const messages = [
      { role: "assistant", content: "replay-safe draft" },
    ] satisfies AgentInput["messages"];
    expect(attempt.accept(event(0, { type: "history-checkpoint", messages })).isOk()).toBe(true);
    expect(attempt.messages).toEqual([]);
    expect(attempt.rebase([{ role: "user", content: "compacted" }]).isOk()).toBe(true);
    expect(attempt.messages).toEqual([{ role: "user", content: "compacted" }]);
    expect(attempt.pendingInputs).toEqual([input("a")]);
    attempt.retire();
    expect(attempt.rebase([]).isErr()).toBe(true);
  });

  test("reserves in queue order and prevents boundary redelivery until definite return", () => {
    const attempt = new AgentAttempt("first");
    for (const id of ["a", "b", "c"]) expect(attempt.register(input(id)).isOk()).toBe(true);
    expect(attempt.reserve(["a", "b"]).isOk()).toBe(true);
    expect(attempt.boundaryInputs.map((value) => value.id)).toEqual(["c"]);
    expect(
      attempt
        .accept(event(0, { type: "delivery", inputIds: ["a"], status: "provider-owned" }))
        .isOk(),
    ).toBe(true);
    expect(
      attempt.accept(event(1, { type: "delivery", inputIds: ["b"], status: "returned" })).isOk(),
    ).toBe(true);
    expect(attempt.boundaryInputs.map((value) => value.id)).toEqual(["b", "c"]);
    expect(attempt.reserve(["a", "b"]).isErr()).toBe(true);
    expect(attempt.inputState("b")).toBe("returned");
  });

  test("separate commits cannot reorder inputs with the same intent", () => {
    const attempt = new AgentAttempt("first");
    attempt.register(input("a"));
    attempt.register(input("b"));
    attempt.reserve(["a", "b"]);
    expect(
      attempt
        .accept(
          event(0, {
            type: "history-commit",
            inputIds: ["b"],
            messages: input("b").messages,
          }),
        )
        .isErr(),
    ).toBe(true);
    expect(attempt.messages).toEqual([]);
    expect(attempt.inputState("a")).toBe("reserved");
    expect(attempt.inputState("b")).toBe("reserved");
    expect(
      attempt
        .accept(
          event(0, {
            type: "history-commit",
            inputIds: ["a"],
            messages: input("a").messages,
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      attempt
        .accept(
          event(1, {
            type: "history-commit",
            inputIds: ["b"],
            messages: input("b").messages,
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(attempt.messages).toEqual([...input("a").messages, ...input("b").messages]);
  });

  test("steering may precede an earlier follow-up while returned input retains its place", () => {
    const attempt = new AgentAttempt("first");
    attempt.register({ ...input("follow"), intent: "follow-up" });
    attempt.register(input("a"));
    attempt.register(input("b"));
    attempt.reserve(["a", "b"]);
    attempt.returnPrepared(["a"]);
    expect(
      attempt
        .accept(
          event(0, {
            type: "history-commit",
            inputIds: ["b"],
            messages: input("b").messages,
          }),
        )
        .isErr(),
    ).toBe(true);
    expect(attempt.inputState("a")).toBe("returned");
    expect(attempt.reserve(["a"]).isOk()).toBe(true);
    expect(
      attempt
        .accept(
          event(0, {
            type: "history-commit",
            inputIds: ["a"],
            messages: input("a").messages,
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      attempt
        .accept(
          event(1, {
            type: "history-commit",
            inputIds: ["b"],
            messages: input("b").messages,
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(attempt.inputState("follow")).toBe("queued");
  });

  test("reservation and commits reject reversed queue order atomically", () => {
    const attempt = new AgentAttempt("first");
    attempt.register(input("a"));
    attempt.register(input("b"));
    expect(attempt.reserve(["b", "a"]).isErr()).toBe(true);
    expect(attempt.inputState("a")).toBe("queued");
    attempt.reserve(["a", "b"]);
    expect(
      attempt
        .accept(
          event(0, {
            type: "history-commit",
            inputIds: ["b", "a"],
            messages: [...input("b").messages, ...input("a").messages],
          }),
        )
        .isErr(),
    ).toBe(true);
    expect(attempt.inputState("a")).toBe("reserved");
    expect(attempt.messages).toEqual([]);
  });

  test("preparation failure returns locally and canonical commits use prepared content", () => {
    const attempt = new AgentAttempt("first");
    const original = input("a");
    attempt.register(original);
    attempt.reserve(["a"]);
    attempt.returnPrepared(["a"]);
    expect(attempt.boundaryInputs).toEqual([original]);
    attempt.reserve(["a"]);
    const prepared = {
      ...original,
      messages: [{ role: "user", content: "prepared" }],
    } satisfies AgentInput;
    expect(attempt.prepared(prepared).isOk()).toBe(true);
    expect(attempt.pendingInputs).toEqual([original]);
    expect(
      attempt
        .accept(event(0, { type: "history-commit", messages: original.messages, inputIds: ["a"] }))
        .isErr(),
    ).toBe(true);
    expect(
      attempt
        .accept(event(0, { type: "history-commit", messages: prepared.messages, inputIds: ["a"] }))
        .isOk(),
    ).toBe(true);
    expect(attempt.pendingInputs).toEqual([]);
  });

  test("presentation does not commit history and successor position determines input commitment", () => {
    const attempt = new AgentAttempt("first");
    attempt.register(input("a"));
    attempt.reserve(["a"]);
    attempt.accept(
      event(0, {
        type: "output",
        output: { id: "out", kind: "text", phase: "delta", delta: "partial" },
      }),
    );
    expect(attempt.messages).toEqual([]);
    expect(attempt.inputState("a")).toBe("reserved");
    attempt.accept(event(1, { type: "delivery", inputIds: ["a"], status: "provider-owned" }));
    const messages = [
      { role: "assistant", content: "predecessor" },
      ...input("a").messages,
      { role: "assistant", content: "successor" },
    ] as const;
    expect(
      attempt.accept(event(2, { type: "history-commit", messages, inputIds: ["a"] })).isOk(),
    ).toBe(true);
    expect(attempt.messages).toEqual(messages);
    expect(attempt.inputState("a")).toBe("committed");
  });

  test("missing acknowledgement requires reconciliation and late callbacks cannot commit", () => {
    const attempt = new AgentAttempt("first");
    attempt.register(input("a"));
    attempt.reserve(["a"]);
    attempt.retire();
    expect(attempt.inputState("a")).toBe("unresolved");
    expect(attempt.boundaryInputs).toEqual([]);
    expect(attempt.pendingInputs).toEqual([input("a")]);
    expect(
      attempt
        .accept(
          event(0, { type: "history-commit", messages: input("a").messages, inputIds: ["a"] }),
        )
        .isErr(),
    ).toBe(true);
    const replacement = new AgentAttempt("replacement");
    expect(
      replacement.accept(event(0, { type: "terminal", outcome: { status: "completed" } })).isErr(),
    ).toBe(true);
  });

  test("normal completion racing submission cannot lose an input or emit two terminal outcomes", () => {
    const attempt = new AgentAttempt("first");
    attempt.register(input("a"));
    attempt.reserve(["a"]);
    expect(
      attempt.accept(event(0, { type: "terminal", outcome: { status: "completed" } })).isErr(),
    ).toBe(true);
    expect(
      attempt.accept(event(0, { type: "terminal", outcome: { status: "cancelled" } })).isOk(),
    ).toBe(true);
    expect(attempt.inputState("a")).toBe("unresolved");
    expect(
      attempt.accept(event(1, { type: "terminal", outcome: { status: "completed" } })).isErr(),
    ).toBe(true);
    expect(attempt.register(input("b")).isErr()).toBe(true);
  });

  test("out-of-order and invalid commits do not mutate history or consume the sequence", () => {
    const attempt = new AgentAttempt("first");
    const commit = {
      type: "history-commit",
      inputIds: [],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "missing",
              toolName: "read",
              output: { type: "text", value: "x" },
            },
          ],
        },
      ],
    } satisfies Parameters<typeof event>[1];
    expect(attempt.accept(event(1, commit)).isErr()).toBe(true);
    expect(attempt.accept(event(0, commit)).isErr()).toBe(true);
    expect(attempt.messages).toEqual([]);
    expect(
      attempt.accept(event(0, { type: "terminal", outcome: { status: "completed" } })).isOk(),
    ).toBe(true);
  });

  test("complete local and inline provider tool exchanges are valid canonical commits", () => {
    const attempt = new AgentAttempt("first");
    expect(
      attempt
        .accept(
          event(0, {
            type: "history-commit",
            inputIds: [],
            messages: [
              {
                role: "assistant",
                content: [
                  { type: "tool-call", toolCallId: "one", toolName: "read", input: {} },
                  {
                    type: "tool-result",
                    toolCallId: "one",
                    toolName: "read",
                    output: { type: "text", value: "ok" },
                  },
                ],
              },
            ],
          }),
        )
        .isOk(),
    ).toBe(true);
    expect(
      attempt
        .accept(
          event(1, {
            type: "history-commit",
            inputIds: [],
            messages: [
              {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "two", toolName: "read", input: {} }],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "two",
                    toolName: "read",
                    output: { type: "text", value: "ok" },
                  },
                ],
              },
            ],
          }),
        )
        .isOk(),
    ).toBe(true);
  });

  test("controls progress while output is unconsumed and host tool authorization is pending", async () => {
    const toolRequested = Promise.withResolvers<void>();
    const toolSettled =
      Promise.withResolvers<Awaited<ReturnType<AgentHostServices["executeTools"]>>>();
    const gatedHost: AgentHostServices = {
      ...host,
      executeTools() {
        toolRequested.resolve();
        return toolSettled.promise;
      },
    };
    const controlled = fixture(gatedHost);
    expect(controlled.started).toBe(false);
    controlled.execution.start();
    controlled.emit({
      type: "output",
      output: { id: "out", kind: "text", phase: "delta", delta: "x" },
    });
    const tool = gatedHost.executeTools({
      attemptId: "first",
      scopeId: "scope",
      calls: [{ callId: "call", name: "denied", inputJson: "{}" }],
      signal: new AbortController().signal,
    });
    await toolRequested.promise;
    expect(controlled.execution.submitInput(input("a")).isOk()).toBe(true);
    expect(controlled.submissions).toEqual([input("a")]);
    toolSettled.resolve(
      Result.err(
        new AgentAdapterFailure({
          reason: "invalid-state",
          message: "Denied by host",
          replaySafety: "safe",
        }),
      ),
    );
    expect((await tool).isErr()).toBe(true);
    const iterator = controlled.execution.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("output");
    await controlled.execution.dispose();
    expect((await iterator.next()).done).toBe(true);
  });
});
