import { Result } from "better-result";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createToolServer } from "../../../src/tool-server/create-tool-server";
import { RequestControlAuthority } from "../../../src/tool-server/request-control-authority";
import { Attachment } from "../../../src/tool-server/tools/attachment";
import { expect, test } from "bun:test";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { NativeThreadStore } from "../../../../../packages/client/src/thread-store";
import {
  threadEventSchema,
  type DisplayStreamTarget,
  type ReplayReply,
} from "@stanley2058/lilac-client-protocol";
import { createNativeIntegrationFixture, integrationValue } from "./integration-fixture";
import { seedNativeSubagent } from "./subagent-fixture";

async function fixture() {
  const f = await createNativeIntegrationFixture();
  const { client } = f.connect();
  const thread = await client.threads.create({
    commandId: crypto.randomUUID(),
    title: "Agent streams",
  });
  const receipt = await client.inputs.submit({
    threadId: thread.id,
    commandId: crypto.randomUUID(),
    mode: "prompt",
    historyGeneration: 0,
    text: "Research this",
    attachmentIds: [],
    skillIds: [],
  });
  if (!f.store.getInput(receipt.inputId).unwrap().completedAt) {
    await new Promise<void>((resolve) => {
      const stop = f.store.subscribe(() => {
        if (!f.store.getInput(receipt.inputId).unwrap().completedAt) return;
        stop();
        resolve();
      });
      if (f.store.getInput(receipt.inputId).unwrap().completedAt) {
        stop();
        resolve();
      }
    });
  }
  const child = seedNativeSubagent(f.store, f.workflows, thread.id);
  const target: DisplayStreamTarget = {
    kind: "subagent",
    threadId: thread.id,
    agentId: child.run.runId,
  };
  const publisher = f.runtime.createOutput({
    requestId: child.requestId,
    sessionId: child.sessionId,
    requestClient: "unknown",
    workflowRunId: child.run.runId,
    prompt: "Research the question",
  });
  if (!publisher) throw new Error("Missing native child publisher");
  return { ...f, client, thread, receipt, child, target, publisher };
}

test("thread and child subscriptions share display projection, deltas, completed history, and replay checkpoints", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let events: Awaited<ReturnType<typeof f.client.streams.watch>> | undefined;
  try {
    expect(
      await f.client.streams.sync({ target: { kind: "thread", threadId: f.thread.id } }),
    ).toEqual(await f.client.threads.sync({ threadId: f.thread.id }));
    events = await f.client.streams.watch({ target: f.target }, { signal: controller.signal });
    const first = await events.next();
    const firstEvent = threadEventSchema.parse(first.value);
    if (firstEvent.kind !== "replay") throw new Error("Missing stream window");
    const store = new NativeThreadStore();
    store.replay(firstEvent.reply);
    expect(store.at(0)).toMatchObject({
      state: "running",
      messages: [{ role: "user", parts: [{ type: "text", text: "Research the question" }] }],
    });
    f.publisher.activity({
      activityId: "thinking",
      stepId: "step",
      kind: "thinking",
      state: "complete",
      detail: "Checking the source",
    });
    f.publisher.activity({
      activityId: "bash",
      stepId: "step",
      kind: "tool",
      state: "start",
      label: "bash cat report.md",
      detail: "bash cat report.md",
    });
    integrationValue(await f.publisher.captureBarrier());
    const next = await events.next();
    const nextEvent = threadEventSchema.parse(next.value);
    if (nextEvent.kind !== "replay") throw new Error("Missing stream delta");
    expect(nextEvent.reply.kind).toBe("delta");
    store.replay(nextEvent.reply);
    const checkpoint = store.checkpoint!;
    controller.abort();
    f.publisher.activity({
      activityId: "bash",
      stepId: "step",
      kind: "tool",
      state: "complete",
      label: "bash cat report.md",
      output: "Source text",
      exitCode: 0,
      durationMs: 12,
    });
    f.publisher.textStart({ partId: "answer", stepId: "step", phase: "final_answer" });
    f.publisher.textDelta("answer", "Verified answer.");
    integrationValue(await f.publisher.terminal("complete"));
    const stream = f.store.findAgentStream(f.child.run.runId).unwrap()!;
    await new Promise<void>((resolve) => {
      const finished = () => {
        const reply = f.store.syncAgentStream("owner", f.thread.id, stream.id).unwrap();
        return (
          reply.kind === "window" &&
          reply.slots.some((slot) => slot.kind === "ready" && slot.state === "complete")
        );
      };
      if (finished()) return resolve();
      const stop = f.store.subscribe(() => {
        if (finished()) {
          stop();
          resolve();
        }
      });
      if (finished()) {
        stop();
        resolve();
      }
    });
    const replay: ReplayReply = await f.client.streams.sync({ target: f.target, checkpoint });
    expect(replay.kind).toBe("delta");
    store.replay(replay);
    expect(store.at(0)).toMatchObject({ state: "complete" });
    const serialized = JSON.stringify(store.at(0));
    expect(serialized).toContain("Checking the source");
    expect(serialized).toContain("cat report.md");
    expect(serialized).toContain("Source text");
    expect(serialized).toContain('"durationMs":12');
    expect(serialized).toContain('"phase":"final"');
    expect(
      await f.client.streams.sync({ target: f.target, checkpoint: store.checkpoint }),
    ).toMatchObject({ kind: "unchanged" });
    f.store.pruneReplay().unwrap();
    const restored = new NativeThreadStore();
    restored.replay(await f.client.streams.sync({ target: f.target }));
    expect(restored.at(0)).toMatchObject(JSON.parse(JSON.stringify(store.at(0))));
    expect(f.fatalErrors).toEqual([]);
  } finally {
    controller.abort();
    await events?.return?.();
    await f.close();
  }
}, 15000);

test("child streams revoke on rewind and deletion and reject unrelated threads", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let events: Awaited<ReturnType<typeof f.client.streams.watch>> | undefined;
  try {
    const other = await f.client.threads.create({ commandId: crypto.randomUUID(), title: "Other" });
    await expect(
      f.client.streams.sync({ target: { ...f.target, threadId: other.id } }),
    ).rejects.toThrow();
    events = await f.client.streams.watch({ target: f.target }, { signal: controller.signal });
    await events.next();
    const next = events.next();
    const childStream = f.store.findAgentStream(f.child.run.runId).unwrap()!;
    const thread = f.store.getThreadRecord(f.thread.id).unwrap();
    f.store
      .beginRewind("owner", {
        threadId: thread.id,
        turnId: f.receipt.turnId!,
        commandId: "rewind_child",
        historyGeneration: thread.historyGeneration,
        revision: thread.revision,
      })
      .unwrap();
    expect(await next).toMatchObject({ value: { kind: "revoked" } });
    f.store.finishMutation(thread.id, thread.historyGeneration + 1).unwrap();
    expect(f.store.findAgentStream(f.child.run.runId).unwrap()).toBeNull();
    const late = f.store.projectTurn(
      childStream.id,
      childStream.historyGeneration,
      "late_child_event",
      childStream.turnId,
      (slot) => Result.ok({ slot, changes: [] }),
    );
    expect(
      late.match({
        ok: () => null,
        err: (error) => (error._tag === "NativeStoreFailure" ? error.code : error._tag),
      }),
    ).toBe("stale");
    await expect(f.client.streams.sync({ target: f.target })).rejects.toThrow();
  } finally {
    controller.abort();
    await events?.return?.();
    await f.close();
  }
}, 15000);

test("workflow cancellation settles an observed child even before model output and nested children inherit root access", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let events: Awaited<ReturnType<typeof f.client.streams.watch>> | undefined;
  try {
    const nested = seedNativeSubagent(f.store, f.workflows, f.thread.id, {
      parentRequestId: f.child.requestId,
      parentSessionId: f.child.sessionId,
    });
    const nestedPublisher = f.runtime.createOutput({
      requestId: nested.requestId,
      sessionId: nested.sessionId,
      requestClient: "unknown",
      workflowRunId: nested.run.runId,
      prompt: "Nested work",
    });
    expect(nestedPublisher).toBeDefined();
    expect(
      await f.client.subagents.read({ threadId: f.thread.id, agentId: nested.run.runId }),
    ).toHaveProperty("agent");
    expect(
      await f.client.streams.sync({
        target: { kind: "subagent", threadId: f.thread.id, agentId: nested.run.runId },
      }),
    ).toMatchObject({ kind: "window" });
    events = await f.client.streams.watch({ target: f.target }, { signal: controller.signal });
    await events.next();
    const next = events.next();
    const changed = f.workflows.transitionRun({
      runId: f.child.run.runId,
      from: "running",
      to: "cancelled",
      now: Date.now(),
      detail: "Stopped",
    });
    expect(changed).toBe(true);
    integrationValue(
      await f.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
        runId: f.child.run.runId,
        revisionId: f.child.run.revisionId,
        state: "cancelled",
        ts: Date.now(),
      }),
    );
    expect(await next).toMatchObject({
      value: {
        kind: "replay",
        reply: { kind: "delta", changes: [{ kind: "turn-state", state: "canceled" }] },
      },
    });
  } finally {
    controller.abort();
    await events?.return?.();
    await f.close();
  }
}, 15000);

test("child attachments and HTML previews use the parent resource authority", async () => {
  const f = await fixture();
  let toolServer: ReturnType<typeof createToolServer> | undefined;
  try {
    const file = path.join(f.workspaceRoot, "child-report.txt");
    await writeFile(file, "Child attachment");
    await writeFile(
      path.join(f.workspaceRoot, "child-report.html"),
      "<!doctype html><html><body><h1>Child report</h1></body></html>",
    );
    const attachments = new Attachment({
      bus: f.bus,
      blobStore: f.blobs,
      nativeOutput: (context, input) => {
        expect(context.serverOwnedRequest).toBe(false);
        return f.runtime.attachmentOutput(context, input);
      },
      outputLifecycle: {
        registerOutputHandle: () => {
          throw new Error("Native child must publish through native resources");
        },
      },
    });
    const authority = new RequestControlAuthority();
    const origin = {
      platform: "native" as const,
      userId: "owner",
      sessionRef: { platform: "native" as const, channelId: f.thread.id },
    };
    const capability = authority.issue({
      kind: "primary",
      requestId: f.child.requestId,
      sessionId: f.child.sessionId,
      platform: "unknown",
      principal: { platform: "native", userId: "owner" },
      authenticatedOrigin: origin,
      allowedCallables: null,
      profile: "general",
      canonicalCwd: f.workspaceRoot,
      safetyMode: "trusted",
      expiresAt: Date.now() + 60000,
    });
    toolServer = createToolServer({
      tools: [attachments],
      canonicalWorkspaceRoot: f.workspaceRoot,
      requestMessageCache: {
        get: () => [{ role: "user", content: "Research" }],
        getOrigin: () => ({
          requestId: f.child.requestId,
          requestClient: "unknown",
          sessionId: f.child.sessionId,
          source: "internal-delegated",
          authenticatedOrigin: origin,
          authenticationMetadataKind: "origin",
          verifiedIngress: false,
        }),
      },
      authorizeControlRequest: (input) => authority.authorize(input),
    });
    await toolServer.init();
    const response = await toolServer.app.handle(
      new Request("http://localhost/call", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lilac-request-id": f.child.requestId,
          "x-lilac-session-id": f.child.sessionId,
          "x-lilac-request-client": "unknown",
          "x-lilac-cwd": f.workspaceRoot,
          "x-lilac-control-capability": capability,
        },
        body: JSON.stringify({ callableId: "attachment.add_files", input: { paths: [file] } }),
      }),
    );
    expect(await response.json()).toMatchObject({ status: "ok" });
    f.publisher.textStart({ partId: "preview", stepId: "step", phase: "final_answer" });
    f.publisher.textDelta(
      "preview",
      "Report ready.\n\n```html-preview-file\nchild-report.html\n```\n",
    );
    integrationValue(await f.publisher.terminal("complete"));
    const stream = f.store.findAgentStream(f.child.run.runId).unwrap()!;
    await new Promise<void>((resolve) => {
      const complete = () => {
        const reply = f.store.syncAgentStream("owner", f.thread.id, stream.id).unwrap();
        return (
          reply.kind === "window" &&
          reply.slots.some((slot) => slot.kind === "ready" && slot.state === "complete")
        );
      };
      if (complete()) return resolve();
      const stop = f.store.subscribe(() => {
        if (complete()) {
          stop();
          resolve();
        }
      });
      if (complete()) {
        stop();
        resolve();
      }
    });
    const reply = await f.client.streams.sync({ target: f.target });
    if (reply.kind !== "window") throw new Error("Missing child window");
    const slot = reply.slots.find((slot) => slot.kind === "ready");
    if (slot?.kind !== "ready") throw new Error("Missing child turn");
    const resource = slot.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "data-resource");
    if (resource?.type !== "data-resource") throw new Error("Missing child attachment");
    expect(await f.client.resources.get({ resourceId: resource.data.resourceId })).toMatchObject({
      state: "ready",
    });
    const message = slot.messages.find((message) =>
      message.parts.some((part) => part.type === "text" && part.text.includes("child-report.html")),
    );
    if (!message) throw new Error("Missing preview message");
    const preview = f.store
      .readHtmlPreview("owner", {
        threadId: f.thread.id,
        messageId: message.id,
        path: "child-report.html",
      })
      .unwrap();
    expect(preview.uploadId).toBeDefined();
    expect(f.fatalErrors).toEqual([]);
  } finally {
    await toolServer?.stop();
    await f.close();
  }
}, 15000);

test("rewinding a later parent turn preserves an earlier child's subscription", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let events: Awaited<ReturnType<typeof f.client.streams.watch>> | undefined;
  try {
    const later = await f.client.inputs.submit({
      threadId: f.thread.id,
      commandId: crypto.randomUUID(),
      mode: "prompt",
      historyGeneration: 0,
      text: "Later work",
      attachmentIds: [],
      skillIds: [],
    });
    await new Promise<void>((resolve) => {
      const finished = () => !!f.store.getInput(later.inputId).unwrap().completedAt;
      if (finished()) return resolve();
      const stop = f.store.subscribe(() => {
        if (finished()) {
          stop();
          resolve();
        }
      });
      if (finished()) {
        stop();
        resolve();
      }
    });
    events = await f.client.streams.watch({ target: f.target }, { signal: controller.signal });
    await events.next();
    const next = events.next();
    const parent = f.store.getThreadRecord(f.thread.id).unwrap();
    f.store
      .beginRewind("owner", {
        threadId: parent.id,
        turnId: later.turnId!,
        commandId: "rewind_later",
        historyGeneration: parent.historyGeneration,
        revision: parent.revision,
      })
      .unwrap();
    f.publisher.activity({
      activityId: "retained_child",
      stepId: "step",
      kind: "thinking",
      state: "complete",
      detail: "Still retained",
    });
    integrationValue(await f.publisher.captureBarrier());
    expect(await next).toMatchObject({ value: { kind: "replay", reply: { kind: "delta" } } });
    f.store.finishMutation(parent.id, parent.historyGeneration + 1).unwrap();
    expect(await f.client.streams.sync({ target: f.target })).toMatchObject({ kind: "window" });
  } finally {
    controller.abort();
    await events?.return?.();
    await f.close();
  }
}, 15000);
