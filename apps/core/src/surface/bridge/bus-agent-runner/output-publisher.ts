import {
  type EventPublishContractInvalid,
  type EventPublishTransportFailed,
  lilacEventTypes,
  type AdapterPlatform,
  type LilacBus,
  type LilacDataForType,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import { captureRuntimeError } from "../../../runtime/error-format";

export const AGENT_OUTPUT_FLUSH_INTERVAL_MS = 40;
export const AGENT_OUTPUT_FLUSH_BYTES = 4 * 1024;
/** Surface relays show at most this many characters of the current reasoning chunk. */
export const REASONING_DETAIL_MAX_CHARS = 4_000;

type TextData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputDeltaText>;
type TextResetData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputTextReset>;
type ReasoningData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputDeltaReasoning>;
type ToolCallData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputToolCall>;
type ResponseTextData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputResponseText>;
type ActivityData = LilacDataForType<typeof lilacEventTypes.EvtAgentOutputActivity>;

type PendingOutput =
  | { type: "text"; data: TextData; bytes: number }
  | { type: "reasoning"; data: ReasoningData; bytes: number };

type EventPublishError = EventPublishContractInvalid | EventPublishTransportFailed;

export class AgentOutputPublishFailed extends TaggedError("AgentOutputPublishFailed")<{
  readonly label: string;
  readonly eventType: string;
  readonly errorTag: EventPublishError["_tag"];
  readonly message: string;
}> {}

function toAgentOutputPublishResult(
  label: string,
  published: ResultType<object, EventPublishError>,
): ResultType<void, AgentOutputPublishFailed> {
  return published
    .mapError(
      (error) =>
        new AgentOutputPublishFailed({
          label,
          eventType: error.eventType,
          errorTag: error._tag,
          message: error.message,
        }),
    )
    .map(() => undefined);
}

export function adaptAgentOutputPublishResultToHost(
  result: ResultType<void, AgentOutputPublishFailed>,
): void {
  result.match({
    ok: () => () => undefined,
    err: (error) => () => {
      throw error;
    },
  })();
}

export type AgentOutputFlushScheduler = (callback: () => void, delayMs: number) => () => void;

function defaultScheduleFlush(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export function createAgentOutputPublisher(params: {
  bus: LilacBus;
  headers: {
    request_id: string;
    session_id: string;
    request_client: AdapterPlatform;
    workflow_dispatch_epoch?: string;
    router_session_mode?: "mention" | "active";
  };
  scheduleFlush?: AgentOutputFlushScheduler;
  onError?: (label: string, error: AgentOutputPublishFailed) => void;
  reportFatalPanic: (panic: Panic) => void;
}) {
  const scheduleFlush = params.scheduleFlush ?? defaultScheduleFlush;
  let pending: PendingOutput | null = null;
  let cancelScheduledFlush: (() => void) | null = null;
  let publicationTail: Promise<ResultType<void, never>> = Promise.resolve(Result.ok(undefined));
  let reportedPanic: Panic | null = null;
  let finalReplayDeadline: number | undefined;

  const enqueue = (
    label: string,
    publish: () => Promise<ResultType<void, AgentOutputPublishFailed>>,
  ): Promise<ResultType<void, AgentOutputPublishFailed>> => {
    const previous = publicationTail;
    const run = async (): Promise<ResultType<void, AgentOutputPublishFailed>> => {
      await previous;
      return publish();
    };
    const publication = run();
    const settle = async (): Promise<ResultType<void, never>> => {
      const result = await publication;
      result.match({
        ok: () => () => undefined,
        err: (error) => () => params.onError?.(label, error),
      })();
      return Result.ok(undefined);
    };
    const settlement = settle();
    publicationTail = settlement;
    const supervisedSettlement = Result.tryPromise({
      try: () => settlement,
      catch: captureRuntimeError,
    });
    void supervisedSettlement.then((result) =>
      result.match({
        ok: () => undefined,
        err: (captured) => {
          if (captured.kind !== "panic" || reportedPanic) return;
          reportedPanic = captured.panic;
          params.reportFatalPanic(captured.panic);
        },
      }),
    );
    return publication;
  };

  const enqueueForHost = async (
    label: string,
    publish: () => Promise<ResultType<void, AgentOutputPublishFailed>>,
  ): Promise<void> => {
    adaptAgentOutputPublishResultToHost(await enqueue(label, publish));
  };

  const clearScheduledFlush = (): void => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = null;
  };

  const flushPending = (): void => {
    clearScheduledFlush();
    const output = pending;
    pending = null;
    if (!output) return;

    if (output.type === "text") {
      void enqueue("text delta", async () => {
        return toAgentOutputPublishResult(
          "text delta",
          await params.bus.publish(lilacEventTypes.EvtAgentOutputDeltaText, output.data, {
            headers: params.headers,
          }),
        );
      });
      return;
    }

    void enqueue("reasoning snapshot", async () => {
      return toAgentOutputPublishResult(
        "reasoning snapshot",
        await params.bus.publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, output.data, {
          headers: params.headers,
        }),
      );
    });
  };

  const schedulePendingFlush = (): void => {
    if (cancelScheduledFlush) return;
    cancelScheduledFlush = scheduleFlush(() => {
      cancelScheduledFlush = null;
      flushPending();
    }, AGENT_OUTPUT_FLUSH_INTERVAL_MS);
  };

  const flushAtSizeLimit = (): void => {
    if (pending && pending.bytes >= AGENT_OUTPUT_FLUSH_BYTES) flushPending();
  };

  const publishText = (
    delta: string,
    phase?: TextData["phase"],
    phaseBoundaryPrefixChars = 0,
  ): void => {
    if (
      pending?.type === "text" &&
      pending.data.phase === phase &&
      phaseBoundaryPrefixChars === 0
    ) {
      pending.data.delta += delta;
      pending.bytes += Buffer.byteLength(delta);
    } else {
      flushPending();
      pending = {
        type: "text",
        data: {
          delta,
          ...(phase === undefined ? {} : { phase }),
          ...(phaseBoundaryPrefixChars > 0 ? { phaseBoundaryPrefixChars } : {}),
        },
        bytes: Buffer.byteLength(delta),
      };
    }
    schedulePendingFlush();
    flushAtSizeLimit();
  };

  const publishReasoningSnapshot = (data: ReasoningData, newDeltaBytes: number): void => {
    if (pending?.type === "reasoning") {
      pending.data = data;
      pending.bytes += newDeltaBytes;
    } else {
      flushPending();
      pending = {
        type: "reasoning",
        data,
        bytes: newDeltaBytes,
      };
    }
    schedulePendingFlush();
    flushAtSizeLimit();
  };

  const publishTextReset = (data: TextResetData): Promise<void> => {
    flushPending();
    return enqueueForHost("text reset", async () => {
      return toAgentOutputPublishResult(
        "text reset",
        await params.bus.publish(lilacEventTypes.EvtAgentOutputTextReset, data, {
          headers: params.headers,
        }),
      );
    });
  };

  const publishReasoningBoundary = (data: ReasoningData): Promise<void> => {
    flushPending();
    return enqueueForHost("reasoning boundary", async () => {
      return toAgentOutputPublishResult(
        "reasoning boundary",
        await params.bus.publish(lilacEventTypes.EvtAgentOutputDeltaReasoning, data, {
          headers: params.headers,
        }),
      );
    });
  };

  const publishToolCall = (data: ToolCallData): Promise<void> => {
    flushPending();
    return enqueueForHost("tool status", async () => {
      return toAgentOutputPublishResult(
        "tool status",
        await params.bus.publish(lilacEventTypes.EvtAgentOutputToolCall, data, {
          headers: params.headers,
        }),
      );
    });
  };

  const publishActivity = (data: ActivityData): Promise<void> => {
    flushPending();
    return enqueueForHost("activity", async () => {
      return toAgentOutputPublishResult(
        "activity",
        await params.bus.publish(lilacEventTypes.EvtAgentOutputActivity, data, {
          headers: params.headers,
        }),
      );
    });
  };

  const publishResponseText = (data: ResponseTextData): Promise<void> => {
    flushPending();
    return enqueueForHost("final response", async () => {
      const published = await params.bus.publish(lilacEventTypes.EvtAgentOutputResponseText, data, {
        headers: params.headers,
      });
      published.match({
        ok: (receipt) => {
          if (receipt.replayDeadline !== undefined) {
            finalReplayDeadline = Math.max(
              finalReplayDeadline ?? receipt.replayDeadline,
              receipt.replayDeadline,
            );
          }
        },
        err: () => undefined,
      });
      return toAgentOutputPublishResult("final response", published);
    });
  };

  const drain = async (): Promise<void> => {
    flushPending();
    await publicationTail;
  };

  return {
    publishText,
    publishTextReset,
    publishReasoningSnapshot,
    publishReasoningBoundary,
    publishToolCall,
    publishActivity,
    publishResponseText,
    getFinalReplayDeadline: () => finalReplayDeadline,
    flush: flushPending,
    drain,
  };
}
