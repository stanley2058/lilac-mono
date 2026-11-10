import {
  lilacEventTypes,
  type DecodedLilacMessageForTopic,
  type OutReqTopic,
} from "@stanley2058/lilac-event-bus";

import type { SurfaceOutputPart, SurfaceToolStatusUpdate } from "../adapter";
import { mergeSubagentToolStatus } from "../subagent-tool-status";
import { REASONING_DETAIL_MAX_CHARS } from "./bus-agent-runner/output-publisher";
import { isPossibleNoReplyPrefix } from "./reply-directive";

/** What a surface relay has streamed so far for one request. */
export type RelayStreamState = {
  readonly totalTextChars: number;
  readonly streamTextPrefixChars: number;
  readonly streamPhaseBoundaryPrefixChars: number;
  readonly streamPhaseBoundaryOffsetChars: number;
  readonly streamPhaseBoundaryPrefix: string | undefined;
  readonly awaitingFinalPhaseBoundaryPrefix: boolean;
  readonly visibleTextAcc: string;
  readonly textPhase: "commentary" | "final_answer" | undefined;
  readonly commentaryText: string;
  readonly finalAnswerText: string;
  readonly phaseSegmentsValid: boolean;
  readonly reasoningStartedAtMs: number | undefined;
  readonly reasoningFrozenAtMs: number | undefined;
  readonly reasoningDetailText: string;
  readonly pendingNoReplyPrefix: string;
  readonly bufferNoReplyPrefix: boolean;
  readonly toolStatusById: ReadonlyMap<string, SurfaceToolStatusUpdate>;
};

type OutReqMessage = DecodedLilacMessageForTopic<OutReqTopic>;

export type RelayStreamEvent = Extract<
  OutReqMessage,
  {
    type:
      | typeof lilacEventTypes.EvtAgentOutputActivity
      | typeof lilacEventTypes.EvtAgentOutputDeltaReasoning
      | typeof lilacEventTypes.EvtAgentOutputDeltaText
      | typeof lilacEventTypes.EvtAgentOutputTextReset
      | typeof lilacEventTypes.EvtAgentOutputToolCall;
  }
>;

export function createRelayStreamState(): RelayStreamState {
  return {
    totalTextChars: 0,
    streamTextPrefixChars: 0,
    streamPhaseBoundaryPrefixChars: 0,
    streamPhaseBoundaryOffsetChars: 0,
    streamPhaseBoundaryPrefix: undefined,
    awaitingFinalPhaseBoundaryPrefix: false,
    visibleTextAcc: "",
    textPhase: undefined,
    commentaryText: "",
    finalAnswerText: "",
    phaseSegmentsValid: true,
    reasoningStartedAtMs: undefined,
    reasoningFrozenAtMs: undefined,
    reasoningDetailText: "",
    pendingNoReplyPrefix: "",
    bufferNoReplyPrefix: true,
    toolStatusById: new Map(),
  };
}

export function clampReasoningDetail(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= REASONING_DETAIL_MAX_CHARS) return normalized;
  return `${normalized.slice(0, REASONING_DETAIL_MAX_CHARS - 1)}…`;
}

function appendReasoningDetail(base: string, delta: string): string {
  const baseTrimmedEnd = base.replace(/\s+$/u, "");
  const deltaTrimmedStart = delta.replace(/^\s+/u, "");
  const needsSpacer =
    /[\p{L}\p{N}.!?]$/u.test(baseTrimmedEnd) && /^[\p{L}\p{N}]/u.test(deltaTrimmedStart);
  const merged = needsSpacer ? `${baseTrimmedEnd} ${deltaTrimmedStart}` : `${base}${delta}`;
  return clampReasoningDetail(merged);
}

/** Removes the recorded phase-boundary prefix from `text` when it is still at its offset. */
export function withoutStreamPhaseBoundary(
  state: RelayStreamState,
  text: string,
  textOffsetChars = 0,
): string {
  if (state.streamPhaseBoundaryPrefixChars === 0) return text;
  const boundaryStart = Math.min(
    Math.max(0, state.streamPhaseBoundaryOffsetChars - textOffsetChars),
    text.length,
  );
  const possibleBoundaryPrefix = text.slice(
    boundaryStart,
    boundaryStart + state.streamPhaseBoundaryPrefixChars,
  );
  const matchesKnownBoundary =
    state.streamPhaseBoundaryPrefix !== undefined &&
    possibleBoundaryPrefix === state.streamPhaseBoundaryPrefix;
  if (
    possibleBoundaryPrefix.length !== state.streamPhaseBoundaryPrefixChars ||
    !matchesKnownBoundary
  ) {
    return text;
  }
  return `${text.slice(0, boundaryStart)}${text.slice(
    boundaryStart + state.streamPhaseBoundaryPrefixChars,
  )}`;
}

/** Folds one streamed output event into the relay state and returns the surface part to push. */
export function reduceRelayStreamEvent(
  current: RelayStreamState,
  outMsg: RelayStreamEvent,
): { readonly state: RelayStreamState; readonly part: SurfaceOutputPart | null } {
  let {
    totalTextChars,
    streamPhaseBoundaryPrefixChars,
    streamPhaseBoundaryOffsetChars,
    streamPhaseBoundaryPrefix,
    awaitingFinalPhaseBoundaryPrefix,
    visibleTextAcc,
    textPhase,
    commentaryText,
    finalAnswerText,
    phaseSegmentsValid,
    reasoningStartedAtMs,
    reasoningFrozenAtMs,
    reasoningDetailText,
    pendingNoReplyPrefix,
    bufferNoReplyPrefix,
    toolStatusById,
  } = current;
  const { streamTextPrefixChars } = current;
  let part: SurfaceOutputPart | null = null;

  switch (outMsg.type) {
    case lilacEventTypes.EvtAgentOutputActivity: {
      break;
    }

    case lilacEventTypes.EvtAgentOutputDeltaReasoning: {
      const startedAtMs = reasoningStartedAtMs ?? outMsg.ts;
      reasoningStartedAtMs = startedAtMs;

      const seq = outMsg.data.seq;
      if (typeof seq === "number" && Number.isFinite(seq)) {
        reasoningDetailText = clampReasoningDetail(outMsg.data.delta);
      } else {
        reasoningDetailText = appendReasoningDetail(reasoningDetailText, outMsg.data.delta);
      }

      part = {
        type: "reasoning.status",
        update: {
          startedAtMs,
          frozenAtMs: reasoningFrozenAtMs,
          detailText: reasoningDetailText,
        },
      };
      break;
    }

    case lilacEventTypes.EvtAgentOutputDeltaText: {
      const incomingPhase = outMsg.data.phase;
      const visibleDelta = outMsg.data.delta;
      let phasedDelta = outMsg.data.delta;
      if (incomingPhase === "commentary" && textPhase === "final_answer") {
        phaseSegmentsValid = false;
      }
      if (incomingPhase === "final_answer" && textPhase === "commentary") {
        streamPhaseBoundaryPrefixChars = 0;
        streamPhaseBoundaryOffsetChars = 0;
        streamPhaseBoundaryPrefix = undefined;
        awaitingFinalPhaseBoundaryPrefix = true;
      }
      const boundaryPrefixChars = Math.max(
        0,
        Math.min(outMsg.data.phaseBoundaryPrefixChars ?? 0, outMsg.data.delta.length),
      );
      if (
        incomingPhase === "final_answer" &&
        awaitingFinalPhaseBoundaryPrefix &&
        boundaryPrefixChars > 0
      ) {
        streamPhaseBoundaryOffsetChars = Math.max(0, totalTextChars - streamTextPrefixChars);
        streamPhaseBoundaryPrefixChars = boundaryPrefixChars;
        streamPhaseBoundaryPrefix = outMsg.data.delta.slice(0, boundaryPrefixChars);
        phasedDelta = outMsg.data.delta.slice(boundaryPrefixChars);
        awaitingFinalPhaseBoundaryPrefix = false;
      } else if (
        incomingPhase === "final_answer" &&
        awaitingFinalPhaseBoundaryPrefix &&
        /\S/u.test(outMsg.data.delta)
      ) {
        awaitingFinalPhaseBoundaryPrefix = false;
      }
      if (incomingPhase === "commentary") commentaryText += phasedDelta;
      if (incomingPhase === "final_answer") finalAnswerText += phasedDelta;
      textPhase = incomingPhase ?? textPhase;
      totalTextChars += outMsg.data.delta.length;

      if (typeof reasoningStartedAtMs === "number" && typeof reasoningFrozenAtMs !== "number") {
        reasoningFrozenAtMs = outMsg.ts;
      }

      if (!bufferNoReplyPrefix) {
        part = { type: "text.delta", delta: visibleDelta, phase: incomingPhase };
        visibleTextAcc += visibleDelta;
        break;
      }

      pendingNoReplyPrefix += visibleDelta;
      if (isPossibleNoReplyPrefix(pendingNoReplyPrefix)) {
        break;
      }

      bufferNoReplyPrefix = false;
      part = {
        type: "text.delta",
        delta: pendingNoReplyPrefix,
        phase: incomingPhase,
      };
      visibleTextAcc += pendingNoReplyPrefix;
      pendingNoReplyPrefix = "";
      break;
    }

    case lilacEventTypes.EvtAgentOutputTextReset: {
      const clampedStreamPrefixChars = Math.max(
        0,
        Math.min(streamTextPrefixChars, outMsg.data.text.length),
      );
      const laneText = outMsg.data.text.slice(clampedStreamPrefixChars);
      totalTextChars = outMsg.data.text.length;
      visibleTextAcc = laneText;
      pendingNoReplyPrefix = "";
      bufferNoReplyPrefix = true;
      textPhase = outMsg.data.phase;
      if (outMsg.data.phase === "commentary") {
        commentaryText = laneText;
        finalAnswerText = "";
        phaseSegmentsValid = true;
      } else if (outMsg.data.phase === "final_answer") {
        phaseSegmentsValid =
          phaseSegmentsValid &&
          (commentaryText.length === 0 || laneText.startsWith(commentaryText));
        finalAnswerText = laneText.startsWith(commentaryText)
          ? withoutStreamPhaseBoundary(
              {
                ...current,
                streamPhaseBoundaryPrefixChars,
                streamPhaseBoundaryOffsetChars,
                streamPhaseBoundaryPrefix,
              },
              laneText.slice(commentaryText.length),
              commentaryText.length,
            )
          : laneText;
      } else {
        commentaryText = "";
        finalAnswerText = "";
        phaseSegmentsValid = true;
      }
      if (outMsg.data.phase !== "final_answer") {
        streamPhaseBoundaryPrefixChars = 0;
        streamPhaseBoundaryOffsetChars = 0;
        streamPhaseBoundaryPrefix = undefined;
      }
      awaitingFinalPhaseBoundaryPrefix = false;
      part = { type: "text.set", text: laneText, phase: outMsg.data.phase };
      break;
    }

    case lilacEventTypes.EvtAgentOutputToolCall: {
      const incoming = {
        toolCallId: outMsg.data.toolCallId,
        display: outMsg.data.display,
        status: outMsg.data.status,
        ok: outMsg.data.ok,
        error: outMsg.data.error,
      } satisfies SurfaceToolStatusUpdate;
      const update = mergeSubagentToolStatus(toolStatusById.get(incoming.toolCallId), incoming);

      const nextToolStatusById = new Map(toolStatusById);
      nextToolStatusById.delete(update.toolCallId);
      nextToolStatusById.set(update.toolCallId, update);
      toolStatusById = nextToolStatusById;

      part = {
        type: "tool.status",
        update,
      };
      break;
    }
  }

  return {
    state: {
      totalTextChars,
      streamTextPrefixChars,
      streamPhaseBoundaryPrefixChars,
      streamPhaseBoundaryOffsetChars,
      streamPhaseBoundaryPrefix,
      awaitingFinalPhaseBoundaryPrefix,
      visibleTextAcc,
      textPhase,
      commentaryText,
      finalAnswerText,
      phaseSegmentsValid,
      reasoningStartedAtMs,
      reasoningFrozenAtMs,
      reasoningDetailText,
      pendingNoReplyPrefix,
      bufferNoReplyPrefix,
      toolStatusById,
    },
    part,
  };
}
