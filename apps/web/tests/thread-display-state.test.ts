import { expect, test } from "bun:test";
import { threadDisplayState } from "../src/components/ThreadSelect";

test("a parked run shows what it waits on while the wire status stays working", () => {
  expect(threadDisplayState({ displayStatus: "working" })).toBe("working");
  expect(threadDisplayState({ displayStatus: "working", waitingOn: "other" })).toBe("waiting");
  expect(threadDisplayState({ displayStatus: "working", waitingOn: "input" })).toBe("input");
  expect(threadDisplayState({ displayStatus: "input" })).toBe("input");
});

test("older summaries without a status fall back to the active run", () => {
  expect(threadDisplayState({ activeRunId: "run" })).toBe("working");
  expect(threadDisplayState({})).toBe("idle");
});
