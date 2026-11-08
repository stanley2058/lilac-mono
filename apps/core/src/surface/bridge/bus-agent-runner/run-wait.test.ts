import { expect, test } from "bun:test";
import { nativeToolOnlyWaits } from "./native-activity-result";
import { createRunWaitTracker } from "./run-wait";

function fixture() {
  const reports: boolean[] = [];
  return { reports, tracker: createRunWaitTracker((waiting) => reports.push(waiting)) };
}

test("only sync subagents and sync questions count as waiting tools", () => {
  const onlyWaits = (toolName: string, args: unknown) =>
    nativeToolOnlyWaits({ toolName, event: { args } });
  expect(onlyWaits("subagent_delegate", { mode: "sync" })).toBe(true);
  expect(onlyWaits("question", { mode: "sync" })).toBe(true);
  expect(onlyWaits("subagent_delegate", { mode: "deferred" })).toBe(false);
  expect(onlyWaits("question", {})).toBe(false);
  expect(onlyWaits("bash", { mode: "sync" })).toBe(false);
});

test("a waiting tool parks the run until it returns", () => {
  const { reports, tracker } = fixture();
  tracker.toolStarted("call", true);
  expect(reports).toEqual([true]);
  tracker.toolEnded("call");
  expect(reports).toEqual([true, false]);
});

test("a tool doing its own work keeps the run working", () => {
  const { reports, tracker } = fixture();
  tracker.toolStarted("bash", false);
  expect(reports).toEqual([]);
});

test("another tool running beside a waiting tool keeps the run working", () => {
  const { reports, tracker } = fixture();
  tracker.toolStarted("subagent", true);
  tracker.toolStarted("bash", false);
  expect(reports).toEqual([true, false]);
  tracker.toolEnded("bash");
  expect(reports).toEqual([true, false, true]);
});

test("an idle wait stays parked across wakes until the model resumes", () => {
  const { reports, tracker } = fixture();
  tracker.enterIdleWait();
  tracker.enterIdleWait();
  expect(reports).toEqual([true]);
  tracker.resume();
  expect(reports).toEqual([true, false]);
});

test("a new model turn clears tool waits the previous attempt never closed", () => {
  const { reports, tracker } = fixture();
  tracker.toolStarted("lost", true);
  tracker.resume();
  expect(reports).toEqual([true, false]);
});
