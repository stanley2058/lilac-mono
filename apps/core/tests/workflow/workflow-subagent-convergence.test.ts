import { workflowStoreValue } from "./workflow-store-test-helpers";
import {
  createWorkflowTestBlobStore,
  workflowValueArtifactReferenceForTest,
} from "./workflow-test-blob-store";
import { afterEach, describe, expect, it, jest, spyOn } from "bun:test";
import { Result } from "better-result";
import { Logger } from "@stanley2058/simple-module-logger";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  createLilacBus,
  EventDeliveryStartFailed,
  lilacEventTypes,
  outReqTopic,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import {
  okResultForTest,
  startResultForTest,
  subscribeForTest,
  type TestRawMessageHandler,
  type TestRawSubscriptionHost,
} from "../helpers/result-raw-bus";
import type { TrustedSubagentDelegationRegistration } from "../../src/tools/subagent";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  applyWorkflowLiveParentDeliveryPolicy,
  WorkflowLiveParentBridge,
  WorkflowLiveParentChildActivityFailed,
  WorkflowLiveParentRunEventFailed,
} from "../../src/workflow/workflow-live-parent-bridge";
import { WorkflowSubagentDispatcher } from "../../src/workflow/workflow-subagent-dispatcher";
import { WorkflowEngine } from "../../src/workflow/workflow-engine";
import { readWorkflowSourceArtifact } from "../../src/workflow/workflow-artifact-store";
import { createToolResultArtifactStore } from "../../src/artifacts/tool-result-artifact-store";
const blobStore = await createWorkflowTestBlobStore();
const roots: string[] = [];
const AUTHENTICATED_PARENT = { platform: "discord", userId: "user-1" } as const;
function createInMemoryRawBus(control?: {
  beforePublish?: (input: { type: string; headers: PublishOptions["headers"] }) => Promise<void>;
}): RawBus &
  TestRawSubscriptionHost & {
    activeSubscriptions(): number;
  } {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subscriptions = new Set<{
    topic: string;
    handler: TestRawMessageHandler;
  }>();
  return {
    publish: async <TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) => {
      await control?.beforePublish?.({ type: options.type, headers: options.headers });
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
          await subscription.handler(stored, id);
        }
      }
      return { id, cursor: id };
    },
    subscribe: subscribeForTest,
    openTestSubscription: async (
      topic: string,
      _options: SubscriptionOptions,
      handler: TestRawMessageHandler,
    ) => {
      const entry = { topic, handler };
      subscriptions.add(entry);
      return {
        stop: async () => {
          subscriptions.delete(entry);
        },
      };
    },
    fetch: async (topic: string) => ({
      messages: (topics.get(topic) ?? []).map((message) => ({
        msg: message,
        cursor: message.id,
      })),
      next: topics.get(topic)?.at(-1)?.id,
    }),
    watermark: async (topic: string) => topics.get(topic)?.at(-1)?.id ?? null,
    activeSubscriptions: () => subscriptions.size,
    close: async () => {},
  };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(roots.splice(0, roots.length).map((root) => rm(root, { recursive: true })));
});
async function setup(maxActiveRuns?: number, now?: () => number) {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-subagent-workflow-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(root, "project");
  const dataDir = path.join(root, "data");
  const dbPath = path.join(root, "workflow.db");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  const store = new DurableWorkflowStore(dbPath);
  const dispatcher = await WorkflowSubagentDispatcher.create({
    store,
    blobStore,
    dataDir,
    pollMs: 1,
    now,
    getMaxActiveRuns: maxActiveRuns === undefined ? undefined : () => maxActiveRuns,
  });
  return { root, workspaceRoot, projectRoot, dataDir, dbPath, store, dispatcher };
}
it("times out an accepted subagent before agent dispatch", async () => {
  let now = 1000;
  const setupResult = await setup(undefined, () => now);
  const handle = await setupResult.dispatcher.delegate({
    ...registration(setupResult.projectRoot),
    mode: "sync",
    idleTimeoutMs: 1000,
  });
  now = 2001;
  await expect(handle.completion).resolves.toMatchObject({
    status: "timeout",
    detail: "Subagent idle timeout before agent dispatch",
  });
  expect(workflowStoreValue(setupResult.store.getRun(handle.runId))).toMatchObject({
    state: "cancelled",
    terminalDetail: "Subagent idle timeout before agent dispatch",
  });
});
function registration(
  projectRoot: string,
  parentRequestId = "parent:1",
): TrustedSubagentDelegationRegistration {
  return {
    mode: "deferred",
    profile: "explore",
    sessionName: "audit",
    stableNamedContinuation: true,
    task: "Audit the authentication flow",
    idleTimeoutMs: 2000,
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
    projectRoot,
    fallbackSurface: {
      ...AUTHENTICATED_PARENT,
      sessionId: "channel:1",
    },
  };
}
async function createRun(parentRequestId = "parent:1") {
  const setupResult = await setup();
  const handle = await setupResult.dispatcher.delegate(
    registration(setupResult.projectRoot, parentRequestId),
  );
  const run = workflowStoreValue(setupResult.store.getRun(handle.runId));
  if (!run) throw new Error("generated subagent run not found");
  return { ...setupResult, handle, run };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for workflow state");
    // test-wait-justification: polls for convergence work performed by independently scheduled workflow consumers
    await Bun.sleep(5);
  }
}
describe("workflow subagent convergence", () => {
  it.each(["listActiveLiveParentRuns", "listPendingLiveParentCompletions"] as const)(
    "does not retain a parent when %s fails during registration",
    async (operation) => {
      const { store } = await createRun("parent:read-failure");
      const raw = createInMemoryRawBus();
      const bus = createLilacBus(raw);
      const bridge = new WorkflowLiveParentBridge({
        bus,
        blobStore,
        store,
        subscriptionId: "parent-read-failure",
      });
      const failure = new Error("durable parent read unavailable");
      const intercepted = spyOn(store, operation).mockImplementationOnce(() => {
        throw failure;
      });
      try {
        expect(() => bridge.registerParent({ parentRequestId: "parent:read-failure" })).toThrow(
          failure,
        );
        intercepted.mockRestore();
        const retry = bridge.registerParent({ parentRequestId: "parent:read-failure" });
        await retry.ready;
        await retry.close();
        expect(raw.activeSubscriptions()).toBe(0);
      } finally {
        intercepted.mockRestore();
        await bridge.stop();
        await bus.close();
        store.close();
      }
    },
  );
  it("rolls back partial parent subscriptions when readiness fails", async () => {
    const { store, dispatcher, projectRoot } = await createRun("parent:registration-failure");
    await dispatcher.delegate({
      ...registration(projectRoot, "parent:registration-failure"),
      childRequestId: "sub:child:failed",
      childSessionId: "sub:channel:1:named:failed",
      parentToolCallId: "tool:failed",
    });
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const subscribe = bus.subscribeTopic.bind(bus);
    const subscriptionFailure = new EventDeliveryStartFailed({
      cause: null,
      topic: outReqTopic("sub:child:failed"),
      message: "child subscription unavailable",
    });
    const intercepted = spyOn(bus, "subscribeTopic").mockImplementation(async (...args) => {
      if (args[0] === outReqTopic("sub:child:failed")) return Result.err(subscriptionFailure);
      return await subscribe(...args);
    });
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "parent-registration-failure",
    });
    try {
      const parent = bridge.registerParent({ parentRequestId: "parent:registration-failure" });
      await expect(parent.ready).rejects.toBe(subscriptionFailure);
      expect(raw.activeSubscriptions()).toBe(0);
      await parent.close();
      intercepted.mockRestore();
      const retry = bridge.registerParent({ parentRequestId: "parent:registration-failure" });
      await retry.ready;
      expect(raw.activeSubscriptions()).toBe(2);
      await retry.close();
      expect(raw.activeSubscriptions()).toBe(0);
      const closedBeforeReady = bridge.registerParent({
        parentRequestId: "parent:registration-failure",
      });
      await closedBeforeReady.close();
      await closedBeforeReady.ready;
      expect(raw.activeSubscriptions()).toBe(0);
    } finally {
      intercepted.mockRestore();
      await bridge.stop();
      await bus.close();
      store.close();
    }
  });
  it("parks every owned live-parent delivery failure", () => {
    expect(
      applyWorkflowLiveParentDeliveryPolicy(
        new WorkflowLiveParentRunEventFailed({
          cause: undefined,
          runId: "run:1",
          message: "run event failed",
        }),
      ),
    ).toBe("park-pending");
    expect(
      applyWorkflowLiveParentDeliveryPolicy(
        new WorkflowLiveParentChildActivityFailed({
          cause: undefined,
          runId: "run:1",
          childRequestId: "child:1",
          message: "child activity failed",
        }),
      ),
    ).toBe("park-pending");
  });
  it("rejects delegation at global capacity without creating partial durable state", async () => {
    const { projectRoot, store, dispatcher } = await setup(1);
    const first = await dispatcher.delegate(registration(projectRoot, "parent:first"));
    await expect(dispatcher.delegate(registration(projectRoot, "parent:rejected"))).rejects.toThrow(
      "global workflow capacity is full (1/1 active runs)",
    );
    expect(workflowStoreValue(store.listRuns()).map((item) => item.runId)).toEqual([first.runId]);
    expect([...workflowStoreValue(store.listActiveLiveParentRuns("parent:rejected"))]).toEqual([]);
    expect(workflowStoreValue(store.listRevisions())).toHaveLength(1);
    store.close();
  });
  it("creates an immutable run under the project root when the tool workspace differs", async () => {
    const { workspaceRoot, projectRoot, store, handle, run } = await createRun();
    const revision = workflowStoreValue(store.getRevision(run.revisionId));
    expect(run.state).toBe("queued");
    expect(run.origin).toMatchObject({ client: "discord", userId: "user-1" });
    expect(run.completionTarget).toMatchObject({
      kind: "live_parent",
      parentRequestId: "parent:1",
      parentToolCallId: "tool:delegate",
      childSessionId: "sub:channel:1:named:audit",
      profile: "explore",
      sessionName: "audit",
    });
    expect(revision?.name).toBe("subagent-delegate");
    expect(revision?.canonicalWorkspaceRoot).toBe(projectRoot);
    expect(revision?.canonicalWorkspaceRoot).not.toBe(workspaceRoot);
    expect(revision?.resources.agents).toMatchObject({
      maxConcurrent: 1,
      maxTotal: 1,
    });
    expect(
      workflowStoreValue(store.listActiveLiveParentRuns("parent:1")).map((item) => item.runId),
    ).toEqual([handle.runId]);
    expect(store.getLiveParentDeliverySnapshot("parent:1")).toEqual({
      pendingCompletionCount: 0,
      outstandingRunCount: 1,
    });
    store.close();
  });
  it("persists stable named eligibility for every generated delegation", async () => {
    const { projectRoot, store, dispatcher } = await setup();
    const generated = await dispatcher.delegate(registration(projectRoot, "parent:generated"));
    expect(workflowStoreValue(store.getRun(generated.runId))?.completionTarget).toMatchObject({
      kind: "live_parent",
      childSessionId: "sub:channel:1:named:audit",
      stableNamedContinuation: true,
    });
    store.close();
  });
  it("persists completion materialization failures across store restarts", async () => {
    const { store, dbPath, run } = await createRun("parent:materialization-retry");
    expect(
      store.recordLiveParentCompletionMaterializationFailure({
        runId: run.runId,
        error: "temporary read failure",
        now: 20,
      }),
    ).toBe(1);
    store.close();
    const reopened = new DurableWorkflowStore(dbPath);
    expect(
      reopened.recordLiveParentCompletionMaterializationFailure({
        runId: run.runId,
        error: "temporary read failure",
        now: 21,
      }),
    ).toBe(2);
    expect(reopened.clearLiveParentCompletionMaterializationFailure(run.runId, 22)).toBe(true);
    expect(
      reopened.recordLiveParentCompletionMaterializationFailure({
        runId: run.runId,
        error: "temporary read failure",
        now: 23,
      }),
    ).toBe(1);
    reopened.close();
  });
  it("creates and caches generated definitions independently for multiple project roots", async () => {
    const { root, projectRoot, store, dispatcher } = await setup();
    const otherProjectRoot = path.join(root, "unrelated-project");
    await mkdir(otherProjectRoot);
    const direct = await dispatcher.delegate(registration(projectRoot, "parent:direct-root"));
    const nested = await dispatcher.delegate(registration(otherProjectRoot, "parent:nested-root"));
    const directRun = workflowStoreValue(store.getRun(direct.runId));
    const nestedRun = workflowStoreValue(store.getRun(nested.runId));
    const directRevision = directRun
      ? workflowStoreValue(store.getRevision(directRun.revisionId))
      : null;
    const nestedRevision = nestedRun
      ? workflowStoreValue(store.getRevision(nestedRun.revisionId))
      : null;
    expect(directRevision?.canonicalWorkspaceRoot).toBe(projectRoot);
    expect(nestedRevision?.canonicalWorkspaceRoot).toBe(otherProjectRoot);
    expect(nestedRevision?.canonicalProjectId).not.toBe(directRevision?.canonicalProjectId);
    store.close();
  });
  it("retains the authoritative Discord origin without a nested surface fallback", async () => {
    const { projectRoot, store, dispatcher } = await setup();
    const syntheticParentSessionId = "sub:channel:1:named:outer";
    const nested = registration(projectRoot, "wfr:nested-parent");
    const handle = await dispatcher.delegate({
      ...nested,
      parentSessionId: syntheticParentSessionId,
      parentRequestClient: "unknown",
      parentHeaders: {
        ...nested.parentHeaders,
        session_id: syntheticParentSessionId,
        request_client: "unknown",
      },
    });
    const run = workflowStoreValue(store.getRun(handle.runId));
    expect(run?.origin).toMatchObject({
      sessionId: "channel:1",
      client: "discord",
      userId: "user-1",
    });
    expect(run?.completionTarget).toMatchObject({
      kind: "live_parent",
      parentSessionId: syntheticParentSessionId,
      fallbackToSurface: false,
      fallbackProgressTarget: null,
    });
    store.close();
  });
  it("preserves a self profile in the generated workflow", async () => {
    const { projectRoot, store, dispatcher } = await setup();
    const handle = await dispatcher.delegate({
      ...registration(projectRoot),
      profile: "self",
      childHeaders: {
        ...registration(projectRoot).childHeaders,
        subagent_profile: "self",
      },
    });
    const run = workflowStoreValue(store.getRun(handle.runId));
    const revision = run ? workflowStoreValue(store.getRevision(run.revisionId)) : null;
    expect(run?.completionTarget).toMatchObject({ kind: "live_parent", profile: "self" });
    expect(revision?.resources.agents).toMatchObject({
      maxConcurrent: 1,
    });
    if (!revision) throw new Error("generated self revision missing");
    const generatedArtifact = await readWorkflowSourceArtifact({
      blobStore,
      reference: revision.snapshotArtifact,
      maxBytes: revision.limits.maxSourceBytes,
    });
    const generated = generatedArtifact.unwrap();
    expect(generated).toContain('profile: { type: "string", const: "self" }');
    expect(generated).not.toContain("delegation:");
    store.close();
  });
  it("transfers child tool-result wrappers before parent delivery", async () => {
    const setupResult = await setup();
    const artifacts = createToolResultArtifactStore(
      path.join(setupResult.dataDir, "tool-results"),
      blobStore,
    );
    await artifacts.init();
    const dispatcher = await WorkflowSubagentDispatcher.create({
      store: setupResult.store,
      blobStore,
      dataDir: setupResult.dataDir,
      toolResultArtifacts: artifacts,
      pollMs: 1,
    });
    const child = registration(setupResult.projectRoot);
    const artifact = await artifacts.create({
      sessionId: child.childSessionId,
      requestId: child.childRequestId,
      toolCallId: "child-tool-call",
      toolName: "grep",
      content: "complete child tool output",
      ttlMs: 60000,
      maxBytesPerSession: 1000000,
    });
    if (artifact.status === "error") throw artifact.error;
    const handle = await dispatcher.delegate(child);
    const run = workflowStoreValue(setupResult.store.getRun(handle.runId));
    if (!run) throw new Error("generated run missing");
    expect(
      setupResult.store.transitionRun({
        runId: run.runId,
        from: "queued",
        to: "running",
        now: 20,
      }),
    ).toBe(true);
    const wrapper = `head\n\n[tool result truncated: 10 characters omitted]\nComplete output: ${artifact.value.uri}\nUse read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse the returned nextStart unchanged while more content remains.\n\ntail`;
    expect(
      setupResult.store.transitionRun({
        runId: run.runId,
        from: "running",
        to: "succeeded",
        now: 21,
        result: wrapper,
      }),
    ).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({
      status: "resolved",
      finalText: "complete child tool output",
    });
    setupResult.store.close();
  });
  it("uses the same durable terminal run without deferred delivery for synchronous completion", async () => {
    const setupResult = await setup();
    const handle = await setupResult.dispatcher.delegate({
      ...registration(setupResult.projectRoot),
      mode: "sync",
    });
    const run = workflowStoreValue(setupResult.store.getRun(handle.runId));
    if (!run) throw new Error("generated subagent run not found");
    const { store } = setupResult;
    expect(
      workflowStoreValue(store.listActiveLiveParentRuns("parent:1")).map((item) => item.runId),
    ).toEqual([handle.runId]);
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
    expect([
      ...workflowStoreValue(store.listPendingLiveParentCompletions("parent:1", 100, true)),
    ]).toEqual([]);
    store.close();
  });
  it("aggregates distinct child tools without letting non-tool activity erase the tree", async () => {
    const { store } = await createRun("parent:tool-tree");
    const bus = createLilacBus(createInMemoryRawBus());
    const updates: Array<{
      toolCallId: string;
      display: string;
    }> = [];
    await startResultForTest(
      bus.subscribeTopic(
        outReqTopic("parent:tool-tree"),
        { mode: "tail", offset: { type: "begin" } },
        async (message) => {
          if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
            updates.push({ toolCallId: message.data.toolCallId, display: message.data.display });
          }
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "test-live-parent-tool-tree",
    });
    await bridge.start();
    let parentActivity = 0;
    const parent = bridge.registerParent({
      parentRequestId: "parent:tool-tree",
      onActivity: () => {
        parentActivity += 1;
      },
    });
    await parent.ready;
    const childHeaders = {
      request_id: "sub:child:1",
      session_id: "sub:channel:1:named:audit",
      request_client: "unknown" as const,
    };
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:grep", status: "start", display: "[grep] auth" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:read", status: "start", display: "[read] config" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:grep", status: "end", display: "[grep] auth", ok: true },
      { headers: childHeaders },
    );
    const expectedTree = [
      "subagent (explore; 1/2 done)",
      "|- > [read] config",
      "`- + [grep] delayed",
    ].join("\n");
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:grep", status: "update", display: "[grep] delayed" },
      { headers: childHeaders },
    );
    expect(updates.at(-1)).toEqual({ toolCallId: "tool:delegate", display: expectedTree });
    const updateCount = updates.length;
    const activityBefore = parentActivity;
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "checking middleware" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "thinking" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputActivity,
      { source: "model" },
      { headers: childHeaders },
    );
    expect(parentActivity).toBe(activityBefore + 3);
    expect(updates).toHaveLength(updateCount);
    expect(updates.at(-1)?.display).toBe(expectedTree);
    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("preserves first child activity and publishes only the latest queued trailing activity", async () => {
    const { store } = await createRun("parent:activity-coalescing");
    const firstParentPublishStarted = deferred<void>();
    const releaseFirstParentPublish = deferred<void>();
    let blockedFirstParentPublish = false;
    const bus = createLilacBus(
      createInMemoryRawBus({
        beforePublish: async ({ type, headers }) => {
          if (
            blockedFirstParentPublish ||
            type !== lilacEventTypes.EvtAgentOutputToolCall ||
            headers?.request_id !== "parent:activity-coalescing"
          ) {
            return;
          }
          blockedFirstParentPublish = true;
          firstParentPublishStarted.resolve();
          await releaseFirstParentPublish.promise;
        },
      }),
    );
    const updates: string[] = [];
    await startResultForTest(
      bus.subscribeTopic(
        outReqTopic("parent:activity-coalescing"),
        { mode: "tail", offset: { type: "begin" } },
        async (message) => {
          if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
            updates.push(message.data.display);
          }
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "test-live-parent-activity-coalescing",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:activity-coalescing" });
    await parent.ready;
    const childHeaders = {
      request_id: "sub:child:1",
      session_id: "sub:channel:1:named:audit",
      request_client: "unknown" as const,
    };
    const first = bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "first" },
      { headers: childHeaders },
    );
    await firstParentPublishStarted.promise;
    const second = bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "second" },
      { headers: childHeaders },
    );
    const latest = bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "latest" },
      { headers: childHeaders },
    );
    releaseFirstParentPublish.resolve();
    await Promise.all([first, second, latest]);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain("output: first");
    expect(updates[1]).toContain("output: latest");
    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("logs live-parent publication failures with run context and redaction", async () => {
    const { store, run } = await createRun("parent:publication-warning");
    const bus = createLilacBus(createInMemoryRawBus());
    const warning = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "test-live-parent-publication-warning",
    });
    await bridge.start();
    const parent = bridge.registerParent({
      parentRequestId: "parent:publication-warning",
      publishToolStatus: async () => {
        throw new Error("token=secret-live-parent-publication");
      },
    });
    try {
      await parent.ready;
      await bus.publish(
        lilacEventTypes.EvtAgentOutputDeltaText,
        { delta: "publishing activity" },
        {
          headers: {
            request_id: "sub:child:1",
            session_id: "sub:channel:1:named:audit",
            request_client: "unknown",
          },
        },
      );

      const logged = JSON.stringify(warning.mock.calls);
      expect(logged).toContain(run.runId);
      expect(logged).toContain("token=<redacted>");
      expect(logged).not.toContain("secret-live-parent-publication");
    } finally {
      await parent.close();
      await bridge.stop();
      await bus.close();
      store.close();
      warning.mockRestore();
    }
  });
  it("reconciles pending terminal child output when the parent registers", async () => {
    const { store, run } = await createRun("parent:terminal-tree");
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "done",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const childHeaders = {
      request_id: "sub:child:1",
      session_id: "sub:channel:1:named:audit",
      request_client: "unknown" as const,
    };
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:trailing", status: "start", display: "[read] trailing output" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "child:trailing",
        status: "end",
        display: "[read] trailing output",
        ok: true,
      },
      { headers: childHeaders },
    );
    const updates: Array<{
      toolCallId: string;
      display: string;
    }> = [];
    await startResultForTest(
      bus.subscribeTopic(
        outReqTopic("parent:terminal-tree"),
        { mode: "tail", offset: { type: "begin" } },
        async (message) => {
          if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
            updates.push({ toolCallId: message.data.toolCallId, display: message.data.display });
          }
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "test-live-parent-terminal-tree",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:terminal-tree" });
    await parent.ready;
    expect(updates).toEqual([
      {
        toolCallId: "tool:delegate",
        display: "subagent (explore; 1/1 done)\n`- + [read] trailing output",
      },
    ]);
    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("dispatches the generated agent operation through the workflow engine", async () => {
    const { store, handle, run, dataDir } = await createRun();
    const bus = createLilacBus(createInMemoryRawBus());
    let childSessionId: string | undefined;
    let childRequestId: string | undefined;
    let hasWorkflowIdentity = false;
    const progress: string[] = [];
    await startResultForTest(
      bus.subscribeTopic(
        outReqTopic("parent:1"),
        { mode: "tail", offset: { type: "begin" } },
        async (message) => {
          if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
            progress.push(message.data.display);
          }
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "generated-subagent-parent-bridge",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await parent.ready;
    await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "generated-agent" },
        async (message) => {
          if (
            message.type === lilacEventTypes.CmdRequestMessage &&
            message.data.queue === "prompt"
          ) {
            childSessionId = message.headers?.session_id;
            childRequestId = message.headers?.request_id;
            const workflow = z
              .object({
                workflow: z.strictObject({
                  runId: z.string(),
                  operationId: z.string(),
                  dispatchEpoch: z.string(),
                }),
              })
              .parse(message.data.raw).workflow;
            hasWorkflowIdentity = true;
            if (!childRequestId || !childSessionId) {
              throw new Error("generated workflow request authority is incomplete");
            }
            const authorized = store.authorizeWorkflowRequest({
              requestId: childRequestId,
              sessionId: childSessionId,
              platform: "unknown",
            });
            if (!authorized) throw new Error("generated workflow request was not authorized");
            expect(authorized.policy).toMatchObject({
              profile: "explore",
              model: null,
              reasoning: null,
            });
            expect(
              store.claimWorkflowRequest({
                requestId: childRequestId,
                dispatchEpoch: workflow.dispatchEpoch,
                ownerId: "generated-runner",
                now: Date.now(),
              }),
            ).toBe(true);
            expect(
              store.recordWorkflowRequestTerminal({
                requestId: childRequestId,
                runId: authorized.policy.runId,
                operationId: authorized.policy.operationId,
                dispatchEpoch: workflow.dispatchEpoch,
                ownerId: "generated-runner",
                state: "resolved",
                output: "engine result",
                now: Date.now(),
              }),
            ).toBe(true);
            await bus.publish(
              lilacEventTypes.EvtAgentOutputDeltaText,
              { delta: "checking authentication middleware" },
              { headers: message.headers },
            );
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
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const engine = new WorkflowEngine({
      bus,
      blobStore,
      store,
      dataDir,
      subscriptionId: "generated-subagent-engine",
      pollMs: 5,
    });
    await engine.start();
    await waitFor(() => workflowStoreValue(store.getRun(run.runId))?.state === "succeeded");
    await waitFor(() =>
      progress.some((display) => display.includes("checking authentication middleware")),
    );
    expect(childSessionId).toBe("sub:channel:1:named:audit");
    expect(hasWorkflowIdentity).toBe(true);
    expect(
      childRequestId
        ? workflowStoreValue(store.getWorkflowRequestTerminalReceipt(childRequestId))
        : null,
    ).toMatchObject({ state: "resolved", output: "engine result" });
    expect(progress.some((display) => display.includes("subagent (explore;"))).toBe(true);
    expect(progress.some((display) => display.includes("checking authentication middleware"))).toBe(
      true,
    );
    expect(parent.listPending().map((completion) => completion.runId)).toEqual([run.runId]);
    await expect(handle.completion).resolves.toEqual({
      status: "resolved",
      finalText: "engine result",
    });
    await engine.stop();
    await parent.acknowledge([run.runId]);
    expect(parent.listPending()).toEqual([]);
    await parent.close();
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
      blobStore,
      store,
      subscriptionId: "test-live-parent",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await parent.ready;
    expect(parent.snapshot()).toMatchObject({
      hasPendingCompletions: true,
      hasOutstandingRuns: false,
    });
    expect(store.getLiveParentDeliverySnapshot("parent:1")).toEqual({
      pendingCompletionCount: 1,
      outstandingRunCount: 0,
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
    expect(store.getLiveParentDeliverySnapshot("parent:1")).toEqual({
      pendingCompletionCount: 0,
      outstandingRunCount: 0,
    });
    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("keeps artifact-backed completion pending when artifact loading fails", async () => {
    const { store, run } = await createRun();
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      resultArtifact: workflowValueArtifactReferenceForTest("missing-artifact"),
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "missing-artifact-delivery",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await parent.ready;
    await expect(parent.listPendingAsync()).rejects.toThrow();
    expect(parent.snapshot().hasPendingCompletions).toBe(true);
    await parent.close();
    await bridge.enableOrphanHandling();
    expect(workflowStoreValue(store.getRun(run.runId))?.state).toBe("succeeded");
    expect(store.getLiveParentDeliveryState(run.runId)).toBe("orphaned");
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("materializes independent completions when one result artifact is unreadable", async () => {
    const setupResult = await setup();
    const first = await setupResult.dispatcher.delegate(
      registration(setupResult.projectRoot, "parent:partial-materialization"),
    );
    const second = await setupResult.dispatcher.delegate({
      ...registration(setupResult.projectRoot, "parent:partial-materialization"),
      childRequestId: "sub:child:materialized",
      childSessionId: "sub:channel:1:named:materialized",
      sessionName: "materialized",
      parentToolCallId: "tool:delegate:materialized",
    });
    const firstRun = workflowStoreValue(setupResult.store.getRun(first.runId));
    const secondRun = workflowStoreValue(setupResult.store.getRun(second.runId));
    if (!firstRun || !secondRun) throw new Error("generated subagent run not found");
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "queued",
      to: "running",
      now: 10,
    });
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      resultArtifact: workflowValueArtifactReferenceForTest("missing-partial-artifact"),
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "queued",
      to: "running",
      now: 11,
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "running",
      to: "succeeded",
      now: 21,
      result: "available result",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store: setupResult.store,
      subscriptionId: "partial-materialization",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:partial-materialization" });
    await parent.ready;
    const settled = await parent.listPendingSettledAsync();
    expect(settled).toHaveLength(2);
    expect(settled.find((item) => !item.loaded)?.loaded).toBe(false);
    expect(
      settled.find((item) => item.loaded && item.completion.runId === second.runId),
    ).toMatchObject({
      loaded: true,
      completion: { finalText: "available result" },
    });
    await parent.close();
    await bridge.stop();
    await bus.close();
    setupResult.store.close();
  });
  it("orders out-of-order child completions by durable terminal time", async () => {
    const setupResult = await setup();
    const first = await setupResult.dispatcher.delegate(
      registration(setupResult.projectRoot, "parent:ordered"),
    );
    const secondRegistration = {
      ...registration(setupResult.projectRoot, "parent:ordered"),
      childRequestId: "sub:child:2",
      childSessionId: "sub:channel:1:named:audit-2",
      sessionName: "audit-2",
      parentToolCallId: "tool:delegate:2",
    };
    const second = await setupResult.dispatcher.delegate(secondRegistration);
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
      blobStore,
      store: setupResult.store,
      subscriptionId: "test-live-parent-order",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:ordered" });
    await parent.ready;
    expect(parent.listPending().map((completion) => completion.runId)).toEqual([
      second.runId,
      first.runId,
    ]);
    await parent.close();
    await bridge.stop();
    await bus.close();
    setupResult.store.close();
  });
  it("cascades parent cancellation to active generated runs", async () => {
    const { store, run } = await createRun();
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "test-live-parent-cancel",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await parent.ready;
    await parent.cancelAll("parent request cancelled");
    expect(workflowStoreValue(store.getRun(run.runId))?.state).toBe("cancelled");
    expect(parent.snapshot()).toMatchObject({
      hasPendingCompletions: false,
      hasOutstandingRuns: false,
    });
    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("cancels an active orphan before the workflow engine can claim it", async () => {
    const { store, run, dataDir } = await createRun("parent:lost");
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "test-live-parent-active-orphan",
    });
    await bridge.enableOrphanHandling();
    expect(workflowStoreValue(store.getRun(run.runId))).toMatchObject({
      state: "cancelled",
      terminalDetail: "Orphaned subagent: parent request could not be restored",
    });
    expect(store.getLiveParentDeliveryState(run.runId)).toBe("orphaned");
    expect([...workflowStoreValue(store.listActiveLiveParentRuns("parent:lost"))]).toEqual([]);
    expect([
      ...workflowStoreValue(store.listPendingLiveParentCompletions("parent:lost", 1000, true)),
    ]).toEqual([]);
    const engine = new WorkflowEngine({
      bus,
      blobStore,
      store,
      dataDir,
      subscriptionId: "test-live-parent-active-orphan-engine",
    });
    await engine.start();
    const requests = await raw.fetch("cmd.request", {
      offset: { type: "begin" },
      limit: 100,
    });
    expect(
      requests.messages.some(
        ({ msg }) =>
          msg.type === lilacEventTypes.CmdRequestMessage &&
          z.object({ queue: z.string() }).parse(msg.data).queue === "prompt",
      ),
    ).toBe(false);
    await engine.stop();
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("releases each child activity subscription across many sequential children", async () => {
    const setupResult = await setup();
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store: setupResult.store,
      subscriptionId: "test-live-parent-sequential",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:sequential" });
    await parent.ready;
    expect(raw.activeSubscriptions()).toBe(1);
    for (let index = 0; index < 30; index += 1) {
      const childRequestId = `sub:sequential:${index}`;
      const handle = await setupResult.dispatcher.delegate({
        ...registration(setupResult.projectRoot, "parent:sequential"),
        childRequestId,
        childSessionId: `sub:session:${index}`,
      });
      const run = workflowStoreValue(setupResult.store.getRun(handle.runId));
      if (!run) throw new Error("sequential child run missing");
      expect(
        setupResult.store.tryClaimRun({
          runId: run.runId,
          claimerId: "sequential-engine",
          now: 100 + index,
        }),
      ).not.toBeNull();
      const operationId = `operation-${index}`;
      expect(
        setupResult.store.createOperation(
          {
            runId: run.runId,
            operationId,
            callSiteId: `site-${index}`,
            parentOperationId: null,
            phase: null,
            label: "sequential child",
            kind: "agent",
            input: {},
            inputSha256: "a".repeat(64),
            state: "running",
            attempt: 0,
            requestId: childRequestId,
            output: null,
            resultArtifact: null,
            error: null,
            usage: null,
            claimedBy: null,
            claimedAt: null,
            createdAt: 100 + index,
            startedAt: 100 + index,
            updatedAt: 100 + index,
            terminalAt: null,
          },
          "sequential-engine",
        ),
      ).toBe(true);
      await bus.publish(lilacEventTypes.EvtWorkflowOperationChanged, {
        runId: run.runId,
        revisionId: run.revisionId,
        operationId,
        kind: "agent",
        state: "running",
        ts: 100 + index,
      });
      expect(raw.activeSubscriptions()).toBe(2);
      expect(
        setupResult.store.transitionOperation({
          runOwnerId: "sequential-engine",
          runId: run.runId,
          operationId,
          from: "running",
          to: "succeeded",
          now: 190 + index,
          output: `result-${index}`,
        }),
      ).toBe(true);
      await bus.publish(lilacEventTypes.EvtWorkflowOperationChanged, {
        runId: run.runId,
        revisionId: run.revisionId,
        operationId,
        kind: "agent",
        state: "succeeded",
        previousState: "running",
        ts: 190 + index,
      });
      expect(raw.activeSubscriptions()).toBe(2);
      expect(
        setupResult.store.terminalizeRun({
          runId: run.runId,
          from: "running",
          to: "succeeded",
          ownerId: "sequential-engine",
          now: 200 + index,
          detail: "complete",
          result: `result-${index}`,
          resultArtifact: null,
        }),
      ).toBe(true);
      await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
        runId: run.runId,
        revisionId: run.revisionId,
        state: "succeeded",
        previousState: "running",
        ts: 200 + index,
      });
      expect(raw.activeSubscriptions()).toBe(1);
    }
    await parent.close();
    await bridge.stop();
    expect(raw.activeSubscriptions()).toBe(0);
    await bus.close();
    setupResult.store.close();
  }, 20000);
  it("suppresses an orphaned terminal completion instead of falling back to the surface", async () => {
    const { store, run } = await createRun();
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "orphaned result",
    });
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const userVisibleEvents: string[] = [];
    await startResultForTest(
      bus.subscribeTopic(
        "evt.workflow",
        { mode: "tail", offset: { type: "begin" } },
        async (message) => {
          if (message.type === lilacEventTypes.EvtWorkflowProgressRequested) {
            userVisibleEvents.push(message.data.runId);
          }
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      blobStore,
      store,
      subscriptionId: "test-live-parent-orphan",
    });
    await bridge.enableOrphanHandling();
    expect(workflowStoreValue(store.getRun(run.runId))?.state).toBe("succeeded");
    expect(workflowStoreValue(store.getRun(run.runId))?.progressTarget).toBeNull();
    expect(store.getLiveParentDeliveryState(run.runId)).toBe("orphaned");
    expect(workflowStoreValue(store.getSurfaceBinding(run.runId))).toBeNull();
    expect(userVisibleEvents).toEqual([]);
    await bridge.stop();
    await bus.close();
    store.close();
  });
  it("does not orphan a completion while a restored parent is reattaching", async () => {
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
      blobStore,
      store,
      subscriptionId: "test-live-parent-protected",
    });
    let parent: ReturnType<typeof bridge.registerParent> | undefined;
    jest.useFakeTimers();
    try {
      await bridge.enableOrphanHandling({
        protectedParentRequestIds: ["parent:restored"],
        protectionMs: 20,
      });
      expect(workflowStoreValue(store.getRun(run.runId))?.progressTarget).toBeNull();
      parent = bridge.registerParent({ parentRequestId: "parent:restored" });
      await parent.ready;
      jest.advanceTimersByTime(30);
      expect(workflowStoreValue(store.getRun(run.runId))?.progressTarget).toBeNull();
      expect(store.getLiveParentDeliveryState(run.runId)).toBe("pending");
      expect(parent.listPending()).toHaveLength(1);
    } finally {
      try {
        await parent?.close();
        await bridge.stop();
        await bus.close();
        store.close();
      } finally {
        jest.useRealTimers();
      }
    }
  });
});
