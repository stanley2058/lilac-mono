import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import {
  MAX_REPLAY_TEXT_LENGTH,
  displayMessageSchema,
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
        return Result.ok(id === run.runId ? run : null);
      },
      listSubagentRuns: () => {
        workflowReads++;
        return Result.ok([run]);
      },
      listOperations: (runId) => {
        workflowReads++;
        return Result.ok(runId === run.runId ? operations : []);
      },
    },
    transcripts: {
      getRequestTranscript: ({ requestId }) => {
        transcriptReads++;
        if (requestId !== executionRequestId) return Result.ok(null);
        return Result.ok({
          requestId,
          sessionId: target.childSessionId,
          requestClient: "native",
          createdTs: 1,
          updatedTs: 2,
          messages: saved,
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
    service,
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

test("completed subagent reads the execution transcript rather than the delegation ID", () => {
  const f = fixture();
  f.run.state = "succeeded";
  expect(f.operations[0]!.requestId).not.toBe(f.target.childRequestId);
  const page = f.read().unwrap();
  expect(page.unavailable).toBe(false);
  expect(page.messages.map((message) => message.parts[0])).toEqual([
    { type: "text", text: "Research" },
    { type: "text", text: "Done" },
  ]);
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
