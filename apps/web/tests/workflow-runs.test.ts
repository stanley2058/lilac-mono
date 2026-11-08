import { expect, test } from "bun:test";
import type { WorkflowCard, WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import type { NativeClient } from "@stanley2058/lilac-client";
import { workflowRunsOptions } from "../src/queries";
import {
  finishedRunsHaveGap,
  mergeNewestFinishedRuns,
  workflowSections,
} from "../src/workflow-runs";

function run(id: string, status: WorkflowCard["status"]): WorkflowRunSummary {
  return {
    id,
    card: {
      name: id,
      description: "",
      status,
      startedAt: 1,
      progress: {
        completed: 0,
        queued: 0,
        active: 0,
        waiting: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
      },
      phases: [],
      steps: [],
      agents: { used: 0, active: 0, queued: 0 },
      sensitive: false,
    },
  };
}

test("runs group by what they need, most urgent first, keeping list order within a section", () => {
  const sections = workflowSections([
    run("done", "succeeded"),
    run("stopped", "cancelled"),
    run("broken", "failed"),
    run("idle", "paused"),
    run("sleeping", "waiting"),
    run("busy", "running"),
    run("next", "queued"),
    run("asking", "waiting-reply"),
    run("stuck", "needs-attention"),
    run("capped", "blocked"),
  ]);
  expect(sections.map((section) => [section.label, section.runs.map((item) => item.id)])).toEqual([
    ["Needs attention", ["asking", "stuck", "capped"]],
    ["Running", ["sleeping", "busy", "next"]],
    ["Paused", ["idle"]],
    ["Failed", ["broken"]],
    ["Finished", ["done", "stopped"]],
  ]);
});

test("empty sections are dropped", () => {
  expect(workflowSections([run("busy", "running")]).map((section) => section.id)).toEqual([
    "running",
  ]);
  expect(workflowSections([])).toEqual([]);
});

test("only active runs poll the whole list; finished history stays put", () => {
  const client = {} as NativeClient;
  expect(workflowRunsOptions(client, "active").refetchInterval).toBe(3_000);
  expect(workflowRunsOptions(client, "finished").refetchInterval).toBe(false);
});

test("a newest page adds unseen runs and keeps loaded history and cursors", () => {
  const history = {
    pageParams: [undefined, "cursor-1"],
    pages: [
      { items: [run("b", "succeeded")], nextCursor: "cursor-1" },
      { items: [run("a", "failed")], nextCursor: "cursor-2" },
    ],
  };
  const merged = mergeNewestFinishedRuns(history, {
    items: [run("c", "succeeded"), run("b", "succeeded")],
    nextCursor: "other",
  });
  expect(merged.pages.map((page) => page.items.map((item) => item.id))).toEqual([
    ["c", "b"],
    ["a"],
  ]);
  expect(merged.pages.map((page) => page.nextCursor)).toEqual(["cursor-1", "cursor-2"]);
  expect(merged.pageParams).toEqual(history.pageParams);
});

test("a newest page with nothing new keeps the same cache object", () => {
  const history = {
    pageParams: [undefined],
    pages: [{ items: [run("a", "failed")] }],
  };
  expect(mergeNewestFinishedRuns(history, { items: [run("a", "failed")] })).toBe(history);
});

test("a full first page with no overlap is a gap; an overlap or a last page is not", () => {
  const history = { pageParams: [undefined], pages: [{ items: [run("a", "failed")] }] };
  const fresh = [run("c", "succeeded"), run("b", "succeeded")];
  expect(finishedRunsHaveGap(history, { items: fresh, nextCursor: "more" })).toBe(true);
  expect(
    finishedRunsHaveGap(history, { items: [...fresh, run("a", "failed")], nextCursor: "more" }),
  ).toBe(false);
  expect(finishedRunsHaveGap(history, { items: fresh })).toBe(false);
});
