import type { RequestContext } from "../../tool-server/types";
import { HEARTBEAT_LEVEL2_CALLABLES } from "../../tool-server/request-control-authority";
import { createToolServer } from "../../tool-server/create-tool-server";
import { SqliteTranscriptStore } from "../../transcript/transcript-store";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { projectNativeOutput } from "./output-projection";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import type { WorkflowCard } from "@stanley2058/lilac-client-protocol";
import { Surface } from "../../tool-server/tools/surface";
import { SurfaceRuntimeRegistry } from "../runtime-descriptor";
import { NativeSurfaceAdapter } from "./adapter";
import { NativeStore } from "./store";
import { NativeSurfaceStore } from "./store-surface";
import {
  createNativeSurfaceRuntimeDescriptor,
  createNativeWorkflowProgressPort,
} from "./runtime-descriptor";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  const store = new NativeStore(db, () => 100);
  store.initialize().unwrap();
  for (const user of [
    { id: "owner", role: "owner" as const, toolMode: "full" as const },
    { id: "other", role: "participant" as const, toolMode: "full" as const },
    { id: "reader", role: "participant" as const, toolMode: "restricted" as const },
    { id: "lilac", role: "service" as const, toolMode: "full" as const },
  ])
    store.upsertUser({ ...user, providerId: user.id, displayName: user.id }).unwrap();
  const source = store.createThread("owner", { commandId: "source" }).unwrap();
  const destination = store.createThread("other", { commandId: "destination" }).unwrap();
  const reader = store.createThread("reader", { commandId: "reader-thread" }).unwrap();
  const actions: string[] = [];
  const surface = new NativeSurfaceStore(db, store, async (_actor, input) => {
    actions.push(input.actionId);
    return Result.ok(undefined);
  });
  surface.initialize().unwrap();
  const kicks: string[] = [];
  const adapter = new NativeSurfaceAdapter({
    store,
    surface,
    shouldTriggerRun: () => true,
    kick: (threadId) => {
      kicks.push(threadId);
    },
    now: () => 100,
    streamingMode: () => "paragraph",
  });
  const scoped = adapter.forRequest({
    principalId: "owner",
    sourceThreadId: source.id,
    requestId: "request",
  });
  const ref = { platform: "native" as const, channelId: source.id };
  return { db, store, surface, adapter, scoped, source, destination, reader, ref, kicks, actions };
}

describe("native surface adapter", () => {
  test("reaction variant limit rolls back excess additions without corrupting the turn", async () => {
    const f = fixture();
    const ref = (await f.scoped.sendMsg(f.ref, { text: "Reactions" })).unwrap();
    for (let index = 0; index < 64; index++)
      f.surface.setReaction("owner", f.source.id, ref.messageId, `emoji-${index}`, true).unwrap();
    const before = f.store.sync("owner", f.source.id).unwrap();
    expect(
      f.surface.setReaction("owner", f.source.id, ref.messageId, "overflow", true).isErr(),
    ).toBe(true);
    expect(f.surface.reactions("owner", f.source.id, ref.messageId).unwrap()).toHaveLength(64);
    expect(f.store.sync("owner", f.source.id).unwrap()).toEqual(before);

    f.store
      .shareThread("owner", { threadId: f.source.id, userId: "other", grant: "edit" })
      .unwrap();
    f.surface.setReaction("other", f.source.id, ref.messageId, "emoji-0", true).unwrap();
    f.surface.setReaction("owner", f.source.id, ref.messageId, "emoji-0", true).unwrap();
    expect(
      f.surface
        .reactions("owner", f.source.id, ref.messageId)
        .unwrap()
        .find((reaction) => reaction.emoji === "emoji-0")?.count,
    ).toBe(2);
    f.surface.setReaction("owner", f.source.id, ref.messageId, "emoji-1", false).unwrap();
    f.surface.setReaction("owner", f.source.id, ref.messageId, "overflow", true).unwrap();
    const message = f.surface.readMessage("owner", f.source.id, ref.messageId).unwrap()!.message;
    expect(message.parts.find((part) => part.type === "data-reactions")?.data.items).toHaveLength(
      64,
    );
    expect(f.store.sync("owner", f.source.id).isOk()).toBe(true);
  });

  test("unscoped and forged starter authority fail closed", async () => {
    const f = fixture();
    expect((await f.adapter.listSessions()).isErr()).toBe(true);
    const forged = f.adapter.forRequest({ principalId: "owner", sourceThreadId: f.destination.id });
    expect((await forged.listSessions()).isErr()).toBe(true);
    expect(
      (await f.scoped.readMsg({ platform: "discord", channelId: "d", messageId: "m" })).isErr(),
    ).toBe(true);
  });

  test("self-posts never admit input; cross-thread posts admit a service-authored prompt", async () => {
    const f = fixture();
    const local = (await f.scoped.sendMsg(f.ref, { text: "local" })).unwrap();
    expect(f.store.listPendingInputs().unwrap()).toHaveLength(0);
    expect(f.kicks).toEqual([]);
    expect((await f.scoped.readMsg(local)).unwrap()?.text).toBe("local");
    const remote = (
      await f.scoped.sendMsg(
        { platform: "native", channelId: f.destination.id },
        { text: "remote" },
      )
    ).unwrap();
    const [input] = f.store.listPendingInputs().unwrap();
    expect(input?.authorId).toBe("lilac");
    expect(input?.initiatingUserId).toBe("owner");
    expect(input?.messageId).toBe(remote.messageId);
    expect(f.kicks).toEqual([f.destination.id]);
    expect(f.store.getThreadRecord(f.destination.id).unwrap().starterId).toBe("other");
  });

  test("cross-thread prompts freeze the destination model definition at acceptance", async () => {
    const f = fixture();
    const pinned = {
      alias: "destination",
      spec: "openai/original",
      provider: "openai",
      modelId: "original",
      reasoningDisplay: "simple" as const,
      providerOptions: {},
    };
    const adapter = new NativeSurfaceAdapter({
      ...f.adapter.dependencies,
      resolveModel: () => Result.ok(pinned),
    }).forRequest({ principalId: "owner", sourceThreadId: f.source.id });
    (
      await adapter.sendMsg(
        { platform: "native", channelId: f.destination.id },
        { text: "use this definition" },
      )
    ).unwrap();
    const input = f.store.listPendingInputs(f.destination.id).unwrap()[0];
    expect(input?.resolvedModelRequest).toEqual(pinned);
  });

  test("restricted starter can use own thread but cannot prompt a read-shared thread", async () => {
    const f = fixture();
    f.store
      .shareThread("owner", { threadId: f.source.id, userId: "reader", grant: "edit" })
      .unwrap();
    const restricted = f.adapter.forRequest({ principalId: "reader", sourceThreadId: f.reader.id });
    expect(
      (
        await restricted.sendMsg({ platform: "native", channelId: f.reader.id }, { text: "own" })
      ).isOk(),
    ).toBe(true);
    expect((await restricted.sendMsg(f.ref, { text: "denied" })).isErr()).toBe(true);
    expect((await restricted.listMsg(f.ref)).isOk()).toBe(true);
    expect(f.kicks).toHaveLength(0);
  });

  test("read cursors are separate for humans and Lilac, reactions persist and remove", async () => {
    const f = fixture();
    const one = (await f.scoped.sendMsg(f.ref, { text: "one" })).unwrap();
    const two = (await f.scoped.sendMsg(f.ref, { text: "two" })).unwrap();
    (await f.scoped.markRead(f.ref, one)).unwrap();
    expect(
      (await f.scoped.getUnRead(f.ref)).unwrap().map((message) => message.ref.messageId),
    ).toEqual([two.messageId]);
    expect(f.surface.unread("owner", f.source.id, "owner").unwrap()).toHaveLength(2);
    (await f.scoped.addReaction(one, "👍")).unwrap();
    (await f.scoped.addReaction(one, "👍")).unwrap();
    expect((await f.scoped.listReactionDetails(one)).unwrap()).toEqual([
      { emoji: "👍", count: 1, users: [{ userId: "lilac" }] },
    ]);
    (await f.scoped.removeReaction(one, "👍")).unwrap();
    expect((await f.scoped.listReactions(one)).unwrap()).toEqual([]);
  });

  test("reply chains and message paging retain chronological order", async () => {
    const f = fixture();
    const one = (await f.scoped.sendMsg(f.ref, { text: "one" })).unwrap();
    const two = (await f.scoped.sendMsg(f.ref, { text: "two" }, { replyTo: one })).unwrap();
    const three = (await f.scoped.sendMsg(f.ref, { text: "three" }, { replyTo: two })).unwrap();
    expect((await f.scoped.planReplyChain(three)).unwrap()).toEqual([one, two, three]);
    expect(
      (await f.scoped.listMsg(f.ref, { beforeMessageId: three.messageId, limit: 1 }))
        .unwrap()
        .map((message) => message.text),
    ).toEqual(["two"]);
    expect(
      (await f.scoped.listMsg(f.ref, { afterMessageId: one.messageId }))
        .unwrap()
        .map((message) => message.text),
    ).toEqual(["two", "three"]);
    expect((await f.scoped.getReplyContext(three)).unwrap().map((message) => message.text)).toEqual(
      ["one", "two", "three"],
    );
    expect(
      (
        await f.scoped.sendMsg(
          f.ref,
          { text: "invalid" },
          { replyTo: { ...one, channelId: f.destination.id } },
        )
      ).isErr(),
    ).toBe(true);
  });

  test("maintenance edits only service messages and fences stale actions", async () => {
    const f = fixture();
    const ref = (
      await f.scoped.sendMsg(f.ref, {
        text: "action",
        actions: [{ actionId: "resume", label: "Resume", style: "success" }],
      })
    ).unwrap();
    const action = {
      threadId: f.source.id,
      messageId: ref.messageId,
      actionId: "resume",
      requestId: "request",
      revision: 0,
      commandId: "click",
    };
    expect((await f.surface.invokeAction("owner", action)).unwrap().outcome).toBe("accepted");
    expect((await f.surface.invokeAction("owner", action)).unwrap().outcome).toBe(
      "already-applied",
    );
    expect(f.actions).toEqual(["resume"]);
    (
      await f.scoped.editMsg(ref, {
        text: "edited",
        actions: [{ actionId: "resume", label: "Resume", style: "primary" }],
      })
    ).unwrap();
    expect(
      (await f.surface.invokeAction("owner", { ...action, commandId: "new-click" })).unwrap()
        .outcome,
    ).toBe("stale");
    expect((await f.scoped.readMsg(ref)).unwrap()?.text).toBe("edited");
    f.store
      .postMessage("owner", f.source.id, {
        id: "user-message",
        role: "user",
        metadata: { authorId: "owner" },
        parts: [{ type: "text", text: "user" }],
      })
      .unwrap();
    expect((await f.scoped.deleteMsg({ ...ref, messageId: "user-message" })).isErr()).toBe(true);
    (await f.scoped.deleteMsg(ref)).unwrap();
    expect((await f.scoped.readMsg(ref)).unwrap()).toBeNull();
  });

  test("output buffers text to paragraphs and finishes activity without admitting runs", async () => {
    const f = fixture();
    const output = (await f.scoped.startOutput(f.ref)).unwrap();
    (await output.push({ type: "text.delta", delta: "first" })).unwrap();
    expect((await f.scoped.listMsg(f.ref)).unwrap()).toEqual([]);
    (await output.push({ type: "text.delta", delta: "\r\n\r\ntail" })).unwrap();
    expect((await f.scoped.listMsg(f.ref)).unwrap()[0]?.text).toBe("first\n\n");
    const checkpoint = f.store.sync("owner", f.source.id).unwrap().checkpoint;
    (await output.push({ type: "text.delta", delta: " more" })).unwrap();
    expect(f.store.sync("owner", f.source.id).unwrap().checkpoint).toEqual(checkpoint);
    (
      await output.push({
        type: "reasoning.status",
        update: { startedAtMs: 1, detailText: "private reasoning" },
      })
    ).unwrap();
    const finished = (await output.finish()).unwrap();
    expect((await f.scoped.readMsg(finished.last)).unwrap()?.text).toBe("first\n\ntail more");
    expect(JSON.stringify(f.store.sync("owner", f.source.id).unwrap())).not.toContain(
      "private reasoning",
    );
    expect(f.store.listPendingInputs().unwrap()).toEqual([]);
    expect(f.kicks).toEqual([]);
    expect((await output.push({ type: "text.delta", delta: "late" })).unwrap()).toBe("terminal");
  });

  test("workflow progress uses per-target starter scope and native exposes no question or relay", async () => {
    const f = fixture();
    const resolve = (threadId: string) =>
      f.store
        .getThreadRecord(threadId)
        .map((thread) =>
          f.adapter.forRequest({ principalId: thread.starterId, sourceThreadId: threadId }),
        );
    const port = createNativeWorkflowProgressPort((threadId) =>
      resolve(threadId).mapError(() => {
        throw new Error("unexpected missing fixture");
      }),
    );
    const card: WorkflowCard = {
      name: "audit-routes",
      description: "Audit routes.",
      status: "running",
      startedAt: 1_000,
      progress: {
        completed: 0,
        queued: 0,
        active: 1,
        waiting: 0,
        failed: 0,
        cancelled: 0,
        total: 1,
      },
      phases: [],
      steps: [{ label: "Inspect routes", kind: "agent", state: "running" }],
      agents: { used: 1, active: 1, queued: 0 },
      sensitive: false,
    };
    const message = (
      await port.send({
        channelId: f.destination.id,
        content: { text: "progress", workflow: card },
      })
    ).unwrap();
    expect((await port.checkMessage(message)).unwrap()).toBe("found");
    const stored = () =>
      f.surface.readMessage("owner", f.destination.id, message.messageId).unwrap()!.message.parts;
    expect(stored()).toEqual([
      { type: "text", text: "progress" },
      { type: "data-workflow", id: `workflow_${message.messageId}`, data: card },
    ]);
    const done = { ...card, status: "succeeded" as const, endedAt: 2_000, steps: [] };
    (await port.edit(message, { text: "done", workflow: done })).unwrap();
    expect(stored()).toEqual([
      { type: "text", text: "done" },
      { type: "data-workflow", id: `workflow_${message.messageId}`, data: done },
    ]);
    expect(f.kicks).toEqual([]);
    const descriptor = createNativeSurfaceRuntimeDescriptor({
      adapter: f.adapter,
      resolveWorkflowAdapter: () => Result.ok(f.scoped),
    });
    expect(descriptor.createQuestion).toBeUndefined();
    expect(descriptor.createRelay).toBeUndefined();
  });
  test("surface tools reject forged authority before asking for a scoped adapter", async () => {
    const f = fixture();
    let scopedCalls = 0;
    const registry = SurfaceRuntimeRegistry.create([
      createNativeSurfaceRuntimeDescriptor({
        adapter: f.adapter,
        resolveWorkflowAdapter: () => Result.ok(f.scoped),
      }),
    ]).unwrap();
    const tool = new Surface({
      adapterResolver: registry.adapterResolver(),
      nativeAdapterForContext: () => {
        scopedCalls++;
        return Result.ok(f.scoped);
      },
    });
    const context = {
      requestClient: "native",
      sessionId: `native:${f.source.id}`,
      requestInitiator: { platform: "native" as const, userId: "owner" },
    };
    const denied = await tool.call("surface.sessions.list", {}, { context });
    expect(denied.isErr()).toBe(true);
    expect(scopedCalls).toBe(0);
    const allowed = await tool.call(
      "surface.sessions.list",
      {},
      { context: { ...context, serverOwnedRequest: true } },
    );
    expect(allowed.match({ ok: () => null, err: (error) => error })).toBeNull();
    expect(scopedCalls).toBe(1);
  });

  test("reaction names are bounded, refreshed on read, and keep viewer state beyond the cap", async () => {
    const f = fixture();
    const ref = (await f.scoped.sendMsg(f.ref, { text: "Reactions" })).unwrap();
    for (let index = 0; index < 7; index++) {
      const id = `person-${index}`;
      f.store
        .upsertUser({
          id,
          providerId: id,
          displayName: `Person ${index}`,
          role: "participant",
          toolMode: "full",
        })
        .unwrap();
      f.surface.setReaction("owner", f.source.id, ref.messageId, "👍", true, id).unwrap();
    }
    f.store
      .shareThread("owner", { threadId: f.source.id, userId: "person-6", grant: "read" })
      .unwrap();
    const stored = f.surface.readMessage("owner", f.source.id, ref.messageId).unwrap()!.message;
    expect(
      stored.parts.find((part) => part.type === "data-reactions")?.data.items[0]?.userNames,
    ).toBeUndefined();
    const message = f.surface.personalizeMessage("person-6", f.source.id, stored).unwrap();
    expect(message.parts.find((part) => part.type === "data-reactions")?.data.items[0]).toEqual({
      emoji: "👍",
      count: 7,
      reacted: true,
      userNames: ["Person 0", "Person 1", "Person 2", "Person 3", "Person 4"],
      overflowCount: 2,
    });
    f.store
      .upsertUser({
        id: "person-0",
        providerId: "person-0",
        displayName: "Renamed",
        role: "participant",
        toolMode: "full",
      })
      .unwrap();
    const renamed = f.surface.personalizeMessage("owner", f.source.id, stored).unwrap();
    expect(
      renamed.parts.find((part) => part.type === "data-reactions")?.data.items[0]?.userNames?.[0],
    ).toBe("Renamed");
  });

  test("reaction projections contain each viewer's state and read-only actions are denied", async () => {
    const f = fixture();
    const ref = (
      await f.scoped.sendMsg(f.ref, {
        text: "reaction",
        actions: [{ actionId: "act", label: "Act", style: "primary" }],
      })
    ).unwrap();
    f.surface.setReaction("owner", f.source.id, ref.messageId, "ok", true).unwrap();
    const message = f.surface.readMessage("owner", f.source.id, ref.messageId).unwrap()!.message;
    f.store
      .shareThread("owner", { threadId: f.source.id, userId: "reader", grant: "edit" })
      .unwrap();
    const owner = f.surface.personalizeMessage("owner", f.source.id, message).unwrap();
    const reader = f.surface.personalizeMessage("reader", f.source.id, message).unwrap();
    expect(owner.parts.find((part) => part.type === "data-reactions")?.data.items[0]?.reacted).toBe(
      true,
    );
    expect(
      reader.parts.find((part) => part.type === "data-reactions")?.data.items[0]?.reacted,
    ).toBe(false);
    expect(
      (
        await f.surface.invokeAction("reader", {
          threadId: f.source.id,
          messageId: ref.messageId,
          actionId: "act",
          requestId: "request",
          revision: 0,
          commandId: "readonly-action",
        })
      ).isErr(),
    ).toBe(true);
    expect(f.actions).toEqual([]);
  });

  test("resource tool metadata requires origin read access after forwarding", async () => {
    const f = fixture();
    const upload = f.store
      .reserveUpload("owner", {
        threadId: f.source.id,
        filename: "image.png",
        mediaType: "image/png",
        size: 2,
      })
      .unwrap();
    const claimed = f.store.claimUpload("owner", upload.id).unwrap();
    f.store
      .settleUpload(upload.id, {
        attempt: claimed.attempt,
        historyGeneration: claimed.historyGeneration,
        state: "ready",
        resourceUri: "resource://test-image",
      })
      .unwrap();
    f.store
      .postMessage("owner", f.source.id, {
        id: "original",
        role: "assistant",
        metadata: { authorId: "lilac" },
        parts: [
          {
            type: "data-resource",
            id: upload.id,
            data: {
              resourceId: upload.id,
              name: "image.png",
              mediaType: "image/png",
              size: 2,
              state: "ready",
            },
          },
        ],
      })
      .unwrap();
    const copy = f.surface.readMessage("owner", f.source.id, "original").unwrap()!.message;
    f.store.postMessage("owner", f.destination.id, { ...copy, id: "copy" }).unwrap();
    const destination = f.adapter.forRequest({
      principalId: "other",
      sourceThreadId: f.destination.id,
    });
    const ref = { platform: "native" as const, channelId: f.destination.id, messageId: "copy" };
    expect((await destination.readMsg(ref)).unwrap()?.attachments).toBeUndefined();
    f.store
      .shareThread("owner", { threadId: f.source.id, userId: "other", grant: "read" })
      .unwrap();
    expect((await destination.readMsg(ref)).unwrap()?.attachments?.[0]?.url).toBe(
      "resource://test-image",
    );
    f.store.shareThread("owner", { threadId: f.source.id, userId: "other", grant: null }).unwrap();
    expect((await destination.readMsg(ref)).unwrap()?.attachments).toBeUndefined();
  });

  test("resumed output preserves existing text and forbids user-message takeover", async () => {
    const f = fixture();
    const ref = (await f.scoped.sendMsg(f.ref, { text: "before" })).unwrap();
    const stream = (await f.scoped.startOutput(f.ref, { resumeAt: ref })).unwrap();
    (await stream.push({ type: "text.delta", delta: " after" })).unwrap();
    (await stream.finish()).unwrap();
    expect((await f.scoped.readMsg(ref)).unwrap()?.text).toBe("before after");
    f.store
      .postMessage("owner", f.source.id, {
        id: "human",
        role: "user",
        metadata: { authorId: "owner" },
        parts: [{ type: "text", text: "mine" }],
      })
      .unwrap();
    expect(
      (await f.scoped.startOutput(f.ref, { resumeAt: { ...ref, messageId: "human" } })).isErr(),
    ).toBe(true);
  });
  test("deleted-thread maintenance drops reactions and read positions only for deleted threads", async () => {
    const f = fixture();
    const one = (await f.scoped.sendMsg(f.ref, { text: "remove with thread" })).unwrap();
    const other = f.adapter.forRequest({ principalId: "other", sourceThreadId: f.destination.id });
    const two = (
      await other.sendMsg({ platform: "native", channelId: f.destination.id }, { text: "keep" })
    ).unwrap();
    (await f.scoped.addReaction(one, "yes")).unwrap();
    (await other.addReaction(two, "yes")).unwrap();
    (await f.scoped.markRead(f.ref, one)).unwrap();
    (await other.markRead({ platform: "native", channelId: f.destination.id }, two)).unwrap();
    f.store.deleteThread("owner", { threadId: f.source.id, commandId: "delete-fixture" }).unwrap();
    expect(f.surface.pruneDeleted().unwrap()).toBe(2);
    expect(f.surface.pruneDeleted().unwrap()).toBe(0);
    expect((await other.listReactions(two)).unwrap()).toEqual(["yes"]);
    expect(
      (await other.getUnRead({ platform: "native", channelId: f.destination.id })).unwrap(),
    ).toEqual([]);
  });
});

test("projected replies, including legacy replies, support edit, resume, and delete", async () => {
  const f = fixture();
  for (const legacy of [false, true]) {
    const projected = projectNativeOutput(
      {
        kind: "ready",
        slotId: "turn",
        turnId: "turn",
        position: 0,
        state: "running",
        messages: [],
      },
      {
        threadId: f.source.id,
        turnId: "turn",
        generation: 0,
        requestId: "request",
        attemptId: legacy ? "old" : "new",
        sequence: 1,
        ordinal: 1,
        eventId: "event",
        occurredAt: 100,
        payload: {
          type: "text",
          partId: "part",
          stepId: "step",
          position: 1,
          phase: "final_answer",
          text: "Answer",
          incomplete: false,
        },
      },
    ).slot.messages[0]!;
    expect(projected.metadata?.authorId).toBe("lilac");
    if (legacy) delete projected.metadata!.authorId;
    f.store.postMessage("owner", f.source.id, projected).unwrap();
    const ref = { ...f.ref, messageId: projected.id };
    expect((await f.scoped.readMsg(ref)).unwrap()).toMatchObject({
      userId: "lilac",
      userName: "lilac",
      text: "Answer",
    });
    (await f.scoped.editMsg(ref, { text: "Corrected" })).unwrap();
    const output = (await f.scoped.startOutput(f.ref, { resumeAt: ref })).unwrap();
    (await output.finish()).unwrap();
    (await f.scoped.deleteMsg(ref)).unwrap();
    expect((await f.scoped.readMsg(ref)).unwrap()).toBeNull();
  }
  f.store
    .postMessage("owner", f.source.id, {
      id: "unowned",
      role: "assistant",
      parts: [{ type: "text", text: "Unknown" }],
    })
    .unwrap();
  expect((await f.scoped.editMsg({ ...f.ref, messageId: "unowned" }, { text: "No" })).isErr()).toBe(
    true,
  );
});

test("native tool targets round-trip and expose names and reply context", async () => {
  const f = fixture();
  const registry = SurfaceRuntimeRegistry.create([
    createNativeSurfaceRuntimeDescriptor({
      adapter: f.adapter,
      resolveWorkflowAdapter: () => Result.ok(f.scoped),
    }),
  ]).unwrap();
  const tool = new Surface({
    config: parseCoreConfigV2ToUniversal({ models: { main: { model: "openai/demo" } } }),
    adapterResolver: registry.adapterResolver(),
    nativeAdapterForContext: () => Result.ok(f.scoped),
  });
  const context = {
    requestClient: "native",
    requestId: "request",
    sessionId: `native:${f.source.id}`,
    requestInitiator: { platform: "native" as const, userId: "owner" },
    requestInitiatorSessionId: f.source.id,
    serverOwnedRequest: true,
  };
  const first = (await f.scoped.sendMsg(f.ref, { text: "Original" })).unwrap();
  const reply = (await f.scoped.sendMsg(f.ref, { text: "Reply" }, { replyTo: first })).unwrap();
  for (const sessionId of [f.source.id, `native:${f.source.id}`]) {
    const result = await tool.call(
      "surface.messages.read",
      { sessionId, messageId: reply.messageId },
      { context },
    );
    expect(result.match({ ok: () => null, err: (error) => error })).toBeNull();
    const read = result.unwrap();
    expect(read).toMatchObject({
      message: {
        userName: "lilac",
        replyToMessageId: first.messageId,
        referenced: { richText: "Original", userName: "lilac" },
      },
    });
    const listed = (await tool.call("surface.messages.list", { sessionId }, { context })).unwrap();
    expect(JSON.stringify(listed)).toContain('"referenced"');
  }
});

test("session listing paginates tied timestamps and can select archived threads", async () => {
  const f = fixture();
  for (let i = 0; i < 103; i++) f.store.createThread("owner", { commandId: `bulk-${i}` }).unwrap();
  const all = (await f.scoped.listSessions()).unwrap();
  expect(all).toHaveLength(106);
  expect(new Set(all.map((s) => s.ref.channelId)).size).toBe(106);
  expect((await f.scoped.listSessions({ limit: 101 })).unwrap()).toHaveLength(101);
  f.store
    .updateThread("owner", { threadId: f.source.id, commandId: "archive", archived: true })
    .unwrap();
  expect(
    (await f.scoped.listSessions({ archived: true })).unwrap().map((s) => s.ref.channelId),
  ).toEqual([f.source.id]);
  expect((await f.scoped.listSessions()).unwrap()).toHaveLength(105);
});

test("native sends appear in recent writes and deletion removes their links", async () => {
  const f = fixture();
  const transcript = new SqliteTranscriptStore(":memory:");
  try {
    const registry = SurfaceRuntimeRegistry.create([
      createNativeSurfaceRuntimeDescriptor({
        adapter: f.adapter,
        resolveWorkflowAdapter: () => Result.ok(f.scoped),
      }),
    ]).unwrap();
    const tool = new Surface({
      config: parseCoreConfigV2ToUniversal({}),
      transcriptStore: transcript,
      adapterResolver: registry.adapterResolver(),
      nativeAdapterForContext: () => Result.ok(f.scoped),
    });
    const context = {
      requestClient: "native",
      requestId: "request",
      sessionId: `native:${f.source.id}`,
      requestInitiator: { platform: "native" as const, userId: "owner" },
      requestInitiatorSessionId: f.source.id,
      serverOwnedRequest: true,
    };
    transcript
      .saveRequestTranscript({
        requestId: "request",
        sessionId: context.sessionId,
        requestClient: "native",
        messages: [],
        finalText: "Old final text",
      })
      .unwrap();
    (
      await tool.call(
        "surface.messages.send",
        { text: "Sent by tool", triggerRun: true },
        { context },
      )
    ).unwrap();
    expect(
      (await tool.call("surface.activities.recentAgentWrites", {}, { context })).unwrap(),
    ).toMatchObject([{ preview: "Sent by tool", requestId: "request" }]);
    const refs = transcript.listSurfaceMessagesForRequest({ requestId: "request" });
    expect(refs).toHaveLength(1);
    (
      await tool.call("surface.messages.delete", { messageId: refs[0]!.messageId }, { context })
    ).unwrap();
    expect(
      (await tool.call("surface.activities.recentAgentWrites", {}, { context })).unwrap(),
    ).toEqual([]);
    expect(transcript.listSurfaceMessagesForRequest({ requestId: "request" })).toEqual([]);
  } finally {
    transcript.close();
  }
});

test("DM aliases resolve per authenticated user and surface tools return concrete targets", async () => {
  const f = fixture();
  const registry = SurfaceRuntimeRegistry.create([
    createNativeSurfaceRuntimeDescriptor({
      adapter: f.adapter,
      resolveWorkflowAdapter: () => Result.ok(f.scoped),
    }),
  ]).unwrap();
  const tool = new Surface({
    config: parseCoreConfigV2ToUniversal({}),
    adapterResolver: registry.adapterResolver(),
    nativeAdapterForContext: () => Result.ok(f.scoped),
  });
  const context = {
    requestClient: "native",
    requestId: "request",
    sessionId: `native:${f.source.id}`,
    requestInitiator: { platform: "native" as const, userId: "owner" },
    requestInitiatorSessionId: f.source.id,
    serverOwnedRequest: true,
  };
  const listed = (
    await tool.call("surface.messages.list", { client: "native", sessionId: "dm" }, { context })
  ).unwrap();
  const ownerDm = f.store.ensureDirectThread("owner").unwrap();
  expect(listed).toMatchObject({
    meta: { session: { platform: "native", channelId: ownerDm.id } },
  });
  (
    await tool.call(
      "surface.messages.send",
      { client: "native", sessionId: "dm", text: "Notification only" },
      { context },
    )
  ).unwrap();
  expect(f.store.listPendingInputs().unwrap()).toHaveLength(0);
  expect(f.kicks).toEqual([]);
  f.store.settleSurfaceSends("request").unwrap();
  f.store.deliverSurfaceSends().unwrap();
  const notification = (
    await f.scoped.listMsg({ platform: "native", channelId: ownerDm.id })
  ).unwrap()[0]!;
  expect(notification.text).toBe("Notification only");
  expect(
    f.surface.readMessage("owner", ownerDm.id, notification.ref.messageId).unwrap()?.message
      .metadata?.phase,
  ).toBe("final");
  (
    await tool.call(
      "surface.messages.send",
      { client: "native", sessionId: "dm", text: "For my DM", triggerRun: true },
      { context },
    )
  ).unwrap();
  expect(
    (await f.scoped.listMsg({ platform: "native", channelId: ownerDm.id }))
      .unwrap()
      .map((message) => message.text),
  ).toContain("For my DM");
  expect(f.store.listPendingInputs().unwrap()).toHaveLength(1);
  expect(f.kicks).toEqual([ownerDm.id]);
  const other = f.adapter.forRequest({
    principalId: "other",
    sourceThreadId: f.destination.id,
    requestId: "other-request",
  });
  const otherDm = (await other.resolveSessionAlias("dm")).unwrap();
  expect(otherDm.channelId).not.toBe(ownerDm.id);
  expect(otherDm.channelId).toBe(f.store.ensureDirectThread("other").unwrap().id);
  expect((await f.adapter.resolveSessionAlias("dm")).isErr()).toBe(true);
  expect((await f.scoped.resolveSessionAlias("unknown")).isErr()).toBe(true);
  const forged = f.adapter.forRequest({
    principalId: "other",
    sourceThreadId: f.source.id,
    requestId: "forged",
  });
  expect((await forged.resolveSessionAlias("dm")).isErr()).toBe(true);
  expect(
    (
      await tool.call("surface.messages.send", {
        client: "native",
        sessionId: "dm",
        text: "Denied",
      })
    ).isErr(),
  ).toBe(true);
  expect(
    (
      await tool.call(
        "surface.messages.send",
        { client: "native", sessionId: "dm", text: "Denied" },
        {
          context: {
            ...context,
            requestClient: "discord",
            requestInitiator: { platform: "discord", userId: "owner" },
          },
        },
      )
    ).isErr(),
  ).toBe(true);
  const help = (await tool.call("surface.help", { client: "native" }, { context })).unwrap();
  expect(JSON.stringify(help)).toContain('"format":"dm"');
  expect(JSON.stringify(help)).toContain("triggerRun");
  expect(JSON.stringify(help)).toContain("Defaults to false");
  expect(JSON.stringify(help)).not.toContain("suppressRun");
  expect(
    (
      await tool.call(
        "surface.messages.send",
        { client: "native", sessionId: "dm", text: "Old flag", suppressRun: true },
        { context },
      )
    ).isErr(),
  ).toBe(true);
});

test("trusted cross-surface capabilities use owner access without exposing other private DMs", async () => {
  const f = fixture();
  const ownerDm = f.store.ensureDirectThread("owner").unwrap();
  const otherDm = f.store.ensureDirectThread("other").unwrap();
  const context: RequestContext = {
    serverOwnedRequest: true,
    safetyMode: "trusted",
    requestClient: "discord",
    requestInitiator: { platform: "discord", userId: "discord-user" },
    controlPolicy: { kind: "primary", allowedCallables: null },
  };
  const adapter = f.adapter.forToolContext(context, "owner").unwrap();
  expect((await adapter.resolveSessionAlias("dm")).unwrap().channelId).toBe(ownerDm.id);
  expect((await adapter.listSessions()).unwrap().map((s) => s.ref.channelId)).not.toContain(
    otherDm.id,
  );
  expect(
    (
      await adapter.sendMsg({ platform: "native", channelId: otherDm.id }, { text: "private" })
    ).isErr(),
  ).toBe(true);
  const sent = (
    await adapter.sendMsg({ platform: "native", channelId: f.source.id }, { text: "cross-surface" })
  ).unwrap();
  expect((await adapter.readMsg(sent)).unwrap()?.text).toBe("cross-surface");
  for (const denied of [
    { ...context, serverOwnedRequest: false },
    { ...context, safetyMode: "restricted" as const },
    { ...context, controlPolicy: undefined },
  ])
    expect(f.adapter.forToolContext(denied, "owner").isErr()).toBe(true);
  expect(f.adapter.forToolContext(context, "other").isErr()).toBe(true);
});

test("native participant authority stays scoped even with a trusted capability", async () => {
  const f = fixture();
  const otherDm = f.store.ensureDirectThread("other").unwrap();
  const ownerDm = f.store.ensureDirectThread("owner").unwrap();
  const adapter = f.adapter
    .forToolContext(
      {
        serverOwnedRequest: true,
        safetyMode: "trusted",
        requestInitiator: { platform: "native", userId: "other" },
        requestInitiatorSessionId: otherDm.id,
        controlPolicy: { kind: "primary", allowedCallables: null },
      },
      "owner",
    )
    .unwrap();
  expect((await adapter.resolveSessionAlias("dm")).unwrap().channelId).toBe(otherDm.id);
  expect((await adapter.listMsg({ platform: "native", channelId: ownerDm.id })).isErr()).toBe(true);
});

test("authenticated heartbeat discovers native history and delivers to a chosen thread without waking it", async () => {
  const f = fixture();
  const transcript = new SqliteTranscriptStore(":memory:");
  const registry = SurfaceRuntimeRegistry.create([
    createNativeSurfaceRuntimeDescriptor({
      adapter: f.adapter,
      resolveWorkflowAdapter: () => Result.ok(f.scoped),
    }),
  ]).unwrap();
  const surface = new Surface({
    config: parseCoreConfigV2ToUniversal({}),
    transcriptStore: transcript,
    adapterResolver: registry.adapterResolver(),
    nativeAdapterForContext: (ctx) => f.adapter.forToolContext(ctx, "owner"),
  });
  const server = createToolServer({
    tools: [surface],
    authorizeControlRequest: ({ token }) =>
      token === "heartbeat-test"
        ? {
            kind: "heartbeat",
            principal: null,
            authenticatedOrigin: null,
            allowedCallables: HEARTBEAT_LEVEL2_CALLABLES,
            profile: "primary",
            canonicalCwd: "/tmp",
            safetyMode: "trusted",
          }
        : null,
  });
  await server.init();
  const headers = {
    "content-type": "application/json",
    "x-lilac-request-id": "heartbeat:test",
    "x-lilac-session-id": "__heartbeat__",
    "x-lilac-request-client": "unknown",
    "x-lilac-control-capability": "heartbeat-test",
    "x-lilac-cwd": "/tmp",
  };
  async function call(callableId: string, input: object, requestHeaders = headers) {
    const response = await server.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ callableId, input }),
      }),
    );
    return response.json();
  }
  try {
    transcript
      .saveRequestTranscript({
        requestId: "heartbeat:test",
        sessionId: "__heartbeat__",
        requestClient: "unknown",
        messages: [],
        finalText: "HEARTBEAT_OK",
      })
      .unwrap();
    transcript
      .saveRequestTranscript({
        requestId: "heartbeat:test:heartbeat-handoff:deferred",
        sessionId: "__heartbeat__:handoff",
        requestClient: "unknown",
        messages: [{ role: "assistant", content: "Forecast changed" }],
        finalText: "Forecast changed",
      })
      .unwrap();
    const sent = await call("surface.messages.send", {
      client: "native",
      sessionId: f.source.id,
      text: "Forecast changed",
    });
    expect(sent).toMatchObject({ status: "ok", value: { status: "queued" } });
    expect((await f.scoped.listMsg(f.ref)).unwrap()).toHaveLength(0);
    f.store.settleSurfaceSends("heartbeat:test").unwrap();
    f.store.deliverSurfaceSends().unwrap();
    for (const link of f.store.listProjectedMessageLinks("heartbeat:test").unwrap()) {
      const refs = link.messageIds.map((messageId) => ({
        platform: "native" as const,
        channelId: link.threadId,
        messageId,
      }));
      transcript.linkSurfaceMessagesToRequest({
        requestId: link.requestId,
        created: refs,
        last: refs.at(-1)!,
      });
    }

    expect(f.store.listPendingInputs().unwrap()).toHaveLength(0);
    expect(f.kicks).toEqual([]);
    const messages = (await f.scoped.listMsg(f.ref)).unwrap();
    const delivered = messages.find((m) => m.text === "Forecast changed");
    expect(delivered).toBeDefined();
    const displayed = f.surface
      .readMessage("owner", f.source.id, delivered!.ref.messageId)
      .unwrap()!.message;
    expect(displayed).toMatchObject({
      role: "assistant",
      metadata: { authorId: "lilac", phase: "final" },
      parts: [{ type: "text", text: "Forecast changed" }],
    });
    expect(
      JSON.stringify(await call("surface.activities.recentAgentWrites", { client: "native" })),
    ).toContain("Forecast changed");
    expect(
      (await call("surface.messages.list", { client: "native", sessionId: f.source.id })).status,
    ).toBe("ok");
    expect(
      (
        await call("surface.messages.send", {
          client: "native",
          sessionId: "dm",
          text: "Default DM",
        })
      ).status,
    ).toBe("ok");
    const otherDm = f.store.ensureDirectThread("other").unwrap();
    expect(
      (
        await call("surface.messages.send", {
          client: "native",
          sessionId: otherDm.id,
          text: "Denied",
        })
      ).status,
    ).toBe("error");
    const forged = await call(
      "surface.messages.send",
      { client: "native", sessionId: f.source.id, text: "Forged" },
      { ...headers, "x-lilac-control-capability": "invalid" },
    );
    expect(forged.status).toBe("error");
  } finally {
    await server.stop();
    transcript.close();
  }
});
