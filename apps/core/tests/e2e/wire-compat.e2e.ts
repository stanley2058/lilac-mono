import { expect, test } from "bun:test";
import {
  MemoryNativeCache,
  type CachePatch,
  type CacheScope,
} from "../../../../packages/client/src";
import { assertCompatible, loadCompatValidators } from "../helpers/client-compat";
import { startE2E } from "./harness";

test("previous-release clients decode real Core replies, events and cache writes", async () => {
  const validators = await loadCompatValidators();
  const captured: { kind: string; payload: unknown }[] = [];
  const capture = (kind: string, payload: unknown) => {
    // Keep a copy before the client can transform or mutate a reply.
    captured.push({ kind, payload: JSON.parse(JSON.stringify(payload)) });
  };
  class ObservedCache extends MemoryNativeCache {
    override async commit(scope: CacheScope, threadId: string, patch: CachePatch) {
      capture("cachePatch", patch);
      const outcome = await super.commit(scope, threadId, patch);
      const row = await this.read(scope, threadId);
      if (row) capture("cacheRow", row);
      return outcome;
    }
  }
  await using e2e = await startE2E();
  const admin = await e2e.session();
  const deployment = await admin.rpc.config.readDeployment({});
  await admin.rpc.config.setDeployment({
    settings: { ...deployment.settings, transport: "http-sse" },
    expectedRevision: deployment.revision,
  });
  const session = await e2e.session({
    transport: "http-sse",
    observePayload: capture,
    cache: new ObservedCache(),
  });
  const threadId = await session.createThread("Wire compatibility");
  const store = session.watch(threadId);
  const body = "Compatibility upload\n";
  const resource = await session.rpc.resources.reserve({
    threadId,
    commandId: crypto.randomUUID(),
    name: "compat.txt",
    mediaType: "text/plain",
    size: body.length,
  });
  const upload = await fetch(`${e2e.layout.nativeUrl}/api/uploads/${resource.id}`, {
    method: "PUT",
    headers: {
      cookie: session.credentials.cookie,
      origin: e2e.layout.nativeUrl,
      "content-type": "text/plain",
    },
    body,
  });
  expect(upload.ok).toBe(true);
  const tag = e2e.model.script("compat-tool", (_request, model) =>
    model.step === 0
      ? { toolCalls: [{ name: "bash", args: { command: "echo compatibility-tool" } }] }
      : { text: "Tool finished." },
  );
  await session.send(threadId, `${tag} Run tool.`, { attachmentIds: [resource.id] });
  const [tool] = await session.settled(store, 1);
  expect(tool!.activities[0]?.state).toBe("complete");
  expect(JSON.stringify(tool!.messages)).toContain("compat.txt");

  const questionTag = e2e.model.script("compat-question", (_request, model) => {
    if (model.lastToolResults.some((result) => result.output.includes("Blue")))
      return { text: "Answered blue." };
    return {
      toolCalls: [
        {
          name: "question",
          args: {
            mode: "sync",
            questions: [
              {
                id: "color",
                header: "Color",
                question: "Which color?",
                options: [
                  { id: "blue", label: "Blue", description: "Cool" },
                  { id: "red", label: "Red", description: "Warm" },
                ],
              },
            ],
          },
        },
      ],
    };
  });
  await session.send(threadId, `${questionTag} Choose.`);
  const asking = await session.waitForTurns(
    store,
    (turns) => turns.some((turn) => turn.questions.some((q) => q.data.view.state === "pending")),
    "pending question",
  );
  const question = asking
    .flatMap((turn) => turn.questions)
    .find((q) => q.data.view.state === "pending")!;
  expect((await session.rpc.questions.pending({ threadId })).length).toBe(1);
  if (question.data.view.state !== "pending") throw new Error("Expected pending question");
  await session.send(threadId, "Blue", {
    mode: "steer",
    questionReply: {
      messageId: question.data.questionCallId,
      token: question.data.view.prompt.customToken,
    },
  });
  await session.waitForTurns(
    store,
    (turns) =>
      turns.some((turn) => turn.questions.some((q) => q.data.view.state === "answered")) &&
      turns.some((turn) => turn.assistant.includes("Answered blue.")),
    "answered question",
  );

  const childTag = e2e.model.script("compat-child", () => ({ text: "Child complete." }));
  const parentTag = e2e.model.script("compat-parent", (_request, model) =>
    model.step === 0
      ? {
          toolCalls: [
            {
              name: "subagent_delegate",
              args: { task: `${childTag} Check.`, title: "Compat child", mode: "sync" },
            },
          ],
        }
      : { text: "Parent complete." },
  );
  const parent = await session.createThread("Subagent compatibility");
  const parentStore = session.watch(parent);
  await session.send(parent, `${parentTag} Delegate.`);
  await session.settled(parentStore, 1);
  const agents = await session.rpc.subagents.list({ threadId: parent });
  expect(agents.items.length).toBe(1);
  const agentId = agents.items[0]!.id;
  await session.rpc.subagents.read({ threadId: parent, agentId });
  const childStore = session.watch({ kind: "subagent", threadId: parent, agentId });
  await session.settled(childStore, 1);
  await session.rpc.workflows.list({ state: "done" });
  await session.rpc.config.readDeployment({});
  await session.rpc.catalogs.get({});
  await session.rpc.threads.sync({ threadId });

  const failedTag = e2e.model.script("compat-failed", () => ({
    fault: { kind: "error", status: 400, message: "Compatibility failure" },
  }));
  const failed = await session.createThread("Failed compatibility");
  const failedStore = session.watch(failed);
  await session.send(failed, `${failedTag} Fail.`);
  const [failedTurn] = await session.settled(failedStore, 1);
  expect(failedTurn!.state).toBe("failed");
  const checkpoint = failedStore.checkpoint!;
  await session.rpc.threads.rewind({
    threadId: failed,
    turnId: failedTurn!.turnId,
    commandId: crypto.randomUUID(),
    historyGeneration: checkpoint.historyGeneration,
    expectedRevision: checkpoint.projectionRevision,
  });
  await session.waitForTurns(failedStore, (turns) => turns.length === 0, "rewind replay");
  await session.close();

  const kinds = new Set(captured.map((entry) => entry.kind));
  for (const kind of [
    "bootstrap",
    "streams.watch",
    "inputs.submit",
    "questions.pending",
    "subagents.read",
    "resources.reserve",
    "threads.rewind",
    "threads.sync",
    "config.readDeployment",
    "catalogs.get",
    "cachePatch",
    "cacheRow",
  ])
    expect(kinds.has(kind), `Missing ${kind}; captured ${[...kinds].join(", ")}`).toBe(true);
  for (const { kind, payload } of captured) assertCompatible(validators, kind, payload);
  expect(e2e.model.unhandled).toEqual([]);
}, 120_000);
