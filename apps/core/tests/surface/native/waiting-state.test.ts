import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { expect, test } from "bun:test";
import type { NativeThread } from "@stanley2058/lilac-client-protocol";
import { createNativeIntegrationFixture, nativeFixtureTextResponse } from "./integration-fixture";
import { seedNativeWorkflowRun } from "./workflow-fixture";

function fixtureModel(mode: "sync" | "deferred") {
  return new MockLanguageModelV4({
    modelId: "waiting-fixture",
    doStream: async ({ prompt }) => {
      if (prompt.at(-1)?.role === "tool") return nativeFixtureTextResponse("NO_REPLY");
      return {
        stream: simulateReadableStream({
          chunks: [
            {
              type: "tool-call" as const,
              toolCallId: "ask",
              toolName: "question",
              input: JSON.stringify({
                mode,
                questions: [
                  {
                    id: "target",
                    header: "Target",
                    question: "Where should this go?",
                    options: [
                      { id: "staging", label: "Staging", description: "Use staging" },
                      { id: "production", label: "Production", description: "Use production" },
                    ],
                  },
                ],
              }),
            },
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
              usage: {
                inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 0, text: 0, reasoning: 0 },
              },
            },
          ],
        }),
      };
    },
  });
}

async function parkedFixture(mode: "sync" | "deferred") {
  const fixture = await createNativeIntegrationFixture({
    model: fixtureModel(mode),
    questions: true,
    additionalLocalUsers: [
      { userId: "reader", username: "reader", password: "reader-fixture-password" },
    ],
  });
  const iterators: AsyncIterator<unknown>[] = [];
  const { client: owner } = fixture.connect();
  const { client: reader } = fixture.connect(
    await fixture.loginAs("reader", "reader-fixture-password"),
  );
  const thread = await owner.threads.create({ commandId: crypto.randomUUID(), title: "Parked" });
  await owner.participants.set({ threadId: thread.id, userId: "reader", role: "read" });

  async function statusStream(client: typeof owner) {
    const { catalogCursor } = await client.bootstrap.get({});
    const events = await client.bootstrap.watch({ cursor: catalogCursor });
    const iterator = events[Symbol.asyncIterator]();
    iterators.push(iterator);
    return async function until(matches: (thread: NativeThread) => boolean) {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) throw new Error("Catalog stream ended");
        if (value.kind === "thread" && value.thread.id === thread.id && matches(value.thread))
          return value.thread;
      }
    };
  }
  return {
    fixture,
    ownerStatus: await statusStream(owner),
    readerStatus: await statusStream(reader),
    thread,
    ask: () =>
      owner.inputs.submit({
        threadId: thread.id,
        text: "Ask me",
        mode: "prompt",
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        attachmentIds: [],
        skillIds: [],
      }),
    async close() {
      await Promise.all(iterators.map((iterator) => iterator.return?.()));
      await fixture.close();
    },
  };
}

test("a run parked on a sync question shows input to its respondent and waiting to readers", async () => {
  const f = await parkedFixture("sync");
  try {
    await f.ask();
    expect(await f.ownerStatus((thread) => thread.waitingOn === "input")).toMatchObject({
      displayStatus: "working",
    });
    expect(await f.readerStatus((thread) => thread.waitingOn === "other")).toMatchObject({
      displayStatus: "working",
    });
    expect(f.fixture.store.notificationContent("owner", f.thread.id).unwrap().body).toBe(
      "Needs your input",
    );
    expect(f.fixture.fatalErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a deferred question ends the run and leaves only its respondent on input", async () => {
  const f = await parkedFixture("deferred");
  try {
    await f.ask();
    await f.ownerStatus((thread) => thread.displayStatus === "input");
    const reader = await f.readerStatus((thread) => !thread.activeRunId);
    expect(reader.waitingOn).toBeUndefined();
    expect(reader.displayStatus).not.toBe("input");
    expect(f.fixture.fatalErrors).toEqual([]);
  } finally {
    await f.close();
  }
});

test("the workflow list pages past one page over the wire", async () => {
  const fixture = await createNativeIntegrationFixture();
  try {
    const owner = fixture.connect().client;
    for (let index = 0; index < 32; index += 1)
      seedNativeWorkflowRun(fixture.workflows, {
        id: `run-${index}`,
        name: `audit-${index}`,
        state: "succeeded",
        platform: "discord",
        createdAt: 1_000 - index,
      });
    const first = await owner.workflows.list({ state: "done", limit: 30 });
    expect(first.items).toHaveLength(30);
    const second = await owner.workflows.list({
      state: "done",
      limit: 30,
      cursor: first.nextCursor,
    });
    expect(second.items.map((run) => run.card.name)).toEqual(["audit-30", "audit-31"]);
    expect(second.nextCursor).toBeUndefined();

    const search = await owner.workflows.list({ state: "done", limit: 30, query: "AUDIT-31" });
    expect(search.items.map((run) => run.card.name)).toEqual(["audit-31"]);

    const one = await owner.workflows.get({ runId: search.items[0]!.id, preview: true });
    expect(one.card.name).toBe("audit-31");
  } finally {
    await fixture.close();
  }
});

test("the workflow list applies owner and thread access over the wire", async () => {
  const fixture = await createNativeIntegrationFixture({
    additionalLocalUsers: [
      { userId: "reader", username: "reader", password: "reader-fixture-password" },
    ],
  });
  try {
    const owner = fixture.connect().client;
    const reader = fixture.connect(
      await fixture.loginAs("reader", "reader-fixture-password"),
    ).client;
    const privateThread = await owner.threads.create({
      commandId: crypto.randomUUID(),
      title: "Private",
    });
    seedNativeWorkflowRun(fixture.workflows, {
      id: "private",
      name: "private-run",
      state: "running",
      threadId: privateThread.id,
      createdAt: 2,
    });
    seedNativeWorkflowRun(fixture.workflows, {
      id: "detached",
      name: "detached-run",
      state: "queued",
      createdAt: 1,
    });
    const active = { state: "active" as const, limit: 30 };
    expect((await owner.workflows.list(active)).items.map((run) => run.card.name)).toEqual([
      "private-run",
      "detached-run",
    ]);
    expect((await reader.workflows.list(active)).items).toEqual([]);
  } finally {
    await fixture.close();
  }
});
