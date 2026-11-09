import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { WorkflowRunSummary } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "../../../src/surface/native/store";
import { NativeSurfaceStore } from "../../../src/surface/native/store-surface";
import { NativeWorkflows } from "../../../src/surface/native/workflows";
import { DurableWorkflowStore } from "../../../src/workflow/durable-workflow-store";
import { seedNativeSubagent } from "./subagent-fixture";
import { seedNativeWorkflowRun } from "./workflow-fixture";

let database: Database;
let store: NativeStore;
let workflows: DurableWorkflowStore;
let surface: NativeSurfaceStore;
let service: NativeWorkflows;

beforeEach(() => {
  database = new Database(":memory:");
  store = new NativeStore(database);
  store.initialize().unwrap();
  for (const [id, role] of [
    ["owner", "owner"],
    ["alice", "participant"],
    ["bob", "participant"],
  ] as const)
    store.upsertUser({ id, providerId: id, displayName: id, role, toolMode: "full" }).unwrap();
  workflows = new DurableWorkflowStore(":memory:");
  surface = new NativeSurfaceStore(database, store);
  service = new NativeWorkflows({ native: store, surface, workflows });
});

afterEach(() => {
  store.close();
  workflows.close();
});

const names = (items: WorkflowRunSummary[]) => items.map((item) => item.card.name);
const list = (actor: string, options: { cursor?: string; limit?: number } = {}) =>
  service.list(actor, { state: "active", ...options });
const listFinished = (actor: string, options: { cursor?: string; limit?: number } = {}) =>
  service.list(actor, { state: "finished", ...options });

test("owners see every run with a thread or none; participants see only threads they can read", async () => {
  const mine = store.createThread("alice", { commandId: "mine" }).unwrap();
  const theirs = store.createThread("bob", { commandId: "theirs" }).unwrap();
  seedNativeWorkflowRun(workflows, {
    id: "mine",
    name: "mine",
    state: "running",
    threadId: mine.id,
    createdAt: 4,
    completed: 1,
    total: 3,
  });
  seedNativeWorkflowRun(workflows, {
    id: "theirs",
    name: "theirs",
    state: "running",
    threadId: theirs.id,
    createdAt: 3,
  });
  seedNativeWorkflowRun(workflows, {
    id: "discord",
    name: "from-discord",
    state: "running",
    platform: "discord",
    createdAt: 2,
  });
  seedNativeWorkflowRun(workflows, { id: "cron", name: "detached", state: "queued", createdAt: 1 });

  const owner = (await list("owner")).unwrap();
  expect(names(owner.items)).toEqual(["mine", "theirs", "from-discord", "detached"]);
  expect(owner.items[0]).toMatchObject({
    card: { status: "running", progress: { completed: 1, total: 3 } },
    thread: { id: mine.id, title: mine.title },
  });
  expect(owner.items[2]).toMatchObject({ platform: "discord" });
  expect(owner.items[2]?.thread).toBeUndefined();
  expect(owner.items[3]?.platform).toBeUndefined();

  expect(names((await list("alice")).unwrap().items)).toEqual(["mine"]);
  expect(names((await list("bob")).unwrap().items)).toEqual(["theirs"]);
});

test("active and finished runs are listed separately", async () => {
  seedNativeWorkflowRun(workflows, { id: "live", name: "live", state: "paused", createdAt: 3 });
  seedNativeWorkflowRun(workflows, { id: "ok", name: "ok", state: "succeeded", createdAt: 2 });
  seedNativeWorkflowRun(workflows, { id: "bad", name: "bad", state: "failed", createdAt: 1 });
  expect(names((await list("owner")).unwrap().items)).toEqual(["live"]);
  expect(names((await listFinished("owner")).unwrap().items)).toEqual(["ok", "bad"]);
});

test("one run reads with the list's access rules, and a preview drops its long text", async () => {
  const mine = store.createThread("alice", { commandId: "mine" }).unwrap();
  const run = seedNativeWorkflowRun(workflows, {
    id: "mine",
    name: "mine",
    state: "succeeded",
    threadId: mine.id,
    createdAt: 2,
    result: "All clear.",
  });
  const external = seedNativeWorkflowRun(workflows, {
    id: "external",
    name: "external",
    state: "failed",
    platform: "discord",
    createdAt: 1,
    detail: "It broke.",
  });

  const full = (await service.get("alice", { runId: run.runId })).unwrap();
  expect(full.card.result).toMatchObject({ text: "All clear." });
  const preview = (await service.get("alice", { runId: run.runId, preview: true })).unwrap();
  expect(preview.card).toMatchObject({ name: "mine", status: "succeeded" });
  expect(preview.card.result).toBeUndefined();

  const failed = (await service.get("owner", { runId: external.runId, preview: true })).unwrap();
  expect(failed.card.status).toBe("failed");
  expect(failed.card.reason).toBeUndefined();
  expect((await service.get("owner", { runId: external.runId })).unwrap().card.reason).toBe(
    "It broke.",
  );

  const hidden = (await service.get("bob", { runId: run.runId })).isErr();
  const absent = (await service.get("bob", { runId: "wfrun:absent" })).isErr();
  expect([hidden, absent]).toEqual([true, true]);
  const message = (result: Awaited<ReturnType<typeof service.get>>) =>
    result.match({ ok: () => "", err: (error) => error.message });
  expect(message(await service.get("bob", { runId: run.runId }))).toBe(
    message(await service.get("bob", { runId: "wfrun:absent" })),
  );
});

test("failed and done runs page separately, so failures never wait on successes", async () => {
  seedNativeWorkflowRun(workflows, { id: "ok-1", name: "ok-1", state: "succeeded", createdAt: 5 });
  seedNativeWorkflowRun(workflows, { id: "stop", name: "stop", state: "cancelled", createdAt: 4 });
  seedNativeWorkflowRun(workflows, { id: "ok-2", name: "ok-2", state: "succeeded", createdAt: 3 });
  seedNativeWorkflowRun(workflows, { id: "bad", name: "bad", state: "failed", createdAt: 2 });
  seedNativeWorkflowRun(workflows, { id: "live", name: "live", state: "running", createdAt: 1 });

  const failed = (await service.list("owner", { state: "failed", limit: 1 })).unwrap();
  expect(names(failed.items)).toEqual(["bad"]);
  expect(failed.nextCursor).toBeUndefined();

  const first = (await service.list("owner", { state: "done", limit: 2 })).unwrap();
  expect(names(first.items)).toEqual(["ok-1", "stop"]);
  const second = (
    await service.list("owner", { state: "done", limit: 2, cursor: first.nextCursor })
  ).unwrap();
  expect(names(second.items)).toEqual(["ok-2"]);
});

test("a query matches any part of the name, ignores case, and keeps paging and access", async () => {
  const mine = store.createThread("alice", { commandId: "mine" }).unwrap();
  const seeds = [
    ["nightly-backup", "running", undefined],
    ["nightly-audit", "running", mine.id],
    ["audit-routes", "running", undefined],
  ] as const;
  seeds.forEach(([name, state, threadId], index) =>
    seedNativeWorkflowRun(workflows, {
      id: name,
      name,
      state,
      ...(threadId ? { threadId } : { platform: "discord" as const }),
      createdAt: seeds.length - index,
    }),
  );
  const search = (actor: string, query: string, cursor?: string) =>
    service.list(actor, { state: "active", query, limit: 1, cursor });

  const first = (await search("owner", "NIGHTLY")).unwrap();
  expect(names(first.items)).toEqual(["nightly-backup"]);
  const second = (await search("owner", "NIGHTLY", first.nextCursor)).unwrap();
  expect(names(second.items)).toEqual(["nightly-audit"]);
  expect(second.nextCursor).toBeUndefined();

  expect(names((await search("owner", "rout")).unwrap().items)).toEqual(["audit-routes"]);
  expect((await search("owner", "%")).unwrap().items).toEqual([]);
  expect((await search("owner", "absent")).unwrap().items).toEqual([]);
  expect(names((await search("alice", "nightly")).unwrap().items)).toEqual(["nightly-audit"]);
});

function postCard(threadId: string, runId: string, messageId: string) {
  store
    .postMessage("alice", threadId, {
      id: messageId,
      role: "assistant",
      parts: [
        {
          type: "data-actions",
          id: `actions_${messageId}`,
          data: {
            requestId: messageId,
            revision: 3,
            actions: [{ actionId: "pause", label: "Pause", style: "secondary" }],
          },
        },
      ],
    })
    .unwrap();
  workflows.upsertSurfaceBinding({
    runId,
    target: { platform: "native", channelId: threadId, replyToMessageId: null },
    messageRef: { platform: "native", channelId: threadId, messageId },
    lastRenderedSha256: null,
    lastError: null,
    retryCount: 0,
    nextAttemptAt: null,
    permanentFailure: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

test("a run points at its card's turn and offers the card's actions to editors only", async () => {
  const thread = store.createThread("alice", { commandId: "card" }).unwrap();
  const run = seedNativeWorkflowRun(workflows, {
    id: "card",
    name: "card",
    state: "running",
    threadId: thread.id,
    createdAt: 1,
  });
  const [before] = (await list("alice")).unwrap().items;
  expect(before?.thread?.source).toBeUndefined();

  store
    .postMessage("alice", thread.id, {
      id: "earlier",
      role: "assistant",
      parts: [{ type: "text", text: "Earlier" }],
    })
    .unwrap();
  postCard(thread.id, run.runId, "card-message");
  store
    .postMessage("alice", thread.id, {
      id: "later",
      role: "assistant",
      parts: [{ type: "text", text: "Later" }],
    })
    .unwrap();

  const [editor] = (await list("alice")).unwrap().items;
  const earlier = surface.readMessage("alice", thread.id, "earlier").unwrap();
  const later = surface.readMessage("alice", thread.id, "later").unwrap();
  expect(editor?.thread?.source?.messageId).toBe("card-message");
  expect(editor?.thread?.source?.position).toBeGreaterThan(earlier!.position);
  expect(editor?.thread?.source?.position).toBeLessThan(later!.position);
  expect(editor?.thread?.source?.actions?.data.revision).toBe(3);

  store.shareThread("owner", { threadId: thread.id, userId: "bob", grant: "read" }).unwrap();
  const [reader] = (await list("bob")).unwrap().items;
  expect(reader?.thread?.source?.messageId).toBe("card-message");
  expect(reader?.thread?.source?.actions).toBeUndefined();
});

test("another person's direct conversation stays hidden, even from the owner", async () => {
  const direct = store.ensureDirectThread("alice").unwrap();
  seedNativeWorkflowRun(workflows, {
    id: "direct",
    name: "private",
    state: "running",
    threadId: direct.id,
    createdAt: 1,
  });
  expect((await list("owner")).unwrap().items).toEqual([]);
  expect(names((await list("alice")).unwrap().items)).toEqual(["private"]);
});

test("the owner keeps sight of a run whose conversation was deleted", async () => {
  const thread = store.createThread("alice", { commandId: "deleted" }).unwrap();
  seedNativeWorkflowRun(workflows, {
    id: "orphan",
    name: "orphan",
    state: "running",
    threadId: thread.id,
    createdAt: 1,
  });
  store.deleteThread("alice", { threadId: thread.id, commandId: "delete" }).unwrap();
  const [run] = (await list("owner")).unwrap().items;
  expect(run?.card.name).toBe("orphan");
  expect(run?.thread).toBeUndefined();
  expect((await list("alice")).unwrap().items).toEqual([]);
});

test("subagent runs are left out so one piece of work is not listed twice", async () => {
  const thread = store.createThread("owner", { commandId: "parent" }).unwrap();
  const receipt = store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "send",
      historyGeneration: 0,
      mode: "prompt",
      text: "Start",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  store.settleInput(receipt.inputId, "admitted").unwrap();
  store.markInputCompleted(receipt.inputId).unwrap();
  seedNativeSubagent(store, workflows, thread.id, { id: "child" });
  expect((await list("owner")).unwrap().items).toEqual([]);
});

test("pages keep their place when a newer run starts between requests", async () => {
  for (let index = 0; index < 5; index += 1)
    seedNativeWorkflowRun(workflows, {
      id: `run-${index}`,
      name: `run-${index}`,
      state: "succeeded",
      createdAt: index + 1,
    });
  const first = (await listFinished("owner", { limit: 2 })).unwrap();
  expect(names(first.items)).toEqual(["run-4", "run-3"]);
  seedNativeWorkflowRun(workflows, { id: "new", name: "new", state: "succeeded", createdAt: 100 });
  const second = (await listFinished("owner", { limit: 2, cursor: first.nextCursor })).unwrap();
  expect(names(second.items)).toEqual(["run-2", "run-1"]);
  const third = (await listFinished("owner", { limit: 2, cursor: second.nextCursor })).unwrap();
  expect(names(third.items)).toEqual(["run-0"]);
  expect(third.nextCursor).toBeUndefined();
});

test("a page keeps scanning past runs this viewer cannot read", async () => {
  const hidden = store.createThread("bob", { commandId: "hidden" }).unwrap();
  const visible = store.createThread("alice", { commandId: "visible" }).unwrap();
  seedNativeWorkflowRun(workflows, {
    id: "visible",
    name: "visible",
    state: "running",
    threadId: visible.id,
    createdAt: 1,
  });
  for (let index = 0; index < 4; index += 1)
    seedNativeWorkflowRun(workflows, {
      id: `hidden-${index}`,
      name: "hidden",
      state: "running",
      threadId: hidden.id,
      createdAt: index + 2,
    });
  const page = (await list("alice", { limit: 2 })).unwrap();
  expect(names(page.items)).toEqual(["visible"]);
  expect(page.nextCursor).toBeUndefined();
});

test("rejects a malformed cursor", async () => {
  expect((await list("owner", { cursor: "nope" })).isErr()).toBe(true);
});

test("the sidebar flag follows active runs and survives a restart through seeding", () => {
  const thread = store.createThread("alice", { commandId: "flag" }).unwrap();
  const flag = () => store.getThread("alice", thread.id).unwrap().hasActiveWorkflow;
  const run = seedNativeWorkflowRun(workflows, {
    id: "flag",
    name: "flag",
    state: "running",
    threadId: thread.id,
    createdAt: 1,
  });
  seedNativeWorkflowRun(workflows, {
    id: "done",
    name: "done",
    state: "succeeded",
    threadId: thread.id,
    createdAt: 2,
  });
  expect(flag()).toBeUndefined();
  service.seedActive().unwrap();
  expect(flag()).toBe(true);
  workflows.transitionRun({
    runId: run.runId,
    from: "running",
    to: "succeeded",
    now: 10,
  });
  service.reconcile(run.runId).unwrap();
  expect(flag()).toBeUndefined();
});

test("seeding restores the flag for an old run behind more than one page of newer runs", () => {
  const old = store.createThread("alice", { commandId: "old" }).unwrap();
  const busy = store.createThread("alice", { commandId: "busy" }).unwrap();
  seedNativeWorkflowRun(workflows, {
    id: "old",
    name: "old",
    state: "paused",
    threadId: old.id,
    createdAt: 1,
  });
  for (let index = 0; index < 501; index += 1)
    seedNativeWorkflowRun(workflows, {
      id: `newer-${index}`,
      name: "newer",
      state: "paused",
      threadId: busy.id,
      createdAt: index + 2,
    });
  service.seedActive().unwrap();
  expect(store.getThread("alice", old.id).unwrap().hasActiveWorkflow).toBe(true);
});
