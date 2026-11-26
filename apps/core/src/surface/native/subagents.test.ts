import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import {
  MAX_REPLAY_TEXT_LENGTH,
  displayMessageSchema,
  type DisplayMessage,
  subagentSummarySchema,
} from "@stanley2058/lilac-client-protocol";
import type { StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import type { WorkflowOperation, WorkflowRun } from "../../workflow/workflow-domain";
import { NativeStore } from "./store";
import { NativeSubagents, subagentMessages, type SubagentSnapshot } from "./subagents";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  const native = new NativeStore(db);
  native.initialize().unwrap();
  for (const id of ["owner", "guest"])
    native
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  const thread = native.createThread("owner", { commandId: "create" }).unwrap();
  const receipt = native
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "prompt",
      historyGeneration: 0,
      mode: "prompt",
      text: "Research",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const input = native.prepareInput(receipt.inputId).unwrap()!;
  native.settleInput(input.id, "admitted").unwrap();
  const target = {
    kind: "live_parent" as const,
    parentRequestId: input.requestId,
    parentSessionId: `native:${thread.id}`,
    parentRequestClient: "native" as const,
    parentToolCallId: "tool-1",
    childRequestId: "child-1",
    childSessionId: "child-session",
    profile: "general" as const,
    sessionName: "Research",
    depth: 1,
    reasoning: null,
    fallbackToSurface: false,
    fallbackProgressTarget: null,
    deferredDelivery: true,
  };
  const run: WorkflowRun = {
    runId: "wfrun:subagent:test",
    revisionId: "revision",
    state: "running",
    inputSchemaSnapshot: {},
    args: {},
    argsSha256: "a".repeat(64),
    origin: {
      requestId: input.requestId,
      sessionId: target.parentSessionId,
      client: "native",
      userId: "owner",
      projectCwd: "/workspace",
    },
    completionTarget: target,
    progressTarget: null,
    terminalDetail: null,
    result: null,
    resultArtifact: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 1,
    startedAt: 2,
    updatedAt: 2,
    terminalAt: null,
  };
  const executionRequestId = "wfr:run:operation:0";
  const operations: WorkflowOperation[] = [
    {
      runId: run.runId,
      operationId: "operation",
      callSiteId: "call",
      parentOperationId: null,
      phase: null,
      label: null,
      kind: "agent",
      input: {},
      inputSha256: "a".repeat(64),
      state: "running",
      attempt: 0,
      requestId: executionRequestId,
      output: null,
      resultArtifact: null,
      error: null,
      usage: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 1,
      startedAt: 2,
      updatedAt: 2,
      terminalAt: null,
    },
  ];
  const runs = [run];
  const predecessors = new Map<string, string>();
  const otherTranscripts = new Map<string, StoredMessageV1[]>();
  let workflowReads = 0;
  let transcriptReads = 0;
  let live: SubagentSnapshot | undefined;
  let saved: StoredMessageV1[] = [
    { role: "user", content: "Research" },
    { role: "assistant", content: "Done" },
  ];
  const service = new NativeSubagents({
    native,
    streamingMode: () => "paragraph",
    workflows: {
      getWorkflowRequestDispatchPolicy: () => Result.ok(null),
      getOperationByRequestId: (id) =>
        Result.ok(operations.find((operation) => operation.requestId === id) ?? null),
      getRun: (id) => {
        workflowReads++;
        return Result.ok(runs.find((entry) => entry.runId === id) ?? null);
      },
      listSubagentRuns: () => {
        workflowReads++;
        return Result.ok(runs);
      },
      listSubagentFollowUps: (_session, runIds) =>
        Result.ok(
          new Map(
            runIds.flatMap((id) => {
              const previousRunId = predecessors.get(id);
              return previousRunId ? [[id, { firstRunId: run.runId, previousRunId }]] : [];
            }),
          ),
        ),
      listOperations: (runId) => {
        workflowReads++;
        return Result.ok(operations.filter((operation) => operation.runId === runId));
      },
    },
    transcripts: {
      getRequestTranscript: ({ requestId }) => {
        transcriptReads++;
        const messages = requestId === executionRequestId ? saved : otherTranscripts.get(requestId);
        if (!messages) return Result.ok(null);
        return Result.ok({
          requestId,
          sessionId: target.childSessionId,
          requestClient: "native",
          createdTs: 1,
          updatedTs: 2,
          messages,
        });
      },
    },
    live: () => ({
      readSubagentSnapshot: (sessionId, requestId) =>
        sessionId === target.childSessionId && requestId === executionRequestId ? live : undefined,
    }),
  });
  return {
    native,
    thread,
    input,
    run,
    target,
    operations,
    executionRequestId,
    service,
    addRun: (value: WorkflowRun) => runs.push(value),
    addOperation: (value: WorkflowOperation) => operations.push(value),
    setPrevious: (runId: string, previousId: string) => predecessors.set(runId, previousId),
    setTranscript: (requestId: string, messages: StoredMessageV1[]) =>
      otherTranscripts.set(requestId, messages),
    counters: () => ({ workflowReads, transcriptReads }),
    setLive: (value: SubagentSnapshot | undefined) => {
      live = value;
    },
    setSaved: (value: StoredMessageV1[]) => {
      saved = value;
    },
    read: (actor = "owner", before?: number) =>
      service.read(actor, { threadId: thread.id, agentId: run.runId, before }),
  };
}

test("subagent reads authorize the parent before accessing workflow or transcript data", () => {
  const f = fixture();
  expect(f.read("guest").isErr()).toBe(true);
  expect(f.service.list("guest", { threadId: f.thread.id }).isErr()).toBe(true);
  expect(f.counters()).toEqual({ workflowReads: 0, transcriptReads: 0 });
  f.native.shareThread("owner", { threadId: f.thread.id, userId: "guest", grant: "read" }).unwrap();
  expect(f.read("guest").unwrap().messages).toHaveLength(2);
  f.native.shareThread("owner", { threadId: f.thread.id, userId: "guest", grant: null }).unwrap();
  expect(f.read("guest").isErr()).toBe(true);
  expect(f.counters().transcriptReads).toBe(1);
});

test("nested subagents name the subagent that delegated them", () => {
  const f = fixture();
  f.addRun({
    ...f.run,
    runId: "wfrun:subagent:nested",
    completionTarget: {
      ...f.target,
      parentRequestId: f.executionRequestId,
      parentSessionId: f.target.childSessionId,
      parentToolCallId: "tool-2",
      childRequestId: "child-2",
      childSessionId: "nested-session",
      depth: 2,
    },
  });
  const items = f.service.list("owner", { threadId: f.thread.id }).unwrap().items;
  expect(items.map((item) => [item.id, item.parentId])).toEqual([
    [f.run.runId, undefined],
    ["wfrun:subagent:nested", f.run.runId],
  ]);
});

function addFollowUp(
  f: ReturnType<typeof fixture>,
  state: WorkflowRun["state"] = "running",
  { name = "follow-up", previous = f.run.runId, createdAt = 3 } = {},
) {
  const runId = `wfrun:subagent:${name}`;
  const requestId = `wfr:${name}:operation:0`;
  f.addRun({
    ...f.run,
    runId,
    state,
    createdAt,
    startedAt: createdAt + 1,
    completionTarget: { ...f.target, parentToolCallId: `tool-${name}`, childRequestId: name },
  });
  f.addOperation({ ...f.operations[0]!, runId, operationId: name, requestId });
  f.setPrevious(runId, previous);
  return { runId, requestId };
}

function texts(messages: readonly DisplayMessage[]) {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
}

test("follow-up subagent runs name the run that started their session", () => {
  const f = fixture();
  const followUp = addFollowUp(f);
  const items = f.service.list("owner", { threadId: f.thread.id }).unwrap().items;
  expect(items.map((item) => [item.id, item.firstRunId, item.previousId])).toEqual([
    [f.run.runId, undefined, undefined],
    [followUp.runId, f.run.runId, f.run.runId],
  ]);
  const read = f.service.read("owner", { threadId: f.thread.id, agentId: followUp.runId }).unwrap();
  expect(read.agent.firstRunId).toBe(f.run.runId);
});

function agentStreamMessages(f: ReturnType<typeof fixture>, streamId: string) {
  const replay = f.native.syncAgentStream("owner", f.thread.id, streamId).unwrap();
  const slots = replay.kind === "window" ? replay.slots : [];
  return slots.flatMap((slot) => (slot.kind === "ready" ? slot.messages : []));
}

function prepareFollowUp(f: ReturnType<typeof fixture>, followUp: ReturnType<typeof addFollowUp>) {
  return f.service
    .prepareOutput({
      runId: followUp.runId,
      requestId: followUp.requestId,
      sessionId: f.target.childSessionId,
      prompt: "Next",
    })
    .unwrap()!;
}

test("a follow-up stream starts with the child session's earlier exchanges", () => {
  const f = fixture();
  f.setSaved([
    { role: "user", content: "Research" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c", toolName: "read", input: {} }],
    },
    { role: "assistant", content: "Done" },
  ]);
  const followUp = addFollowUp(f);
  const messages = agentStreamMessages(f, prepareFollowUp(f, followUp).id);
  expect(
    messages.map((message) => [
      message.role,
      message.metadata?.phase,
      message.parts.map((part) => part.type),
    ]),
  ).toEqual([
    ["user", undefined, ["text"]],
    ["assistant", "commentary", ["data-activity"]],
    ["assistant", "final", ["text"]],
    ["user", undefined, ["text"]],
  ]);
  expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
});

test("a follow-up continues from what the previous run showed, not its compacted transcript", () => {
  const f = fixture();
  f.native
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: f.input.requestId,
      runId: f.run.runId,
      requestId: f.executionRequestId,
      state: "complete",
      startedAt: 2,
      messages: subagentMessages([
        { role: "user", content: "Research" },
        { role: "assistant", content: "Shown reply" },
      ]),
    })
    .unwrap();
  f.setSaved([{ role: "user", content: "Summary of the earlier conversation" }]);
  const followUp = addFollowUp(f);
  expect(texts(agentStreamMessages(f, prepareFollowUp(f, followUp).id))).toEqual([
    "Research",
    "Shown reply",
    "Next",
  ]);
});

test("a follow-up that ended without a transcript still shows the earlier exchanges", () => {
  const f = fixture();
  const followUp = addFollowUp(f, "failed");
  const stream = f.service
    .stream("owner", { threadId: f.thread.id, agentId: followUp.runId })
    .unwrap();
  expect(texts(agentStreamMessages(f, stream.id))).toEqual(["Research", "Done"]);
});

test("seeded history takes new IDs so a follow-up's output cannot land among the copies", () => {
  const f = fixture();
  const nativeId = `np_${"a".repeat(24)}_${"b".repeat(24)}_${"9".repeat(16)}_${"c".repeat(24)}`;
  f.native
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: f.input.requestId,
      runId: f.run.runId,
      requestId: f.executionRequestId,
      state: "complete",
      startedAt: 2,
      messages: [
        { id: "child_0_0_0", role: "user", parts: [{ type: "text", text: "Research" }] },
        {
          id: nativeId,
          role: "assistant",
          parts: [
            {
              type: "data-activity",
              id: "reasoning-0",
              data: { kind: "thinking", label: "Thinking", state: "complete" },
            },
            {
              type: "data-activity",
              id: "delegation-tool",
              data: { kind: "tool", label: "subagent_delegate", state: "complete" },
            },
          ],
        },
      ],
    })
    .unwrap();
  const followUp = addFollowUp(f);
  const messages = agentStreamMessages(f, prepareFollowUp(f, followUp).id);
  const ids = messages.flatMap((message) => [
    message.id,
    ...message.parts.flatMap((part) => ("id" in part ? [part.id] : [])),
  ]);
  expect(ids).not.toContain(nativeId);
  expect(ids).not.toContain("reasoning-0");
  // A delegation row finds its nested agent by the tool activity ID.
  expect(ids).toContain("delegation-tool");
  expect(texts(messages)).toEqual(["Research", "Next"]);
});

test("a follow-up takes history from the nearest earlier run that kept it", () => {
  const f = fixture();
  const lost = addFollowUp(f, "failed", { name: "lost" });
  const next = addFollowUp(f, "running", { name: "next", previous: lost.runId, createdAt: 5 });
  expect(texts(agentStreamMessages(f, prepareFollowUp(f, next).id))).toEqual([
    "Research",
    "Done",
    "Next",
  ]);
});

/** A follow-up stream as it was created before history seeding: only its own exchange. */
function legacyStream(
  f: ReturnType<typeof fixture>,
  run: ReturnType<typeof addFollowUp>,
  exchange: [string, string],
) {
  f.native
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: f.input.requestId,
      runId: run.runId,
      requestId: run.requestId,
      state: "complete",
      startedAt: 4,
      messages: subagentMessages([
        { role: "user", content: exchange[0] },
        { role: "assistant", content: exchange[1] },
      ]),
    })
    .unwrap();
}

const said = (...exchanges: [string, string][]): StoredMessageV1[] =>
  exchanges.flatMap(([prompt, reply]) => [
    { role: "user" as const, content: prompt },
    { role: "assistant" as const, content: reply },
  ]);

test("ended follow-up streams from before seeding gain earlier exchanges once, newest first", () => {
  const f = fixture();
  const second = addFollowUp(f, "succeeded", { name: "second" });
  const third = addFollowUp(f, "succeeded", {
    name: "third",
    previous: second.runId,
    createdAt: 5,
  });
  f.setTranscript(second.requestId, said(["Research", "Done"], ["Next", "Answer"]));
  f.setTranscript(
    third.requestId,
    said(["Research", "Done"], ["Next", "Answer"], ["Third", "Reply"]),
  );
  legacyStream(f, second, ["Next", "Answer"]);
  legacyStream(f, third, ["Third", "Reply"]);
  const open = (run: ReturnType<typeof addFollowUp>) =>
    texts(
      agentStreamMessages(
        f,
        f.service.stream("owner", { threadId: f.thread.id, agentId: run.runId }).unwrap().id,
      ),
    );
  const whole = ["Research", "Done", "Next", "Answer", "Third", "Reply"];
  expect(open(third)).toEqual(whole);
  expect(open(second)).toEqual(whole.slice(0, 4));
  expect(open(third)).toEqual(whole);
});

test("a steered follow-up stream from before seeding still gains earlier exchanges", () => {
  const f = fixture();
  const followUp = addFollowUp(f, "succeeded");
  f.setTranscript(followUp.requestId, [
    ...said(["Research", "Done"], ["Next", "Answer"]),
    { role: "user", content: "Also check the weekend" },
    { role: "assistant", content: "Weekend is clear" },
  ]);
  legacyStream(f, followUp, ["Next", "Answer"]);
  const stream = f.service
    .stream("owner", { threadId: f.thread.id, agentId: followUp.runId })
    .unwrap();
  expect(texts(agentStreamMessages(f, stream.id))).toEqual([
    "Research",
    "Done",
    "Next",
    "Answer",
    "Also check the weekend",
  ]);
});

const toolActivity = (toolCallId: string): DisplayMessage => ({
  id: `np_${toolCallId}`,
  role: "assistant",
  parts: [
    {
      type: "data-activity",
      id: createHash("sha256").update(toolCallId).digest("hex").slice(0, 24),
      data: { kind: "tool", label: "Read", state: "complete" },
    },
  ],
});
const reply = (id: string, text: string): DisplayMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});
const toolCall = (toolCallId: string, text?: string): StoredMessageV1 => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text" as const, text }] : []),
    { type: "tool-call" as const, toolCallId, toolName: "read", input: {} },
  ],
});
const toolResult = (toolCallId: string): StoredMessageV1 => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName: "read",
      output: { type: "text", value: "ok" },
    },
  ],
});

function endedStream(f: ReturnType<typeof fixture>, messages: DisplayMessage[]) {
  f.run.state = "succeeded";
  f.native
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: f.input.requestId,
      runId: f.run.runId,
      requestId: f.executionRequestId,
      state: "complete",
      startedAt: 2,
      messages,
    })
    .unwrap();
  return () =>
    agentStreamMessages(
      f,
      f.service.stream("owner", { threadId: f.thread.id, agentId: f.run.runId }).unwrap().id,
    );
}

test("an ended run's stream gains the steers its transcript holds where the run read them", () => {
  const f = fixture();
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    toolActivity("a"),
    reply("np_checking", "Checking more."),
    toolActivity("b"),
    reply("np_partial_1", "Partial answer.\n\n"),
    reply("np_partial_2", "More"),
    reply("np_short", "Short."),
  ]);
  f.setSaved([
    { role: "user", content: "Research" },
    toolCall("a"),
    toolResult("a"),
    toolCall("b", "Checking more."),
    toolResult("b"),
    { role: "user", content: "Also check the weekend" },
    {
      role: "user",
      content: "<LILAC_GENERATED:v1>",
      providerOptions: { lilac: { generated: { version: 1, kind: "job_event", id: "job" } } },
    },
    { role: "assistant", content: "Partial answer.\n\nMore" },
    { role: "user", content: "Keep it short" },
    { role: "assistant", content: "Short." },
  ]);
  const shown = (messages: readonly DisplayMessage[]) =>
    messages.map((message) => [
      message.role,
      message.metadata?.inputMode,
      texts([message]).join("") || message.parts[0]?.type,
    ]);
  const expected = [
    ["user", undefined, "Research"],
    ["assistant", undefined, "data-activity"],
    ["assistant", undefined, "Checking more."],
    ["assistant", undefined, "data-activity"],
    ["user", "steer", "Also check the weekend"],
    ["assistant", undefined, "Partial answer.\n\n"],
    ["assistant", undefined, "More"],
    ["user", "steer", "Keep it short"],
    ["assistant", undefined, "Short."],
  ];
  expect(shown(open())).toEqual(expected);
  expect(shown(open())).toEqual(expected);
});

test("an ended run's steer backfill leaves out a compaction summary ahead of the stream", () => {
  const f = fixture();
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    toolActivity("c"),
    reply("np_done", "Done"),
  ]);
  f.setSaved([
    { role: "user", content: "Summary of the earlier conversation" },
    toolCall("c"),
    toolResult("c"),
    { role: "user", content: "Also check the weekend" },
    { role: "assistant", content: "Done" },
  ]);
  expect(texts(open())).toEqual(["Research", "Also check the weekend", "Done"]);
});

test("a queued follow-up opened before it starts still shows its prompt once it runs", () => {
  const f = fixture();
  const followUp = addFollowUp(f, "queued");
  const opened = f.service
    .stream("owner", { threadId: f.thread.id, agentId: followUp.runId })
    .unwrap();
  expect(agentStreamMessages(f, opened.id)).toEqual([]);
  expect(texts(agentStreamMessages(f, prepareFollowUp(f, followUp).id))).toEqual([
    "Research",
    "Done",
    "Next",
  ]);
});

test("history from a transcript keeps delegation IDs that link nested agents", () => {
  const f = fixture();
  f.setSaved([
    { role: "user", content: "Research" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "delegate-1", toolName: "subagent_delegate", input: {} },
      ],
    },
    { role: "assistant", content: "Done" },
  ]);
  const followUp = addFollowUp(f);
  const ids = agentStreamMessages(f, prepareFollowUp(f, followUp).id).flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "data-activity" ? [part.id] : [])),
  );
  expect(ids).toEqual([createHash("sha256").update("delegate-1").digest("hex").slice(0, 24)]);
});

test("a follow-up canceled before it started does not hide earlier exchanges", () => {
  const f = fixture();
  const canceled = addFollowUp(f, "cancelled", { name: "canceled" });
  // Opening the follow-up while it was queued left its stream empty.
  f.native
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: f.input.requestId,
      runId: canceled.runId,
      requestId: canceled.requestId,
      state: "running",
      startedAt: 4,
      messages: [],
    })
    .unwrap();
  const next = addFollowUp(f, "running", { name: "next", previous: canceled.runId, createdAt: 5 });
  expect(texts(agentStreamMessages(f, prepareFollowUp(f, next).id))).toEqual([
    "Research",
    "Done",
    "Next",
  ]);
  const reopened = f.service
    .stream("owner", { threadId: f.thread.id, agentId: canceled.runId })
    .unwrap();
  expect(texts(agentStreamMessages(f, reopened.id))).toEqual(["Research", "Done"]);
});

test("subagent IDs cannot expose a different thread or rewound request", () => {
  const f = fixture();
  const other = f.native.createThread("owner", { commandId: "other" }).unwrap();
  expect(f.service.read("owner", { threadId: other.id, agentId: f.run.runId }).isErr()).toBe(true);
  f.native.markInputCompleted(f.input.id).unwrap();
  f.native
    .beginRewind("owner", {
      threadId: f.thread.id,
      commandId: "rewind",
      turnId: f.input.turnId!,
      historyGeneration: 0,
      revision: f.native.getThreadRecord(f.thread.id).unwrap().revision,
    })
    .unwrap();
  expect(f.read().isErr()).toBe(true);
  expect(f.service.list("owner", { threadId: f.thread.id }).unwrap().items).toEqual([]);
  expect(f.counters().transcriptReads).toBe(0);
});

test("live named-session history and streaming content preserve IDs at completion", () => {
  const f = fixture();
  f.setLive({
    title: "Responding…",
    streaming: true,
    messages: [
      { role: "user", content: "Earlier prompt" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Research" },
      { role: "assistant", content: [{ type: "text", text: "Working answer\n\nMore" }] },
    ],
  });
  const live = f.read().unwrap();
  expect(live.agent.title).toBe("Responding…");
  expect(live.messages).toHaveLength(4);
  expect(f.service.list("owner", { threadId: f.thread.id }).unwrap().items[0]?.title).toBe(
    "Responding…",
  );
  expect(subagentSummarySchema.safeParse(live.agent).success).toBe(true);
  expect(live.messages.at(-1)?.metadata?.incomplete).toBe(true);
  expect(f.counters().transcriptReads).toBe(0);
  f.setSaved([
    { role: "user", content: "Earlier prompt" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Research" },
    { role: "assistant", content: "Working answer" },
  ]);
  f.setLive(undefined);
  f.run.state = "succeeded";
  const saved = f.read().unwrap();
  expect(saved.agent.state).toBe("complete");
  expect(saved.unavailable).toBe(false);
  expect(saved.messages.map((message) => message.id)).toEqual(
    live.messages.map((message) => message.id),
  );
  expect(saved.messages.at(-1)?.metadata?.incomplete).toBeUndefined();
});

test("subagents without a dispatched operation stay waiting or report unavailable after termination", () => {
  for (const operationPending of [false, true]) {
    const f = fixture();
    if (operationPending) f.operations[0]!.requestId = null;
    else f.operations.length = 0;
    const waiting = f.read().unwrap();
    expect(waiting.agent.title).toBe("Waiting…");
    expect(waiting.unavailable).toBe(false);
    expect(waiting.messages).toEqual([]);
    f.run.state = "failed";
    expect(f.read().unwrap().unavailable).toBe(true);
  }
});

test("transcript pagination bounds large messages and omits private provider data", () => {
  const f = fixture();
  f.setSaved([
    { role: "system", content: "PRIVATE SYSTEM" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "PRIVATE REASONING" },
        {
          type: "tool-call",
          toolCallId: "tool",
          toolName: "search",
          input: { private: "PRIVATE INPUT" },
        },
        { type: "text", text: "a".repeat(MAX_REPLAY_TEXT_LENGTH * 2 + 1) },
      ],
    },
    ...Array.from(
      { length: 22 },
      (_, index): StoredMessageV1 => ({ role: "assistant", content: `Message ${index}` }),
    ),
  ]);
  const latest = f.read().unwrap();
  expect(latest.messages).toHaveLength(20);
  expect(latest.nextBefore).toBe(7);
  const older = f.read("owner", latest.nextBefore).unwrap();
  expect(older.messages).toHaveLength(7);
  expect(older.nextBefore).toBeUndefined();
  const messages = [...older.messages, ...latest.messages];
  expect(new Set(messages.map((message) => message.id)).size).toBe(27);
  for (const message of messages)
    expect(displayMessageSchema.safeParse(message).success).toBe(true);
  expect(JSON.stringify(messages)).not.toContain("PRIVATE SYSTEM");
  expect(JSON.stringify(messages)).toContain("PRIVATE REASONING");
  expect(JSON.stringify(messages)).toContain("PRIVATE INPUT");
  expect(JSON.stringify(messages)).toContain("search");
  expect(subagentMessages([{ role: "assistant", content: "hello" }])).toHaveLength(1);
});

test("live reasoning and tools keep their working state until completion", () => {
  const reasoning = [
    { role: "assistant" as const, content: [{ type: "reasoning" as const, text: "private" }] },
  ];
  expect(subagentMessages(reasoning, true)[0]?.parts[0]).toMatchObject({
    data: { label: "Thinking", state: "running" },
  });
  expect(subagentMessages(reasoning)[0]?.parts[0]).toMatchObject({
    data: { label: "Thinking", state: "complete", detail: "private" },
  });
  const tool = { toolCallId: "tool", toolName: "search" };
  const messages = [
    { role: "assistant" as const, content: [{ type: "tool-call" as const, ...tool, input: {} }] },
  ];
  expect(subagentMessages(messages, true, [tool])[0]?.parts[0]).toMatchObject({
    data: { state: "running" },
  });
  expect(subagentMessages(messages)[0]?.parts[0]).toMatchObject({ data: { state: "complete" } });
  expect(subagentMessages([], false, [tool])[0]?.parts[0]).toMatchObject({
    data: { label: "search", state: "running" },
  });
});

test("live text follows the output streaming mode", () => {
  const messages = [
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Before tool" },
        { type: "reasoning" as const, text: "private" },
        { type: "text" as const, text: "First\n\nSecond partial" },
      ],
    },
  ];
  const texts = (mode: "paragraph" | "complete", streaming = true) =>
    subagentMessages(messages, streaming, [], mode).flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
  expect(texts("paragraph")).toEqual(["Before tool", "First\n\n"]);
  expect(texts("complete")).toEqual([]);
  expect(texts("complete", false)).toEqual(["Before tool", "First\n\nSecond partial"]);
  const partial = [{ role: "assistant" as const, content: "No paragraph yet" }];
  expect(subagentMessages(partial, true, [], "paragraph")).toEqual([]);
  const crlf = [{ role: "assistant" as const, content: "First\r\n\r\nSecond" }];
  expect(subagentMessages(crlf, true, [], "paragraph")[0]?.parts[0]).toEqual({
    type: "text",
    text: "First\n\n",
  });
});

test("incremental transcript reads bridge growth with bounded forward pages", () => {
  const f = fixture();
  const messages = Array.from(
    { length: 100 },
    (_, index): StoredMessageV1 => ({ role: "assistant", content: `Message ${index}` }),
  );
  f.setSaved(messages);
  const latest = f.read().unwrap();
  expect(latest.offset).toBe(80);
  f.setSaved([
    ...messages,
    ...Array.from(
      { length: 60 },
      (_, index): StoredMessageV1 => ({ role: "assistant", content: `Message ${index + 100}` }),
    ),
  ]);
  const next = f.service
    .read("owner", { threadId: f.thread.id, agentId: f.run.runId, from: latest.offset })
    .unwrap();
  expect(next.offset).toBe(80);
  expect(next.messages).toHaveLength(40);
  expect(next.total).toBe(160);
  const last = f.service
    .read("owner", { threadId: f.thread.id, agentId: f.run.runId, from: 120 })
    .unwrap();
  expect(last.messages.at(-1)?.parts[0]).toEqual({ type: "text", text: "Message 159" });
});

test("read exposes a currently executing tool even before its history commit", () => {
  const f = fixture();
  f.setLive({
    title: "search",
    messages: [{ role: "user", content: "Research" }],
    streaming: false,
    activeTools: [{ toolCallId: "call", toolName: "search" }],
  });
  const page = f.read().unwrap();
  expect(page.messages.at(-1)?.parts[0]).toMatchObject({
    data: { label: "search", state: "running" },
  });
  expect(page.agent.title).toBe("search");
});

test("steer backfill matches live steers despite trimming and batching", () => {
  const f = fixture();
  const steer = (id: string, text: string): DisplayMessage => ({
    id,
    role: "user",
    metadata: { inputMode: "steer" },
    parts: [{ type: "text", text }],
  });
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    toolActivity("a"),
    steer("np_padded", "  check logs"),
    toolActivity("b"),
    steer("np_dates", "Check dates"),
    steer("np_prices", "Check prices"),
    reply("np_done", "Done"),
  ]);
  f.setSaved([
    { role: "user", content: "Research" },
    toolCall("a"),
    toolResult("a"),
    { role: "user", content: "check logs" },
    toolCall("b"),
    toolResult("b"),
    { role: "user", content: "Check dates\n\nCheck prices" },
    { role: "assistant", content: "Done" },
  ]);
  expect(texts(open())).toEqual([
    "Research",
    "  check logs",
    "Check dates",
    "Check prices",
    "Done",
  ]);
});

test("steer backfill places a steer after the thinking and reply that preceded it", () => {
  const f = fixture();
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    {
      id: "np_thinking",
      role: "assistant",
      parts: [
        {
          type: "data-activity",
          id: "thinking",
          data: { kind: "thinking", label: "Thinking", state: "complete" },
        },
      ],
    },
    reply("np_looking", "Looking."),
    reply("np_done", "Done"),
  ]);
  f.setSaved([
    { role: "user", content: "Research" },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "Plan" },
        { type: "text", text: "Looking." },
      ],
    },
    { role: "user", content: "Hurry" },
    { role: "assistant", content: "Done" },
  ]);
  expect(texts(open())).toEqual(["Research", "Looking.", "Hurry", "Done"]);
});

test("steer backfill does not take a later message with the same text for a missing steer", () => {
  const f = fixture();
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    toolActivity("a"),
    toolActivity("b"),
    {
      id: "np_later",
      role: "user",
      metadata: { inputMode: "steer" },
      parts: [{ type: "text", text: "check the logs" }],
    },
    reply("np_done", "Done"),
  ]);
  f.setSaved([
    { role: "user", content: "Research" },
    toolCall("a"),
    toolResult("a"),
    { role: "user", content: "check the logs" },
    toolCall("b"),
    toolResult("b"),
    { role: "user", content: "check the logs" },
    { role: "assistant", content: "Done" },
  ]);
  const messages = open();
  expect(texts(messages)).toEqual(["Research", "check the logs", "check the logs", "Done"]);
  expect(messages[2]?.metadata?.inputMode).toBe("steer");
  expect(messages[3]?.parts[0]?.type).toBe("data-activity");
});

test("steer backfill keeps a repeated steer separated by a reply on its own side", () => {
  const f = fixture();
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    reply("np_looking", "Looking."),
    {
      id: "np_hurry",
      role: "user",
      metadata: { inputMode: "steer" },
      parts: [{ type: "text", text: "Hurry" }],
    },
    reply("np_done", "Done"),
  ]);
  f.setSaved([
    { role: "user", content: "Research" },
    { role: "user", content: "Hurry" },
    { role: "assistant", content: "Looking." },
    { role: "user", content: "Hurry" },
    { role: "assistant", content: "Done" },
  ]);
  expect(texts(open())).toEqual(["Research", "Hurry", "Looking.", "Hurry", "Done"]);
});

test("steer backfill anchors on a reply the stream shows once when compaction dropped the rest", () => {
  const f = fixture();
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    reply("np_logs_1", "Looking at\n\n"),
    reply("np_logs_2", "the logs."),
    reply("np_done", "Done"),
  ]);
  f.setSaved([
    { role: "user", content: "Summary of the earlier conversation" },
    { role: "assistant", content: "Looking at\n\nthe logs." },
    { role: "user", content: "Hurry" },
    { role: "assistant", content: "Done" },
  ]);
  expect(texts(open())).toEqual(["Research", "Looking at\n\n", "the logs.", "Hurry", "Done"]);
});

test("steer backfill aligns on generated messages a transcript projection shows", () => {
  const f = fixture();
  const saved: StoredMessageV1[] = [
    { role: "user", content: "Research" },
    {
      role: "user",
      content: [
        { type: "text", text: '<LILAC_GENERATED:v1>\n{"kind":"job_event","id":"job"}' },
        { type: "text", text: "job finished" },
        { type: "text", text: "</LILAC_GENERATED:v1>" },
      ],
      providerOptions: { lilac: { generated: { version: 1, kind: "job_event", id: "job" } } },
    },
    { role: "assistant", content: "Looking." },
    { role: "user", content: "Hurry" },
    { role: "assistant", content: "Done" },
  ];
  const open = endedStream(f, subagentMessages(saved));
  f.setSaved(saved);
  expect(texts(open()).filter((text) => text === "Hurry")).toEqual(["Hurry"]);
});

test("steer backfill finds a live interrupt input past the reply it cut short", () => {
  const f = fixture();
  const open = endedStream(f, [
    ...subagentMessages([{ role: "user", content: "Research" }]),
    { ...reply("np_partial", "Half a"), metadata: { incomplete: true } },
    {
      id: "np_hurry",
      role: "user",
      metadata: { inputMode: "steer" },
      parts: [{ type: "text", text: "Hurry" }],
    },
    reply("np_done", "Done"),
  ]);
  f.setSaved([
    { role: "user", content: "Research" },
    { role: "user", content: "Hurry" },
    { role: "assistant", content: "Done" },
  ]);
  expect(texts(open())).toEqual(["Research", "Half a", "Hurry", "Done"]);
});

function streamSlots(f: ReturnType<typeof fixture>, streamId: string) {
  const replay = f.native.syncAgentStream("owner", f.thread.id, streamId).unwrap();
  if (replay.kind !== "window") throw new Error("Expected a window");
  return replay.slots.map((slot) =>
    slot.kind === "ready" ? [slot.state, texts(slot.messages)] : [slot.kind],
  );
}

function prompt(text: string, steer = false): DisplayMessage {
  return {
    id: `user_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`,
    role: "user",
    ...(steer ? { metadata: { inputMode: "steer" as const } } : {}),
    parts: [{ type: "text", text }],
  };
}

test("a follow-up stream keeps each exchange in its own turn and runs in the last", () => {
  const f = fixture();
  f.setSaved([
    { role: "user", content: "Research" },
    { role: "assistant", content: "Done" },
  ]);
  const stream = prepareFollowUp(f, addFollowUp(f));
  expect(streamSlots(f, stream.id)).toEqual([
    ["complete", ["Research", "Done"]],
    ["running", ["Next"]],
  ]);
  const replay = f.native.syncAgentStream("owner", f.thread.id, stream.id).unwrap();
  expect(replay.kind === "window" ? replay.slots.at(-1)?.slotId : undefined).toBe(stream.turnId);
});

test("steers and a chunked prompt stay in the exchange they join", () => {
  const f = fixture();
  const open = endedStream(f, [
    prompt("Research"),
    prompt("more of the prompt"),
    reply("np_a", "Looking."),
    prompt("Hurry", true),
    reply("np_b", "Done"),
    prompt("Next"),
    reply("np_c", "Also done"),
  ]);
  open();
  const stream = f.native.findAgentStream(f.run.runId).unwrap()!;
  expect(streamSlots(f, stream.id)).toEqual([
    ["complete", ["Research", "more of the prompt", "Looking.", "Hurry", "Done"]],
    ["complete", ["Next", "Also done"]],
  ]);
});

test("a stream from before exchanges had their own turns splits when an ended run opens", () => {
  const f = fixture();
  const open = endedStream(f, [
    prompt("Research"),
    reply("np_a", "Done"),
    prompt("Next"),
    reply("np_b", "Also done"),
  ]);
  const stream = f.native.findAgentStream(f.run.runId).unwrap()!;
  const db = databases.at(-1)!;
  const rows = db
    .query<{ data_json: string }, [string]>(
      "SELECT data_json FROM native_records WHERE kind='turn' AND thread_id=? ORDER BY position",
    )
    .all(stream.id)
    .map((row) => JSON.parse(row.data_json));
  const legacy = rows.at(-1);
  legacy.value = {
    ...legacy.value,
    position: 0,
    messages: rows.flatMap((row) => row.value.messages),
  };
  db.query("DELETE FROM native_records WHERE kind='turn' AND thread_id=?").run(stream.id);
  db.query(
    "INSERT INTO native_records(kind,id,thread_id,position,updated_at,format_version,data_json) VALUES('turn',?,?,0,0,1,?)",
  ).run(stream.turnId, stream.id, JSON.stringify(legacy));
  expect(streamSlots(f, stream.id)).toEqual([
    ["complete", ["Research", "Done", "Next", "Also done"]],
  ]);
  open();
  expect(streamSlots(f, stream.id)).toEqual([
    ["complete", ["Research", "Done"]],
    ["complete", ["Next", "Also done"]],
  ]);
});

test("earlier exchanges past the replay window load on demand", () => {
  const f = fixture();
  const exchanges = Array.from({ length: 7 }, (_, index) => [
    prompt(`Prompt ${index}`),
    reply(`np_${index}`, `Reply ${index}`),
  ]).flat();
  const open = endedStream(f, exchanges);
  open();
  const stream = f.native.findAgentStream(f.run.runId).unwrap()!;
  const slots = streamSlots(f, stream.id);
  expect(slots[0]).toEqual(["deferred"]);
  expect(slots.at(-1)).toEqual(["complete", ["Prompt 6", "Reply 6"]]);
  const replay = f.native.syncAgentStream("owner", f.thread.id, stream.id).unwrap();
  const deferred = replay.kind === "window" ? replay.slots[0] : undefined;
  if (deferred?.kind !== "deferred") throw new Error("Expected a deferred range");
  const hydration = f.native
    .hydrateAgentStream("owner", f.thread.id, stream.id, {
      threadId: stream.id,
      historyGeneration: replay.checkpoint.historyGeneration,
      projectionRevision: replay.checkpoint.projectionRevision,
      slotId: deferred.slotId,
    })
    .unwrap();
  expect(
    hydration.slots.flatMap((slot) => (slot.kind === "ready" ? texts(slot.messages) : [])),
  ).toEqual(["Prompt 0", "Reply 0", "Prompt 1", "Reply 1"]);
});

test("a stream's previews stay readable from messages in its earlier exchanges", () => {
  const f = fixture();
  const open = endedStream(f, [
    prompt("Research"),
    reply("np_a", "See the page."),
    prompt("Next"),
    reply("np_b", "Done"),
  ]);
  open();
  const stream = f.native.findAgentStream(f.run.runId).unwrap()!;
  f.native
    .saveHtmlPreview({
      threadId: f.thread.id,
      turnId: stream.turnId,
      path: "/tmp/page.html",
      error: "missing",
    })
    .unwrap();
  const preview = f.native
    .readHtmlPreview("owner", { threadId: f.thread.id, messageId: "np_a", path: "/tmp/page.html" })
    .unwrap();
  expect(preview.turnId).toBe(stream.turnId);
});
