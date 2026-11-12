import { afterAll, beforeAll, expect, test } from "bun:test";
import { startE2E, type E2E, type NativeSession } from "./harness";

let e2e: E2E;
let session: NativeSession;
beforeAll(async () => {
  e2e = await startE2E();
  session = await e2e.session({ style: "web" });
}, 60_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  expect(e2e?.model.unhandled ?? []).toEqual([]);
}, 60_000);

/** A child script that runs one tool and reports its output. */
function childScript(name: string, marker: string) {
  return e2e.model.script(name, (_request, model) => {
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: `echo ${marker}` } }] };
    return { text: `Child result: ${model.json<{ stdout: string }>("bash").stdout.trim()}` };
  });
}

test("a sync subagent runs as its own agent and returns its result to the parent", async () => {
  const childTag = childScript("child-sync", "child-sync-output");
  const tag = e2e.model.script("parent-sync", (request, model) => {
    if (model.step === 0) {
      expect(request.tools).toContain("subagent_delegate");
      return {
        toolCalls: [
          {
            name: "subagent_delegate",
            args: { task: `${childTag} Run the child check.`, title: "Child check", mode: "sync" },
          },
        ],
      };
    }
    return { text: `Parent saw: ${model.result("subagent_delegate")}` };
  });
  const threadId = await session.createThread("Sync subagent");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} Delegate the check.`);
  const [turn] = await session.settled(store, 1);
  expect(turn!.state).toBe("complete");
  expect(turn!.assistant).toContain("Child result: child-sync-output");

  // The child ran its own model calls with its own task, not the parent's conversation.
  const child = e2e.model.forScenario("child-sync");
  expect(child).toHaveLength(2);
  expect(JSON.stringify(child[0]!.request.messages)).not.toContain("Delegate the check.");

  const listed = await session.rpc.subagents.list({ threadId });
  expect(listed.items).toEqual([
    expect.objectContaining({ state: "complete", turnId: turn!.turnId }),
  ]);
  const agent = listed.items[0]!;
  const read = await session.rpc.subagents.read({ threadId, agentId: agent.id });
  expect(read.unavailable).toBe(false);
  expect(JSON.stringify(read.messages)).toContain("child-sync-output");

  // The client's subagent stream renders the child's work under the id the list returned.
  const childStore = session.watch({ kind: "subagent", threadId, agentId: agent.id });
  const childTurns = await session.waitForTurns(
    childStore,
    (rendered) =>
      rendered.some((candidate) => candidate.assistant.includes("Child result: child-sync-output")),
    "child stream rendered",
  );
  expect(childTurns.flatMap((candidate) => candidate.activities)).toEqual([
    expect.objectContaining({
      state: "complete",
      output: expect.stringContaining("child-sync-output"),
    }),
  ]);
}, 60_000);

test("a deferred subagent's result reaches the parent after the parent's turn ends", async () => {
  const childTag = childScript("child-deferred", "child-deferred-output");
  const tag = e2e.model.script("parent-deferred", (_request, model) => {
    const seen = JSON.stringify(model.request.messages);
    if (seen.includes("Child result: child-deferred-output") && !model.lastToolResults.length)
      return { text: "Parent received the deferred result." };
    if (model.step === 0)
      return {
        toolCalls: [
          {
            name: "subagent_delegate",
            args: {
              task: `${childTag} Run the deferred check.`,
              title: "Deferred check",
              mode: "deferred",
            },
          },
        ],
      };
    const accepted = model.json<{ status: string; workflowRunId: string }>("subagent_delegate");
    expect(accepted.status).toBe("accepted");
    return { text: "Started the deferred check." };
  });
  const threadId = await session.createThread("Deferred subagent");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} Delegate in the background.`);
  const turns = await session.waitForTurns(
    store,
    (rendered) =>
      rendered.some((candidate) =>
        candidate.assistant.includes("Parent received the deferred result."),
      ) && rendered.every((candidate) => candidate.state === "complete"),
    "deferred result delivered",
  );
  expect(JSON.stringify(turns)).toContain("Started the deferred check.");
  const listed = await session.rpc.subagents.list({ threadId });
  expect(listed.items).toEqual([expect.objectContaining({ state: "complete" })]);
}, 60_000);
