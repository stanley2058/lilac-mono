import { describe, expect, test } from "bun:test";
import type { ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { displayMessageSchema } from "@stanley2058/lilac-client-protocol";
import type { NativeOutputEvent, NativeOutputPayload } from "@stanley2058/lilac-event-bus";
import { projectNativeOutput } from "./output-projection";

function slot(): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: "slot",
    position: 0,
    turnId: "turn",
    state: "running",
    messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Hello" }] }],
  };
}
function event(
  payload: NativeOutputPayload,
  attemptId = "attempt",
  sequence = 1,
): NativeOutputEvent {
  return {
    threadId: "thread",
    turnId: "turn",
    generation: 0,
    requestId: "native:thread:request",
    attemptId,
    sequence,
    ordinal: sequence,
    eventId: `event_${sequence}`,
    occurredAt: 100,
    payload,
  };
}
function text(
  position: number,
  value: string,
  stepId = "step",
  phase: "commentary" | "final_answer" = "commentary",
): NativeOutputPayload {
  return {
    type: "text",
    partId: `part-${position}`,
    stepId,
    position,
    phase,
    text: value,
    incomplete: false,
  };
}
function outputText(value: ReadyTurnSlot): string {
  return value.messages
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

test("live activity keeps its identity across another step retry and recovery rollback", () => {
  const activity: NativeOutputPayload = {
    type: "activity",
    activityId: "workflow",
    stepId: "step-1",
    position: 1,
    kind: "tool",
    state: "start",
    label: "Workflow running",
  };
  const started = projectNativeOutput(slot(), event(activity, "first", 1));
  const messageId = started.slot.messages[1]!.id;
  const retry = projectNativeOutput(
    started.slot,
    event({ type: "reset", previousAttemptId: "first", stepId: "step-2" }, "retry", 2),
    started.projection,
  );
  const completed = projectNativeOutput(
    retry.slot,
    event({ ...activity, position: 2, state: "complete", label: "Workflow complete" }, "retry", 3),
    retry.projection,
  );
  expect(completed.slot.messages).toHaveLength(2);
  expect(completed.slot.messages[1]!.id).toBe(messageId);
  expect(completed.changes.map((change) => change.kind)).toEqual(["set-part"]);
  const recovered = projectNativeOutput(
    completed.slot,
    event({ type: "reset", previousAttemptId: "retry", retainThroughOrdinal: 1 }, "recovered", 2),
    completed.projection,
  );
  expect(recovered.slot.messages[1]!.parts[0]).toMatchObject({ data: { state: "running" } });
  const settled = projectNativeOutput(
    recovered.slot,
    event({ ...activity, stepId: "step-0", position: 2, state: "failed" }, "recovered", 3),
    recovered.projection,
  );
  expect(settled.slot.messages).toHaveLength(2);
  expect(settled.slot.messages[1]!.id).toBe(messageId);
  expect(settled.slot.messages[1]!.parts[0]).toMatchObject({ data: { state: "failed" } });
  expect(settled.changes.map((change) => change.kind)).toEqual(["set-part"]);
});

test("activity in the reset step is removed before a reused tool identifier starts again", () => {
  const activity: NativeOutputPayload = {
    type: "activity",
    activityId: "tool",
    stepId: "step",
    position: 1,
    kind: "tool",
    state: "start",
    label: "Tool",
  };
  const started = projectNativeOutput(slot(), event(activity, "first", 1));
  const reset = projectNativeOutput(
    started.slot,
    event({ type: "reset", previousAttemptId: "first", stepId: "step" }, "retry", 2),
    started.projection,
  );
  expect(reset.slot.messages).toHaveLength(1);
  const restarted = projectNativeOutput(reset.slot, event(activity, "retry", 3), reset.projection);
  expect(restarted.slot.messages).toHaveLength(2);
  expect(restarted.slot.messages[1]!.id).not.toBe(started.slot.messages[1]!.id);
});

describe("native output projection", () => {
  test("paragraph publications append bounded parts and keep stable phase/identity", () => {
    const first = projectNativeOutput(slot(), event(text(1, "First\n\n")));
    const second = projectNativeOutput(first.slot, event(text(1, "Second\n\n"), "attempt", 2));
    expect(second.slot.messages).toHaveLength(2);
    expect(second.slot.messages[1]?.metadata?.phase).toBe("commentary");
    expect(second.changes).toEqual([
      {
        kind: "set-part",
        turnId: "turn",
        position: 0,
        messageId: first.slot.messages[1]?.id ?? "missing",
        partIndex: 1,
        part: { type: "text", text: "Second\n\n" },
      },
    ]);
    expect(outputText(second.slot)).toBe("HelloFirst\n\nSecond\n\n");
    expect(displayMessageSchema.safeParse(second.slot.messages[1]).success).toBe(true);
  });

  test("complete-mode delayed text inserts before already published later activity", () => {
    const tool = projectNativeOutput(
      slot(),
      event({
        type: "activity",
        activityId: "tool",
        stepId: "step",
        position: 2,
        kind: "tool",
        state: "start",
        label: "Read file",
      }),
    );
    const earlierText = projectNativeOutput(
      tool.slot,
      event(text(1, "Checking files"), "attempt", 2),
    );
    expect(earlierText.slot.messages[1]?.parts[0]).toEqual({
      type: "text",
      text: "Checking files",
    });
    expect(earlierText.slot.messages[2]?.parts[0]?.type).toBe("data-activity");
    expect(earlierText.changes[0]).toMatchObject({
      kind: "append-message",
      beforeMessageId: tool.slot.messages[1]?.id,
    });
    const completed = projectNativeOutput(
      earlierText.slot,
      event(
        {
          type: "activity",
          activityId: "tool",
          stepId: "step",
          position: 2,
          kind: "tool",
          state: "complete",
        },
        "attempt",
        3,
      ),
    );
    expect(completed.slot.messages[2]?.parts[0]).toMatchObject({
      data: { label: "Read file", state: "complete" },
    });
  });

  test("step reset retains completed prior steps and removes only abandoned step output", () => {
    const prior = projectNativeOutput(slot(), event(text(1, "Prior step", "step-one")));
    const abandoned = projectNativeOutput(
      prior.slot,
      event(text(2, "Abandoned", "step-two"), "attempt", 2),
    );
    const reset = projectNativeOutput(
      abandoned.slot,
      event({ type: "reset", previousAttemptId: "attempt", stepId: "step-two" }, "retry", 1),
    );
    expect(outputText(reset.slot)).toBe("HelloPrior step");
    expect(reset.changes).toEqual([
      {
        kind: "remove-message",
        turnId: "turn",
        position: 0,
        messageId: abandoned.slot.messages[2]?.id ?? "missing",
      },
    ]);
    const retried = projectNativeOutput(
      reset.slot,
      event(text(3, "New answer", "step-two", "final_answer"), "retry", 2),
    );
    expect(outputText(retried.slot)).toBe("HelloPrior stepNew answer");
    expect(retried.slot.messages.at(-1)?.metadata?.phase).toBe("final");
    expect(retried.slot.messages.at(-1)?.id).not.toBe(abandoned.slot.messages.at(-1)?.id);
  });

  test("compaction keeps counts but excludes summary/boundary internals", () => {
    const start = projectNativeOutput(
      slot(),
      event({
        type: "compaction",
        compactionId: "compact",
        position: 1,
        state: "start",
        beforeCount: 30,
        boundary: "internal-context-id",
      }),
    );
    const complete = projectNativeOutput(
      start.slot,
      event(
        {
          type: "compaction",
          compactionId: "compact",
          position: 1,
          state: "complete",
          afterCount: 5,
        },
        "attempt",
        2,
      ),
    );
    expect(complete.slot.messages[1]?.parts[0]).toMatchObject({
      type: "data-compaction",
      data: { state: "complete", beforeCount: 30, afterCount: 5 },
    });
    expect(JSON.stringify(complete.slot)).not.toContain("internal-context-id");
    const terminal = projectNativeOutput(
      complete.slot,
      event({ type: "terminal", state: "canceled" }, "attempt", 3),
    );
    expect(terminal.slot).toMatchObject({ state: "canceled", settledAt: 100 });
    expect(terminal.slot.messages).toEqual(complete.slot.messages);
  });

  test("large paragraphs split on valid Unicode boundaries into bounded UIMessage parts", () => {
    const value = "x".repeat(65_535) + "😀" + "y".repeat(65_536);
    const projected = projectNativeOutput(slot(), event(text(1, value)));
    expect(outputText(projected.slot)).toBe(`Hello${value}`);
    const message = projected.slot.messages[1];
    expect(message?.parts.length).toBeGreaterThan(1);
    expect(displayMessageSchema.safeParse(message).success).toBe(true);
    for (const part of message?.parts ?? []) {
      if (part.type !== "text") continue;
      expect(part.text.length).toBeLessThanOrEqual(8_192);
      expect(part.text.isWellFormed()).toBe(true);
    }
  });

  test("whole attempt reset leaves user inputs and other attempt output intact", () => {
    const first = projectNativeOutput(slot(), event(text(1, "old")));
    const second = projectNativeOutput(first.slot, event(text(2, "new"), "other"));
    const reset = projectNativeOutput(
      second.slot,
      event({ type: "reset", previousAttemptId: "attempt" }, "retry"),
    );
    expect(outputText(reset.slot)).toBe("Hellonew");
    expect(reset.slot.messages[0]?.id).toBe("user");
  });
});

test("recovery frontier retains prior text, truncates late chunks and restores activity state", () => {
  const first = projectNativeOutput(slot(), event(text(1, "Checkpoint text")));
  const running = projectNativeOutput(
    first.slot,
    event(
      {
        type: "activity",
        activityId: "tool",
        stepId: "step",
        position: 2,
        kind: "tool",
        state: "start",
        label: "Read file",
      },
      "attempt",
      2,
    ),
    first.projection,
  );
  const late = projectNativeOutput(
    running.slot,
    event(text(1, " post-checkpoint text"), "attempt", 3),
    running.projection,
  );
  const complete = projectNativeOutput(
    late.slot,
    event(
      {
        type: "activity",
        activityId: "tool",
        stepId: "step",
        position: 2,
        kind: "tool",
        state: "complete",
      },
      "attempt",
      4,
    ),
    late.projection,
  );
  const settled = projectNativeOutput(
    complete.slot,
    event({ type: "terminal", state: "failed" }, "attempt", 5),
    complete.projection,
  );
  const reset = projectNativeOutput(
    settled.slot,
    event({ type: "reset", previousAttemptId: "attempt", retainThroughOrdinal: 2 }, "recovery", 3),
    settled.projection,
  );
  expect(outputText(reset.slot)).toBe("HelloCheckpoint text");
  expect(reset.slot.messages[2]?.parts[0]).toMatchObject({
    data: { state: "running", label: "Read file" },
  });
  expect(reset.slot.state).toBe("running");
  expect(reset.slot.settledAt).toBeUndefined();
  expect(reset.changes.some((change) => change.kind === "truncate-parts")).toBe(true);
  const newOutput = projectNativeOutput(
    reset.slot,
    event(text(3, "Recovered", "next-step", "final_answer"), "recovery", 4),
    reset.projection,
  );
  expect(outputText(newOutput.slot)).toBe("HelloCheckpoint textRecovered");
  expect(JSON.stringify(newOutput.projection)).not.toContain("Checkpoint text");
  expect(JSON.stringify(newOutput.slot)).not.toContain("createdOrdinal");
});

test("normal completion assigns a final phase to the last unlabelled provider text", () => {
  const firstPayload: NativeOutputPayload = {
    ...text(1, "Working"),
    type: "text",
    partId: "first",
    stepId: "one",
    position: 1,
    phase: "unspecified",
    text: "Working",
    incomplete: false,
  };
  const first = projectNativeOutput(slot(), event(firstPayload));
  const second = projectNativeOutput(
    first.slot,
    event(
      { ...firstPayload, partId: "second", stepId: "two", position: 2, text: "Answer" },
      "attempt",
      2,
    ),
    first.projection,
  );
  expect(second.slot.messages.slice(1).map((message) => message.metadata?.phase)).toEqual([
    "commentary",
    "commentary",
  ]);
  const completed = projectNativeOutput(
    second.slot,
    event({ type: "terminal", state: "complete" }, "attempt", 3),
    second.projection,
  );
  expect(completed.slot.messages.slice(1).map((message) => message.metadata?.phase)).toEqual([
    "commentary",
    "final",
  ]);
  expect(completed.changes.filter((change) => change.kind === "message-meta")).toEqual([
    {
      kind: "message-meta",
      turnId: "turn",
      position: 0,
      messageId: second.slot.messages[2]?.id ?? "missing",
      metadata: { phase: "final" },
    },
  ]);
});

test("length-limited text stays marked incomplete even when the overall turn completes", () => {
  const payload: NativeOutputPayload = {
    type: "text",
    partId: "answer",
    stepId: "step",
    position: 1,
    phase: "unspecified",
    text: "Truncated answer",
    incomplete: true,
  };
  const partial = projectNativeOutput(slot(), event(payload));
  expect(partial.slot.messages[1]?.metadata?.incomplete).toBe(true);
  const finished = projectNativeOutput(
    partial.slot,
    event({ type: "terminal", state: "complete" }, "attempt", 2),
    partial.projection,
  );
  expect(finished.slot.messages[1]?.metadata).toMatchObject({ phase: "final", incomplete: true });
  expect(
    finished.changes.some(
      (change) => change.kind === "message-meta" && "createdAt" in change.metadata,
    ),
  ).toBe(false);
});

test("checkpoint rollback removes abandoned incomplete and inferred final flags", () => {
  const payload: NativeOutputPayload = {
    type: "text",
    partId: "answer",
    stepId: "step",
    position: 1,
    phase: "unspecified",
    text: "Retained",
    incomplete: false,
  };
  const first = projectNativeOutput(slot(), event(payload));
  const partial = projectNativeOutput(
    first.slot,
    event({ ...payload, text: " lost", incomplete: true }, "attempt", 2),
    first.projection,
  );
  const finished = projectNativeOutput(
    partial.slot,
    event({ type: "terminal", state: "complete" }, "attempt", 3),
    partial.projection,
  );
  const reset = projectNativeOutput(
    finished.slot,
    event({ type: "reset", previousAttemptId: "attempt", retainThroughOrdinal: 1 }, "recovery", 2),
    finished.projection,
  );
  expect(reset.slot.messages[1]?.metadata).toMatchObject({
    phase: "commentary",
    incomplete: false,
  });
  expect(outputText(reset.slot)).toBe("HelloRetained");
  expect(reset.changes.filter((change) => change.kind === "message-meta")).toEqual([
    {
      kind: "message-meta",
      turnId: "turn",
      position: 0,
      messageId: first.slot.messages[1]?.id ?? "missing",
      metadata: { phase: "commentary", incomplete: false },
    },
  ]);
});

test("explicit final phases are preserved instead of promoting later commentary", () => {
  const final = projectNativeOutput(
    slot(),
    event(text(1, "Explicit answer", "step", "final_answer")),
  );
  const unlabelled: NativeOutputPayload = {
    type: "text",
    partId: "later",
    stepId: "step",
    position: 2,
    phase: "unspecified",
    text: "Other output",
    incomplete: false,
  };
  const later = projectNativeOutput(final.slot, event(unlabelled, "attempt", 2), final.projection);
  const completed = projectNativeOutput(
    later.slot,
    event({ type: "terminal", state: "complete" }, "attempt", 3),
    later.projection,
  );
  expect(completed.slot.messages.slice(1).map((message) => message.metadata?.phase)).toEqual([
    "final",
    "commentary",
  ]);
});

function unlabelledText(position: number, partId: string, body: string): NativeOutputPayload {
  return {
    type: "text",
    partId,
    stepId: `step-${position}`,
    position,
    phase: "unspecified",
    text: body,
    incomplete: false,
  };
}

function completedToolActivity(position: number, id: string): NativeOutputPayload {
  return {
    type: "activity",
    activityId: id,
    stepId: `step-${position}`,
    position,
    kind: "tool",
    state: "complete",
    label: `bash ${id}`,
  };
}

test("completion promotes trailing unlabelled text before a steer without promoting pre-tool commentary", () => {
  // Segment 1 has commentary -> tool -> trailing answer before steer; segment 2 has tool -> final.
  let current = projectNativeOutput(
    slot(),
    event(unlabelledText(1, "c1", "Checking"), "attempt", 1),
  );
  current = projectNativeOutput(
    current.slot,
    event(completedToolActivity(2, "t1"), "attempt", 2),
    current.projection,
  );
  current = projectNativeOutput(
    current.slot,
    event(unlabelledText(3, "a1", "Initial answer"), "attempt", 3),
    current.projection,
  );
  const withSteer: ReadyTurnSlot = {
    ...current.slot,
    messages: [
      ...current.slot.messages,
      {
        id: "steer_1",
        role: "user",
        metadata: { authorId: "owner", inputMode: "steer" },
        parts: [{ type: "text", text: "Also adjust the time" }],
      },
    ],
  };
  current = projectNativeOutput(
    withSteer,
    event(completedToolActivity(4, "t2"), "attempt", 4),
    current.projection,
  );
  current = projectNativeOutput(
    current.slot,
    event(unlabelledText(5, "a2", "Updated answer"), "attempt", 5),
    current.projection,
  );
  const completed = projectNativeOutput(
    current.slot,
    event({ type: "terminal", state: "complete" }, "attempt", 6),
    current.projection,
  );

  expect(
    completed.slot.messages.slice(1).map((message) => [message.role, message.metadata?.phase]),
  ).toEqual([
    ["assistant", "commentary"],
    ["assistant", undefined],
    ["assistant", "final"],
    ["user", undefined],
    ["assistant", undefined],
    ["assistant", "final"],
  ]);
});

test("pre-tool unlabelled commentary before a steer stays commentary on completion", () => {
  let current = projectNativeOutput(
    slot(),
    event(unlabelledText(1, "c1", "Checking"), "attempt", 1),
  );
  current = projectNativeOutput(
    current.slot,
    event(completedToolActivity(2, "t1"), "attempt", 2),
    current.projection,
  );
  const withSteer: ReadyTurnSlot = {
    ...current.slot,
    messages: [
      ...current.slot.messages,
      {
        id: "steer_1",
        role: "user",
        metadata: { authorId: "owner", inputMode: "steer" },
        parts: [{ type: "text", text: "Keep it short" }],
      },
    ],
  };
  current = projectNativeOutput(
    withSteer,
    event(unlabelledText(3, "a2", "Short answer"), "attempt", 3),
    current.projection,
  );
  const completed = projectNativeOutput(
    current.slot,
    event({ type: "terminal", state: "complete" }, "attempt", 4),
    current.projection,
  );

  expect(
    completed.slot.messages.slice(1).map((message) => [message.role, message.metadata?.phase]),
  ).toEqual([
    ["assistant", "commentary"],
    ["assistant", undefined],
    ["user", undefined],
    ["assistant", "final"],
  ]);
});

test("incoming agent prompts with phase final do not suppress pre-steer unlabelled reply promotion", () => {
  const incomingPromptSlot: ReadyTurnSlot = {
    kind: "ready",
    slotId: "turn",
    turnId: "turn",
    position: 0,
    state: "running",
    messages: [
      {
        id: "incoming",
        role: "assistant",
        metadata: { authorId: "lilac", phase: "final", inputId: "in_1", inputMode: "prompt" },
        parts: [{ type: "text", text: "Cross-thread ping." }],
      },
    ],
  };
  let current = projectNativeOutput(
    incomingPromptSlot,
    event(unlabelledText(1, "a1", "Pre-steer reply"), "attempt", 1),
  );
  const withSteer: ReadyTurnSlot = {
    ...current.slot,
    messages: [
      ...current.slot.messages,
      {
        id: "steer_1",
        role: "user",
        metadata: { authorId: "owner", inputMode: "steer" },
        parts: [{ type: "text", text: "Add details" }],
      },
    ],
  };
  current = projectNativeOutput(
    withSteer,
    event(unlabelledText(2, "a2", "Post-steer reply"), "attempt", 2),
    current.projection,
  );
  const completed = projectNativeOutput(
    current.slot,
    event({ type: "terminal", state: "complete" }, "attempt", 3),
    current.projection,
  );

  expect(completed.slot.messages.map((message) => [message.id, message.metadata?.phase])).toEqual([
    ["incoming", "final"],
    [current.slot.messages[1]!.id, "final"],
    ["steer_1", undefined],
    [current.slot.messages[3]!.id, "final"],
  ]);
});

test("resource output follows cancellation and recovery frontiers", () => {
  const resource: NativeOutputPayload = {
    type: "resource",
    stepId: "step",
    position: 1,
    resourceId: "upload",
    filename: "report.txt",
    mediaType: "text/plain",
    size: 3,
  };
  const added = projectNativeOutput(slot(), event(resource));
  expect(added.slot.messages[1]).toMatchObject({
    metadata: { authorId: "lilac" },
    parts: [
      { type: "data-resource", data: { name: "report.txt", resourceId: "upload", state: "ready" } },
    ],
  });
  expect(displayMessageSchema.safeParse(added.slot.messages[1]).success).toBe(true);
  const canceled = projectNativeOutput(
    added.slot,
    event({ type: "terminal", state: "canceled" }, "attempt", 2),
    added.projection,
  );
  expect(canceled.slot.messages).toHaveLength(2);
  for (const retained of [0, 1]) {
    const reset = projectNativeOutput(
      added.slot,
      event(
        { type: "reset", previousAttemptId: "attempt", retainThroughOrdinal: retained },
        "retry",
        2,
      ),
      added.projection,
    );
    expect(reset.slot.messages).toHaveLength(retained + 1);
  }
  const suppressed = projectNativeOutput(
    added.slot,
    event({ type: "reset", previousAttemptId: "attempt", stepId: "step" }, "retry", 2),
    added.projection,
  );
  expect(suppressed.slot.messages).toHaveLength(1);
});

test("native work retains command details and start time through completion", () => {
  const label = `bash ${"echo hello; ".repeat(40)}`;
  const started = projectNativeOutput(
    slot(),
    event({
      type: "activity",
      activityId: "tool",
      stepId: "step",
      position: 1,
      kind: "tool",
      state: "start",
      label,
    }),
  );
  expect(started.slot.startedAt).toBe(100);
  const part = started.slot.messages[1]!.parts[0]!;
  expect(part.type).toBe("data-activity");
  if (part.type !== "data-activity") throw new Error("Expected activity");
  expect(part.data.label.length).toBe(256);
  expect(part.data.detail).toBe(label);
  const completed = projectNativeOutput(
    started.slot,
    {
      ...event({ type: "terminal", state: "complete" }, "attempt", 2),
      occurredAt: 28100,
    },
    started.projection,
  );
  expect(completed.slot.startedAt).toBe(100);
  expect(completed.slot.settledAt).toBe(28100);
});

test("completed activity carries reasoning text, tool output, exit code, and duration", () => {
  const thinking = projectNativeOutput(
    slot(),
    event({
      type: "activity",
      activityId: "thought",
      stepId: "step",
      position: 1,
      kind: "thinking",
      state: "complete",
      detail: "**Plan** the change",
    }),
  );
  const tool = projectNativeOutput(
    thinking.slot,
    event(
      {
        type: "activity",
        activityId: "tool",
        stepId: "step",
        position: 2,
        kind: "tool",
        state: "failed",
        label: "bash false",
        output: "x".repeat(5000),
        exitCode: 1,
        durationMs: 40,
      },
      "attempt",
      2,
    ),
    thinking.projection,
  );
  const [, reasoning, command] = tool.slot.messages.map((message) => message.parts[0]);
  expect(reasoning).toMatchObject({
    type: "data-activity",
    data: { kind: "thinking", label: "Thinking", detail: "**Plan** the change" },
  });
  expect(command).toMatchObject({
    type: "data-activity",
    data: { state: "failed", detail: "bash false", exitCode: 1, durationMs: 40 },
  });
  expect(command?.type === "data-activity" && command.data.output?.length).toBe(4096);
  for (const message of tool.slot.messages) displayMessageSchema.parse(message);
});
