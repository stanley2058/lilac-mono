import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  startE2E,
  type E2E,
  type ModelMessage,
  type NativeSession,
  type RenderedTurn,
} from "./harness";
import { previousRelease, type PreviousRelease } from "./harness/previous-release";

/**
 * The previous release writes real conversations, then this checkout boots on the same data and
 * Redis, including a run the upgrade interrupted.
 */
let e2e: E2E;
let previous: PreviousRelease;
const threads: Record<string, string> = {};
let before: Record<string, RenderedTurn[]> = {};

function expectPairedToolCalls(messages: ModelMessage[]) {
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? message.toolCalls.map((call) => call.id) : [],
  );
  const results = messages.flatMap((message) => (message.role === "tool" ? [message.callId] : []));
  expect(results.toSorted()).toEqual(calls.toSorted());
}

function comparable(turns: RenderedTurn[]) {
  return turns.map((turn) => ({
    state: turn.state,
    user: turn.user,
    assistant: turn.assistant,
    activities: turn.activities,
    questions: turn.questions.map((part) => part.data.view.state),
  }));
}

async function writeOldState(session: NativeSession) {
  await writeFile(path.join(e2e.layout.workspace, "upgrade.txt"), "written before upgrade\n");
  const toolTag = e2e.model.script("upgrade-tools", (_request, model) => {
    if (model.lastUserText.includes("after upgrade")) {
      expectPairedToolCalls(model.request.messages);
      const history = JSON.stringify(model.request.messages);
      return {
        text: `History kept: ${history.includes("written before upgrade") && history.includes("Old answer.")}`,
      };
    }
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: "cat upgrade.txt" } }] };
    return { text: "Old answer." };
  });
  threads.tools = await session.createThread("Upgrade tools");
  const toolStore = session.watch(threads.tools);
  await session.send(threads.tools, `${toolTag} Read the file.`);
  await session.settled(toolStore, 1);

  const questionTag = e2e.model.script("upgrade-question", (_request, model) => {
    if (model.userTexts.some((text) => text.includes("Blue after upgrade")))
      return { text: "Using blue after the upgrade." };
    if (model.step > 0) return { text: "Waiting for the color." };
    return {
      toolCalls: [
        {
          name: "question",
          args: {
            mode: "deferred",
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Which color?",
                options: [
                  { id: "red", label: "Red", description: "Warm" },
                  { id: "blue", label: "Blue", description: "Cool" },
                ],
              },
            ],
          },
        },
      ],
    };
  });
  threads.question = await session.createThread("Upgrade question");
  const questionStore = session.watch(threads.question);
  await session.send(threads.question, `${questionTag} Pick a color.`);
  await session.waitForTurns(
    questionStore,
    (turns) =>
      turns.some((turn) => turn.questions.some((part) => part.data.view.state === "pending")) &&
      turns.every((turn) => turn.state === "complete"),
    "pending question before upgrade",
  );

  const childTag = e2e.model.script("upgrade-child", (_request, model) => {
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: "echo child-before-upgrade" } }] };
    return { text: "Child done before upgrade." };
  });
  const parentTag = e2e.model.script("upgrade-parent", (_request, model) => {
    if (model.step === 0)
      return {
        toolCalls: [
          {
            name: "subagent_delegate",
            args: { task: `${childTag} Check.`, title: "Upgrade child", mode: "sync" },
          },
        ],
      };
    return { text: "Parent done before upgrade." };
  });
  threads.subagent = await session.createThread("Upgrade subagent");
  const subagentStore = session.watch(threads.subagent);
  await session.send(threads.subagent, `${parentTag} Delegate.`);
  await session.settled(subagentStore, 1);

  for (const [name, threadId] of Object.entries(threads))
    before[name] = await session.settled(session.watch(threadId), 1);
}

beforeAll(async () => {
  previous = await previousRelease();
  e2e = await startE2E({ root: previous.root });
  const session = await e2e.session({ style: "web", olderServer: true });
  await writeOldState(session);

  // Interrupt a run mid model call, as a deploy restart would.
  const inflightTag = e2e.model.script("upgrade-inflight", (_request, model) => {
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: "echo started-on-old" } }] };
    return { text: "Finished on the new release." };
  });
  threads.inflight = await session.createThread("Upgrade in flight");
  session.watch(threads.inflight);
  const first = e2e.model.hold("upgrade-inflight");
  first.release();
  const held = e2e.model.hold("upgrade-inflight");
  await session.send(threads.inflight, `${inflightTag} Work across the upgrade.`);
  await held.reached;
  await e2e.restart({ kill: true });
  held.release();
}, 600_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  expect(e2e?.model.unhandled ?? []).toEqual([]);
}, 60_000);

test("conversations written by the previous release render the same", async () => {
  const session = await e2e.session({ style: "web" });
  for (const name of ["tools", "question", "subagent"]) {
    const turns = await session.settled(session.watch(threads[name]!), 1, `${name} after upgrade`);
    expect({ name, turns: comparable(turns) }).toEqual({ name, turns: comparable(before[name]!) });
  }
  const listed = await session.rpc.subagents.list({ threadId: threads.subagent! });
  expect(listed.items).toEqual([expect.objectContaining({ state: "complete" })]);
  const read = await session.rpc.subagents.read({
    threadId: threads.subagent!,
    agentId: listed.items[0]!.id,
  });
  expect(JSON.stringify(read.messages)).toContain("child-before-upgrade");
}, 60_000);

test("a run the upgrade interrupted finishes on the new release", async () => {
  const session = await e2e.session({ style: "web" });
  const turns = await session.waitForTurns(
    session.watch(threads.inflight!),
    (rendered) =>
      rendered.length === 1 &&
      rendered[0]!.state === "complete" &&
      rendered[0]!.assistant.includes("Finished on the new release."),
    "interrupted run recovered",
  );
  expect(turns[0]!.activities.filter((activity) => activity.state !== "complete")).toEqual([]);
  const last = e2e.model.forScenario("upgrade-inflight").at(-1)!.request;
  expectPairedToolCalls(last.messages);
  expect(JSON.stringify(last.messages)).toContain("started-on-old");
}, 60_000);

test("a new prompt continues history written by the previous release", async () => {
  const session = await e2e.session({ style: "web" });
  const store = session.watch(threads.tools!);
  await session.send(threads.tools!, "[scenario:upgrade-tools] Summarize after upgrade.");
  const turns = await session.settled(store, 2);
  expect(turns[1]!.assistant).toBe("History kept: true");
}, 60_000);

test("a question asked before the upgrade can be answered after it", async () => {
  const session = await e2e.session({ style: "web" });
  const store = session.watch(threads.question!);
  const [asked] = (await session.settled(store, 1)).flatMap((turn) => turn.questions);
  if (asked?.data.view.state !== "pending") throw new Error("The question is no longer pending");
  await session.send(threads.question!, "Blue after upgrade.", {
    questionReply: {
      messageId: asked.data.questionCallId,
      token: asked.data.view.prompt.customToken,
    },
  });
  const turns = await session.waitForTurns(
    store,
    (rendered) => rendered.some((turn) => turn.assistant.includes("Using blue after the upgrade.")),
    "answer after upgrade",
  );
  const answered = turns
    .flatMap((turn) => turn.questions)
    .find((part) => part.data.questionCallId === asked.data.questionCallId);
  expect(answered?.data.view.state).toBe("answered");
}, 60_000);

test("the previous release is the one that wrote the data", () => {
  expect(previous.tag).toMatch(/^build-/u);
  expect(previous.root).not.toBe(path.resolve(import.meta.dir, "../../../.."));
});
