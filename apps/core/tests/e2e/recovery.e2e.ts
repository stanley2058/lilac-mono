import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createRedisFaultProxy } from "../../../../packages/event-bus/tests/helpers/isolated-redis";
import { startE2E, type E2E, type ModelMessage, type RenderedTurn } from "./harness";

let e2e: E2E;
beforeAll(async () => {
  e2e = await startE2E();
}, 60_000);
afterAll(async () => {
  await e2e?.[Symbol.asyncDispose]();
  expect(e2e?.model.unhandled ?? []).toEqual([]);
}, 60_000);

/** Every tool call the model made has exactly one result, which providers require. */
function expectPairedToolCalls(messages: ModelMessage[]) {
  const calls = messages.flatMap((message) =>
    message.role === "assistant" ? message.toolCalls.map((call) => call.id) : [],
  );
  const results = messages.flatMap((message) => (message.role === "tool" ? [message.callId] : []));
  expect(results.toSorted()).toEqual(calls.toSorted());
}

function withoutPositions(turns: RenderedTurn[]) {
  return turns.map((turn) =>
    turn.messages.map(({ metadata, ...message }) => {
      if (!metadata) return message;
      const { position: _position, ...rest } = metadata;
      return { ...message, metadata: rest };
    }),
  );
}

function assistantTexts(turns: RenderedTurn[]): string[] {
  return turns.flatMap((turn) =>
    turn.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    ),
  );
}

test("a run killed mid model call resumes after restart and renders once", async () => {
  const tag = e2e.model.script("crash-model", (_request, model) => {
    if (model.step === 0)
      return { toolCalls: [{ name: "bash", args: { command: "echo step-one" } }] };
    return { text: "Recovered final answer." };
  });
  const session = await e2e.session({ style: "web" });
  const threadId = await session.createThread("Crash during model call");
  session.watch(threadId);
  const first = e2e.model.hold("crash-model");
  first.release();
  const held = e2e.model.hold("crash-model");
  await session.send(threadId, `${tag} Do the two-step task.`);
  await held.reached;
  await e2e.restart({ kill: true });
  held.release();

  // Local sessions are process-local by design, so the open web client must end logged out
  // instead of retrying forever.
  await session.loggedOut();
  const fresh = await e2e.session({ style: "web" });
  const turns = await fresh.waitForTurns(
    fresh.watch(threadId),
    (rendered) =>
      rendered.length === 1 &&
      rendered[0]!.state === "complete" &&
      rendered[0]!.assistant.includes("Recovered final answer."),
    "recovered turn",
  );
  expect(
    assistantTexts(turns).filter((text) => text.includes("Recovered final answer.")),
  ).toHaveLength(1);
  expect(turns[0]!.activities.filter((activity) => activity.state !== "complete")).toEqual([]);
  const last = e2e.model.forScenario("crash-model").at(-1)!;
  expectPairedToolCalls(last.request.messages);
  expect(JSON.stringify(last.request.messages)).toContain("step-one");
}, 90_000);

test("a run killed mid tool call resumes with a consistent tool history", async () => {
  const marker = path.join(e2e.layout.directory, "tool-may-finish");
  const tag = e2e.model.script("crash-tool", (_request, model) => {
    if (model.step === 0)
      return {
        toolCalls: [
          {
            name: "bash",
            args: { command: `while [ ! -e ${marker} ]; do sleep 0.05; done; echo tool-finished` },
          },
        ],
      };
    return {
      text: `After restart: ${model.result("bash").includes("tool-finished") ? "ran" : "interrupted"}`,
    };
  });
  const session = await e2e.session({ style: "web" });
  const threadId = await session.createThread("Crash during tool call");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} Run the slow tool.`);
  await session.waitForTurns(
    store,
    (turns) =>
      turns.some((turn) => turn.activities.some((activity) => activity.state === "running")),
    "tool running",
  );
  await e2e.restart({ kill: true });
  await writeFile(marker, "");
  const fresh = await e2e.session({ style: "web" });
  const turns = await fresh.waitForTurns(
    fresh.watch(threadId),
    (rendered) =>
      rendered.length === 1 &&
      rendered[0]!.state === "complete" &&
      rendered[0]!.assistant.includes("After restart:"),
    "recovered tool turn",
  );
  expect(assistantTexts(turns).filter((text) => text.includes("After restart:"))).toHaveLength(1);
  // No tool activity may stay "running" after the run settled.
  expect(turns[0]!.activities.filter((activity) => activity.state === "running")).toEqual([]);
  expectPairedToolCalls(e2e.model.forScenario("crash-tool").at(-1)!.request.messages);
}, 90_000);

test("a client whose connection drops mid run resumes without gaps or duplicates", async () => {
  const proxy = await createRedisFaultProxy(e2e.layout.nativeUrl);
  const via = proxy.url.replace("redis:", "http:");
  try {
    const tag = e2e.model.script("network-drop", (_request, model) => {
      if (model.step === 0)
        return { toolCalls: [{ name: "bash", args: { command: "echo before-drop" } }] };
      if (model.step === 1)
        return { toolCalls: [{ name: "bash", args: { command: "echo during-drop" } }] };
      return { text: "Finished after the drop." };
    });
    const session = await e2e.session({ style: "web", via });
    const threadId = await session.createThread("Network drop");
    const store = session.watch(threadId);
    const first = e2e.model.hold("network-drop");
    first.release();
    const held = e2e.model.hold("network-drop");
    await session.send(threadId, `${tag} Work through the drop.`);
    await held.reached;
    await session.waitForTurns(
      store,
      (turns) => JSON.stringify(turns).includes("before-drop"),
      "first tool rendered",
    );
    proxy.disconnect();
    held.release();
    // The run advances while the client is cut off.
    await e2e.model.waitFor(
      (entry) =>
        entry.scenario === "network-drop" && entry.reply?.text === "Finished after the drop.",
      "run finished during drop",
    );
    proxy.reconnect();
    const turns = await session.waitForTurns(
      store,
      (rendered) =>
        rendered.length === 1 &&
        rendered[0]!.state === "complete" &&
        rendered[0]!.assistant.includes("Finished after the drop."),
      "caught up after reconnect",
    );
    expect(turns[0]!.activities.map((activity) => [activity.state, activity.output])).toEqual([
      ["complete", expect.stringContaining("before-drop")],
      ["complete", expect.stringContaining("during-drop")],
    ]);
    expect(
      assistantTexts(turns).filter((text) => text.includes("Finished after the drop.")),
    ).toHaveLength(1);
    expect(
      session.events.some((event) => event.kind === "connection" && event.state === "offline"),
    ).toBe(true);
    // A fresh client agrees with the resumed one.
    const fresh = await e2e.session({ style: "bearer" });
    const freshTurns = await fresh.settled(fresh.watch(threadId), 1);
    // Live projection omits per-message positions that replay fills in; nothing renders from them.
    expect(withoutPositions(freshTurns)).toEqual(withoutPositions(turns));
  } finally {
    await proxy.close();
  }
}, 90_000);

test("an idle thread survives a Redis restart and the next prompt runs", async () => {
  const tag = e2e.model.script("redis-restart", (_request, model) => ({
    text: `Reply to: ${model.lastUserText.slice(-13)}`,
  }));
  const session = await e2e.session({ style: "web" });
  const threadId = await session.createThread("Redis restart");
  const store = session.watch(threadId);
  await session.send(threadId, `${tag} before outage`);
  await session.settled(store, 1);
  await e2e.stopRedis();
  await e2e.startRedis();
  await session.send(threadId, `${tag} after outage`);
  const turns = await session.settled(store, 2, "turn after Redis restart");
  expect(turns.map((turn) => turn.assistant)).toEqual([
    expect.stringContaining("before outage"),
    expect.stringContaining("after outage"),
  ]);
}, 90_000);
