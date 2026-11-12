import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, open } from "node:fs/promises";
import path from "node:path";
import { startE2E, type E2E, type NativeSession, type RenderedTurn } from "./harness";

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

/** A FIFO the agent's bash command blocks on until the test writes to it. */
async function barrier() {
  const directory = await mkdtemp(path.join(e2e.layout.directory, "barrier-"));
  const fifo = path.join(directory, "go");
  const made = Bun.spawnSync(["mkfifo", fifo]);
  if (made.exitCode !== 0) throw new Error("mkfifo failed");
  return {
    command: `read line < ${fifo}; echo "released:$line"`,
    async release(value = "ok") {
      const handle = await open(fifo, "w");
      await handle.write(`${value}\n`);
      await handle.close();
    },
  };
}

test("a steer sent while a tool runs is always answered, rendered and kept in history", async () => {
  const gate = await barrier();
  const tag = e2e.model.script("steer", (_request, model) => {
    if (model.lastUserText.includes("What did you say last?")) return { text: "Recalled." };
    if (model.userTexts.some((text) => text.includes("Also mention penguins")))
      return { text: "Steered reply about penguins." };
    if (model.step === 0) return { toolCalls: [{ name: "bash", args: { command: gate.command } }] };
    return { text: "Unsteered reply." };
  });
  const threadId = await session.createThread("Steer");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} Run the long task.`);
  await session.waitForTurns(
    store,
    (turns) =>
      turns.some((turn) => turn.activities.some((activity) => activity.state === "running")),
    "tool running",
  );
  await session.send(threadId, "Also mention penguins.", { mode: "steer" });
  await session.waitForTurns(
    store,
    (turns) => JSON.stringify(turns).includes("Also mention penguins."),
    "steer rendered",
  );
  await gate.release();
  // The steer reaches the run in time, or misses it and continues as a follow-up turn. Either
  // way the model answers it and the answer renders; it never ends unanswered.
  const turns = await session.waitForTurns(
    store,
    (rendered) =>
      rendered.every((turn) => turn.state === "complete") &&
      rendered.some((turn) => turn.assistant.includes("Steered reply about penguins.")),
    "steer answered",
  );
  const steer = turns
    .flatMap((turn) => turn.messages)
    .find(
      (message) => message.role === "user" && JSON.stringify(message.parts).includes("penguins"),
    );
  expect(steer?.metadata?.inputId).toBeDefined();
  expect(session.inputState(steer!.metadata!.inputId!)).not.toBe("target-ended");
  expect(
    e2e.model
      .forScenario("steer")
      .filter((entry) => entry.reply?.text === "Steered reply about penguins."),
  ).toHaveLength(1);
  await session.send(threadId, "What did you say last?");
  const next = await e2e.model.waitFor(
    (entry) => entry.scenario === "steer" && entry.reply?.text === "Recalled.",
    "next turn",
  );
  expect(
    next.request.messages.some(
      (message) =>
        message.role === "assistant" && message.text.includes("Steered reply about penguins."),
    ),
  ).toBe(true);
}, 60_000);

test("a follow-up queued during a run starts its own turn after the run ends", async () => {
  const gate = await barrier();
  const tag = e2e.model.script("followup", (_request, model) => {
    if (model.lastUserText.includes("Second question")) return { text: "Second answer." };
    if (model.step === 0) return { toolCalls: [{ name: "bash", args: { command: gate.command } }] };
    return { text: "First answer." };
  });
  const threadId = await session.createThread("Follow-up");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} First question.`);
  await session.waitForTurns(
    store,
    (turns) =>
      turns.some((turn) => turn.activities.some((activity) => activity.state === "running")),
    "tool running",
  );
  await session.send(threadId, "Second question.", { mode: "followup" });
  await gate.release();
  const turns = await session.settled(store, 2, "both turns");
  expect(
    turns.map((turn) => [
      turn.user.includes("Second question") ? "second" : "first",
      turn.assistant,
    ]),
  ).toEqual([
    ["first", expect.stringContaining("First answer.")],
    ["second", expect.stringContaining("Second answer.")],
  ]);
  const requests = e2e.model.forScenario("followup");
  // The follow-up's model call sees the first exchange as settled history.
  const last = requests.at(-1)!.request.messages;
  expect(
    last.some((message) => message.role === "assistant" && message.text.includes("First answer.")),
  ).toBe(true);
}, 60_000);

const QUESTION = {
  questions: [
    {
      id: "color",
      header: "Color",
      question: "Which color should the banner use?",
      options: [
        { id: "red", label: "Red", description: "Warm" },
        { id: "blue", label: "Blue", description: "Cool" },
      ],
    },
  ],
};

for (const mode of ["sync", "deferred"] as const) {
  test(`a ${mode} question round-trips through the client's reply`, async () => {
    const tag = e2e.model.script(`question-${mode}`, (_request, model) => {
      if (
        model.userTexts.some((text) => text.includes("Blue, please")) ||
        model.lastToolResults.some((result) => result.output.includes("Blue, please"))
      )
        return { text: `Using blue (${mode}).` };
      if (model.step === 0)
        return { toolCalls: [{ name: "question", args: { ...QUESTION, mode } }] };
      return { text: `Waiting for the answer (${mode}).` };
    });
    const threadId = await session.createThread(`Question ${mode}`);
    const store = session.watch(threadId);
    await session.send(threadId, `${tag} Make a banner.`);
    const [asked] = await session
      .waitForTurns(
        store,
        (turns) =>
          turns.some((turn) => turn.questions.some((part) => part.data.view.state === "pending")),
        "pending question",
      )
      .then((turns) => turns.flatMap((turn) => turn.questions));
    const pending = await session.rpc.questions.pending({ threadId });
    expect(JSON.stringify(pending)).toContain(asked!.data.questionCallId);
    if (asked!.data.view.state !== "pending") throw new Error("Question is not pending");
    await session.send(threadId, "Blue, please.", {
      mode: mode === "sync" ? "steer" : "prompt",
      questionReply: {
        messageId: asked!.data.questionCallId,
        token: asked!.data.view.prompt.customToken,
      },
    });
    const turns = await session.waitForTurns(
      store,
      (rendered) => rendered.some((turn) => turn.assistant.includes(`Using blue (${mode}).`)),
      "answered reply",
    );
    await session.settled(store, turns.length);
    const answered = turns
      .flatMap((turn) => turn.questions)
      .find((part) => part.data.questionCallId === asked!.data.questionCallId);
    expect(answered?.data.view.state).toBe("answered");
    expect(JSON.stringify(await session.rpc.questions.pending({ threadId }))).not.toContain(
      asked!.data.questionCallId,
    );
  }, 60_000);
}

test("an agent's message to another thread is delivered after the sender finishes", async () => {
  const destination = await session.createThread("Destination");
  const destinationStore = session.watch(destination);
  const tag = e2e.model.script("cross-thread", (_request, model) => {
    if (model.step === 0)
      return {
        toolCalls: [
          {
            name: "bash",
            args: {
              command: `echo "self=$LILAC_SESSION_ID" && tools surface.messages.send --client=native --session-id=${destination} --text="Hello from the sender"`,
            },
          },
        ],
      };
    const bash = model.json<{ stdout: string; exitCode: number }>("bash");
    expect(bash.exitCode).toBe(0);
    return { text: `Sent. ${bash.stdout.split("\n")[0]}` };
  });
  const sender = await session.createThread("Sender");
  const senderStore = session.watch(sender);
  await session.send(sender, `${tag} Tell the other thread hello.`);
  const [turn] = await session.settled(senderStore, 1);
  expect(turn!.assistant).toContain(`self=native:${sender}`);
  const delivered = await session.waitForTurns(
    destinationStore,
    (turns) =>
      turns.some((candidate) =>
        JSON.stringify(candidate.messages).includes("Hello from the sender"),
      ),
    "queued message delivered",
  );
  // The send lands as the agent's own message and starts no run in the destination.
  expect(delivered.map((candidate) => [candidate.user, candidate.assistant])).toEqual([
    ["", "Hello from the sender"],
  ]);
  expect(
    e2e.model.requests.filter(
      (entry) =>
        JSON.stringify(entry.request.messages).includes("Hello from the sender") &&
        entry.scenario !== "cross-thread",
    ),
  ).toEqual([]);
}, 60_000);
