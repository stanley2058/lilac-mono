import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  lilacEventTypes,
  outReqTopic,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import type { SubagentDelegationRegistration } from "../../src/tools/subagent";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { WorkflowLiveParentBridge } from "../../src/workflow/workflow-live-parent-bridge";
import { WorkflowSubagentDispatcher } from "../../src/workflow/workflow-subagent-dispatcher";
import { WorkflowEngine } from "../../src/workflow/workflow-engine";

const roots: string[] = [];

function createInMemoryRawBus(): RawBus {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subscriptions = new Set<{
    topic: string;
    handler: (message: Message<unknown>, context: HandleContext) => Promise<void>;
  }>();
  return {
    publish: async <TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) => {
      const id = crypto.randomUUID();
      const stored: Message<unknown> = {
        topic: options.topic,
        id,
        type: options.type,
        ts: Date.now(),
        key: options.key,
        headers: options.headers,
        data: message.data,
      };
      const existing = topics.get(options.topic) ?? [];
      existing.push(stored);
      topics.set(options.topic, existing);
      for (const subscription of subscriptions) {
        if (subscription.topic === options.topic) {
          await subscription.handler(stored, { cursor: id, commit: async () => {} });
        }
      }
      return { id, cursor: id };
    },
    subscribe: async <TData>(
      topic: string,
      _options: SubscriptionOptions,
      handler: (message: Message<TData>, context: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        handler: (message: Message<unknown>, context: HandleContext) =>
          handler(message as Message<TData>, context),
      };
      subscriptions.add(entry);
      return {
        stop: async () => {
          subscriptions.delete(entry);
        },
      };
    },
    fetch: async <TData>(topic: string) => ({
      messages: (topics.get(topic) ?? []).map((message) => ({
        msg: message as Message<TData>,
        cursor: message.id,
      })),
    }),
    close: async () => {},
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0, roots.length).map((root) => rm(root, { recursive: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-subagent-workflow-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  const store = new DurableWorkflowStore(path.join(root, "workflow.db"));
  const dispatcher = await WorkflowSubagentDispatcher.create({
    store,
    workspaceRoot,
    dataDir,
    pollMs: 1,
  });
  return { root, workspaceRoot, dataDir, store, dispatcher };
}

function registration(parentRequestId = "parent:1"): SubagentDelegationRegistration {
  return {
    profile: "explore",
    sessionName: "audit",
    task: "Audit the authentication flow",
    idleTimeoutMs: 2_000,
    depth: 1,
    parentRequestId,
    parentSessionId: "channel:1",
    parentRequestClient: "discord",
    parentToolCallId: "tool:delegate",
    childRequestId: "sub:child:1",
    childSessionId: "sub:channel:1:named:audit",
    parentHeaders: {
      request_id: parentRequestId,
      session_id: "channel:1",
      request_client: "discord",
    },
    childHeaders: {
      request_id: "sub:child:1",
      session_id: "sub:channel:1:named:audit",
      request_client: "unknown",
      parent_request_id: parentRequestId,
      parent_tool_call_id: "tool:delegate",
      subagent_profile: "explore",
      subagent_depth: "1",
    },
    initialMessages: [{ role: "user", content: "Audit the authentication flow" }],
  };
}

async function createRun(parentRequestId = "parent:1") {
  const setupResult = await setup();
  const handle = await setupResult.dispatcher.delegate(registration(parentRequestId), {
    editing: false,
    externalTools: true,
  });
  const run = setupResult.store.getRun(handle.runId);
  if (!run) throw new Error("generated subagent run not found");
  return { ...setupResult, handle, run };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for workflow state");
    await Bun.sleep(5);
  }
}

describe("workflow subagent convergence", () => {
  it("creates an approved immutable one-agent workflow run", async () => {
    const { store, handle, run } = await createRun();
    const revision = store.getRevision(run.revisionId);
    const approval = run.approvalId ? store.getApproval(run.approvalId) : null;

    expect(run.state).toBe("queued");
    expect(run.completionTarget).toMatchObject({
      kind: "live_parent",
      parentRequestId: "parent:1",
      parentToolCallId: "tool:delegate",
      childSessionId: "sub:channel:1:named:audit",
      profile: "explore",
      sessionName: "audit",
    });
    expect(revision?.name).toBe("subagent-delegate");
    expect(revision?.capabilities.agents).toMatchObject({
      profiles: ["explore"],
      maxConcurrent: 1,
      maxTotal: 1,
    });
    expect(approval?.state).toBe("approved");
    expect(store.listActiveLiveParentRuns("parent:1").map((item) => item.runId)).toEqual([
      handle.runId,
    ]);
    store.close();
  });

  it("uses the same durable terminal run for synchronous completion", async () => {
    const { store, handle, run } = await createRun();
    expect(store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 })).toBe(
      true,
    );
    expect(
      store.transitionRun({
        runId: run.runId,
        from: "running",
        to: "succeeded",
        now: 20,
        result: "audit complete",
      }),
    ).toBe(true);

    await expect(handle.completion).resolves.toEqual({
      status: "resolved",
      finalText: "audit complete",
    });
    store.close();
  });

  it("dispatches the generated agent operation through the workflow engine", async () => {
    const { store, handle, run, dataDir } = await createRun();
    const bus = createLilacBus(createInMemoryRawBus());
    let childSessionId: string | undefined;
    let allowsNestedSubagents = false;
    const progress: string[] = [];
    await bus.subscribeTopic(
      outReqTopic("parent:1"),
      { mode: "tail", offset: { type: "begin" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
          progress.push(message.data.display);
        }
        await context.commit();
      },
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "generated-subagent-parent-bridge",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await bus.subscribeTopic(
      "cmd.request",
      { mode: "fanout", subscriptionId: "generated-agent", offset: { type: "now" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.CmdRequestMessage && message.data.queue === "prompt") {
          childSessionId = message.headers?.session_id;
          const workflow = Reflect.get(message.data.raw ?? {}, "workflow");
          allowsNestedSubagents =
            workflow !== null &&
            typeof workflow === "object" &&
            Reflect.get(workflow, "subagents") === true;
          await bus.publish(
            lilacEventTypes.EvtAgentOutputResponseText,
            { finalText: "engine result" },
            { headers: message.headers },
          );
          await bus.publish(
            lilacEventTypes.EvtRequestLifecycleChanged,
            { state: "resolved" },
            { headers: message.headers },
          );
        }
        await context.commit();
      },
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "generated-subagent-engine",
      pollMs: 5,
      assertSandbox: async () => {},
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call",
          id: 1,
          kind: "agent",
          callSiteId: "generated-agent",
          occurrence: 0,
          path: "root:generated-agent:0",
          parentPath: null,
          phase: null,
          depth: 1,
          input: {
            prompt: "Audit the authentication flow",
            options: { profile: "explore", model: "inherit", label: "subagent explore" },
          },
        }),
      }),
    });

    await engine.start();
    await waitFor(() => store.getRun(run.runId)?.state === "succeeded");
    expect(childSessionId).toBe("sub:channel:1:named:audit");
    expect(allowsNestedSubagents).toBe(true);
    expect(progress.some((display) => display.includes("subagent (explore;"))).toBe(true);
    expect(parent.listPending().map((completion) => completion.runId)).toEqual([run.runId]);
    await expect(handle.completion).resolves.toEqual({
      status: "resolved",
      finalText: "engine result",
    });

    await engine.stop();
    parent.acknowledge([run.runId]);
    parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("recovers and acknowledges pending completions in terminal order", async () => {
    const { store, run } = await createRun();
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "done",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });

    expect(parent.snapshot()).toMatchObject({
      hasPendingCompletions: true,
      hasOutstandingRuns: false,
    });
    const pending = parent.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      runId: run.runId,
      status: "resolved",
      finalText: "done",
    });
    parent.acknowledge([run.runId]);
    expect(parent.snapshot().hasPendingCompletions).toBe(false);

    parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("orders out-of-order child completions by durable terminal time", async () => {
    const setupResult = await setup();
    const first = await setupResult.dispatcher.delegate(registration("parent:ordered"), {
      editing: false,
      externalTools: true,
    });
    const secondRegistration = {
      ...registration("parent:ordered"),
      childRequestId: "sub:child:2",
      childSessionId: "sub:channel:1:named:audit-2",
      sessionName: "audit-2",
      parentToolCallId: "tool:delegate:2",
    };
    const second = await setupResult.dispatcher.delegate(secondRegistration, {
      editing: false,
      externalTools: true,
    });
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "queued",
      to: "running",
      now: 10,
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "queued",
      to: "running",
      now: 10,
    });
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "running",
      to: "succeeded",
      now: 30,
      result: "first",
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "second",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store: setupResult.store,
      subscriptionId: "test-live-parent-order",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:ordered" });

    expect(parent.listPending().map((completion) => completion.runId)).toEqual([
      second.runId,
      first.runId,
    ]);

    parent.close();
    await bridge.stop();
    await bus.close();
    setupResult.store.close();
  });

  it("cascades parent cancellation to active generated runs", async () => {
    const { store, run } = await createRun();
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-cancel",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await parent.cancelAll("parent request cancelled");

    expect(store.getRun(run.runId)?.state).toBe("cancelled");
    expect(parent.snapshot()).toMatchObject({
      hasPendingCompletions: false,
      hasOutstandingRuns: false,
    });

    parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("activates the persisted surface fallback when the parent is absent", async () => {
    const { store, run } = await createRun();
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "fallback result",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const projected: string[] = [];
    await bus.subscribeTopic(
      "evt.workflow",
      { mode: "tail", offset: { type: "begin" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtWorkflowProgressRequested) {
          projected.push(message.data.runId);
        }
        await context.commit();
      },
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-fallback",
    });
    await bridge.enableFallbacks();

    expect(store.getRun(run.runId)?.progressTarget).toEqual({
      platform: "discord",
      channelId: "channel:1",
      replyToMessageId: null,
    });
    expect(projected).toContain(run.runId);

    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("does not fall back while a restored parent is reattaching", async () => {
    const { store, run } = await createRun("parent:restored");
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "restored result",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-protected",
    });
    await bridge.enableFallbacks({
      protectedParentRequestIds: ["parent:restored"],
      protectionMs: 20,
    });
    expect(store.getRun(run.runId)?.progressTarget).toBeNull();

    const parent = bridge.registerParent({ parentRequestId: "parent:restored" });
    await Bun.sleep(30);
    expect(store.getRun(run.runId)?.progressTarget).toBeNull();
    expect(parent.listPending()).toHaveLength(1);

    parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });
});
