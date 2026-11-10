import { describe, expect, it } from "bun:test";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";

import {
  createRelayStreamState,
  reduceRelayStreamEvent,
  type RelayStreamEvent,
} from "../../../src/surface/bridge/relay-output-reducer";

function event(type: RelayStreamEvent["type"], data: unknown, ts = 1): RelayStreamEvent {
  return {
    type,
    data,
    ts,
    topic: "out.req.r",
    key: "r",
    id: `${ts}`,
    headers: {},
  } as RelayStreamEvent;
}

describe("reduceRelayStreamEvent", () => {
  it("returns the next state and part without changing the input state", () => {
    const initial = createRelayStreamState();
    const reasoning = reduceRelayStreamEvent(
      initial,
      event(lilacEventTypes.EvtAgentOutputDeltaReasoning, { delta: "thinking", seq: 1 }, 5),
    );
    expect(reasoning.part).toEqual({
      type: "reasoning.status",
      update: { startedAtMs: 5, frozenAtMs: undefined, detailText: "thinking" },
    });
    const text = reduceRelayStreamEvent(
      reasoning.state,
      event(lilacEventTypes.EvtAgentOutputDeltaText, { delta: "Hello there" }, 9),
    );
    expect(text.part).toEqual({ type: "text.delta", delta: "Hello there", phase: undefined });
    expect(text.state).toMatchObject({
      reasoningFrozenAtMs: 9,
      visibleTextAcc: "Hello there",
      totalTextChars: 11,
      bufferNoReplyPrefix: false,
    });
    const tool = reduceRelayStreamEvent(
      text.state,
      event(lilacEventTypes.EvtAgentOutputToolCall, {
        toolCallId: "call",
        display: "bash",
        status: "start",
      }),
    );
    expect([...tool.state.toolStatusById.keys()]).toEqual(["call"]);
    expect(text.state.toolStatusById.size).toBe(0);
    expect(initial).toEqual(createRelayStreamState());
  });
});
