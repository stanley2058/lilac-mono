import {
  lilacEventTypes,
  type LilacBus,
  type NativeOutputEvent,
  type NativeOutputFrontier,
  type NativeOutputPayload,
} from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Result as ResultType } from "better-result";

export type NativeTextPhase = "commentary" | "final_answer" | "unspecified";
export type { NativeOutputEvent, NativeOutputPayload } from "@stanley2058/lilac-event-bus";

export class NativeOutputPublishFailed extends TaggedError("NativeOutputPublishFailed")<{
  readonly message: string;
}> {}

export type NativeOutputPublication = ResultType<void, NativeOutputPublishFailed>;
export type NativeOutputSink = (event: NativeOutputEvent) => Promise<NativeOutputPublication>;

interface TextPart {
  readonly partId: string;
  readonly stepId: string;
  readonly position: number;
  readonly phase: NativeTextPhase;
  text: string;
  trailingCarriageReturn: boolean;
}

export function createNativeOutputPublisher(options: {
  readonly threadId: string;
  readonly turnId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly attemptId: string;
  readonly mode: "paragraph" | "complete";
  readonly publish: NativeOutputSink;
  readonly now?: () => number;
  readonly recoveryFrontier?: NativeOutputFrontier;
  readonly previousAttemptId?: string;
}) {
  let attemptId = options.attemptId;
  let sequence = 0;
  let position = options.recoveryFrontier?.position ?? 0;
  let ordinal = options.recoveryFrontier?.ordinal ?? 0;
  let settled = false;
  let currentStepId = `${options.requestId}:step:0`;
  let parts: TextPart[] = [];
  const activityPositions = new Map<string, number>();
  let publicationTail: Promise<NativeOutputPublication> = Promise.resolve(Result.ok(undefined));

  function emit(payload: NativeOutputPayload): void {
    sequence += 1;
    ordinal += 1;
    const event: NativeOutputEvent = {
      threadId: options.threadId,
      turnId: options.turnId,
      generation: options.generation,
      requestId: options.requestId,
      attemptId,
      sequence,
      ordinal,
      eventId: JSON.stringify([options.requestId, attemptId, sequence]),
      occurredAt: (options.now ?? Date.now)(),
      payload,
    };
    const previous = publicationTail;
    async function publishAfterPrevious(): Promise<NativeOutputPublication> {
      const result = await previous;
      return result.andThenAsync(publishEvent);
    }
    async function publishEvent(): Promise<NativeOutputPublication> {
      return options.publish(event);
    }
    // A failure fences later events, including terminal events, until this attempt is recovered.
    publicationTail = publishAfterPrevious();
  }

  function publishPart(part: TextPart, text: string, incomplete: boolean): void {
    if (text.length === 0) return;
    emit({
      type: "text",
      partId: part.partId,
      stepId: part.stepId,
      position: part.position,
      phase: part.phase,
      text,
      incomplete,
    });
  }

  function finishNormalization(part: TextPart): void {
    if (!part.trailingCarriageReturn) return;
    part.text += "\r";
    part.trailingCarriageReturn = false;
  }

  function flushPart(part: TextPart, incomplete: boolean): void {
    finishNormalization(part);
    publishPart(part, part.text, incomplete);
    part.text = "";
  }

  function textStart(input: {
    readonly partId: string;
    readonly stepId: string;
    readonly phase?: NativeTextPhase;
  }): void {
    if (settled || parts.some((part) => part.partId === input.partId)) return;
    currentStepId = input.stepId;
    position += 1;
    parts.push({
      ...input,
      phase: input.phase ?? "unspecified",
      position,
      text: "",
      trailingCarriageReturn: false,
    });
  }

  function textDelta(partId: string, delta: string): void {
    if (settled) return;
    const part = parts.find((entry) => entry.partId === partId);
    if (!part) return;
    let input = part.trailingCarriageReturn ? `\r${delta}` : delta;
    part.trailingCarriageReturn = input.endsWith("\r");
    if (part.trailingCarriageReturn) input = input.slice(0, -1);
    part.text += input.replaceAll("\r\n", "\n");
    if (options.mode !== "paragraph") return;
    let delimiter = part.text.indexOf("\n\n");
    while (delimiter !== -1) {
      const end = delimiter + 2;
      publishPart(part, part.text.slice(0, end), false);
      part.text = part.text.slice(end);
      delimiter = part.text.indexOf("\n\n");
    }
  }

  function textEnd(partId: string): void {
    if (settled) return;
    const part = parts.find((entry) => entry.partId === partId);
    if (!part) return;
    finishNormalization(part);
    if (options.mode !== "paragraph") return;
    flushPart(part, false);
    parts = parts.filter((entry) => entry !== part);
  }

  function stepEnd(reason: "stop" | "tool-calls" | "length" | "error" | "canceled"): void {
    if (settled) return;
    const incomplete = reason !== "stop" && reason !== "tool-calls";
    for (const part of parts) flushPart(part, incomplete);
    parts = [];
  }

  function activity(
    input: Omit<Extract<NativeOutputPayload, { type: "activity" }>, "type" | "position">,
  ): void {
    if (settled) return;
    // Native agent runtimes can execute tools before returning the enclosing model call.
    if (input.kind === "tool" && input.state === "start") stepEnd("tool-calls");
    currentStepId = input.stepId;
    const key = JSON.stringify([input.stepId, input.activityId]);
    const knownPosition = activityPositions.get(key);
    const activityPosition = knownPosition ?? ++position;
    activityPositions.set(key, activityPosition);
    emit({ type: "activity", ...input, position: activityPosition });
  }

  function resource(
    input: Omit<Extract<NativeOutputPayload, { type: "resource" }>, "type" | "position">,
  ): Promise<NativeOutputPublication> {
    if (settled)
      return Promise.resolve(
        Result.err(
          new NativeOutputPublishFailed({ message: "Native response has already settled" }),
        ),
      );
    emit({ type: "resource", ...input, position: ++position });
    return publicationTail;
  }

  function compaction(
    input: Omit<Extract<NativeOutputPayload, { type: "compaction" }>, "type" | "position">,
  ): void {
    if (settled) return;
    const key = JSON.stringify(["compaction", input.compactionId]);
    const knownPosition = activityPositions.get(key);
    const activityPosition = knownPosition ?? ++position;
    activityPositions.set(key, activityPosition);
    emit({ type: "compaction", ...input, position: activityPosition });
  }

  function reset(nextAttemptId: string, stepId?: string): void {
    if (settled || nextAttemptId === attemptId) return;
    const previousAttemptId = attemptId;
    attemptId = nextAttemptId;
    sequence = 0;
    parts = [];
    activityPositions.clear();
    emit({ type: "reset", previousAttemptId, ...(stepId ? { stepId } : {}) });
  }

  function terminal(state: "complete" | "failed" | "canceled"): Promise<NativeOutputPublication> {
    if (settled) return publicationTail;
    stepEnd(state === "complete" ? "stop" : "error");
    settled = true;
    emit({ type: "terminal", state });
    return publicationTail;
  }

  function captureBarrier(): Promise<NativeOutputPublication> {
    return publicationTail;
  }

  function hasPendingText(): boolean {
    return parts.some((part) => part.text.length > 0 || part.trailingCarriageReturn);
  }

  function captureCheckpoint(): {
    readonly frontier: NativeOutputFrontier;
    readonly barrier: Promise<NativeOutputPublication>;
  } {
    return { frontier: { ordinal, position }, barrier: publicationTail };
  }

  if (options.previousAttemptId) {
    emit({
      type: "reset",
      previousAttemptId: options.previousAttemptId,
      retainThroughOrdinal: options.recoveryFrontier?.ordinal ?? 0,
    });
  }

  return {
    model: (
      spec: string,
      reasoning?: Extract<NativeOutputPayload, { type: "model" }>["reasoning"],
    ) => {
      if (!settled) emit({ type: "model", spec, reasoning });
    },
    hasPendingText,
    currentStepId: () => currentStepId,
    resource,
    captureCheckpoint,
    textStart,
    textDelta,
    textEnd,
    stepEnd,
    activity,
    compaction,
    reset,
    terminal,
    captureBarrier,
  };
}

export type NativeOutputPublisher = ReturnType<typeof createNativeOutputPublisher>;

export function createNativeBusOutputSink(bus: LilacBus): NativeOutputSink {
  return async (event) => {
    const result = await bus.publish(lilacEventTypes.EvtNativeOutput, event);
    return result
      .map(() => undefined)
      .mapError(
        () =>
          new NativeOutputPublishFailed({
            message: "Native output publication failed",
          }),
      );
  };
}
