import { normalizeWorkflowResourcePolicy, workflowStoreValue } from "./workflow-store-test-helpers";
import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Panic } from "better-result";
import { z } from "zod";
import {
  createLilacBus,
  lilacEventTypes,
  outReqTopic,
  type DeliveryDisposition,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import {
  okResultForTest,
  startResultForTest,
  stopResultForTest,
  subscribeForTest,
  type TestRawMessageHandler,
  type TestRawSubscription,
} from "../helpers/result-raw-bus";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  createWorkflowTestBlobStore,
  workflowArtifactReferenceForTest,
} from "./workflow-test-blob-store";
import {
  applyWorkflowEventDeliveryPolicy,
  captureWorkflowIdleCancellationPublication,
  captureWorkflowTerminalReceiptAdoption,
  WorkflowEngine,
  WorkflowLifecycleDeliveryFailed,
  WorkflowOutputDeliveryFailed,
  WorkflowWakeDeliveryFailed,
  runWorkflowTimerTick,
  workflowAgentRequestId,
} from "../../src/workflow/workflow-engine";
import type { WorkflowRequestPolicy } from "../../src/workflow/workflow-request-authority";
import { canonicalJsonSha256, sha256 } from "../../src/workflow/workflow-definition";
import {
  WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
  type WorkflowCompletionTarget,
} from "../../src/workflow/workflow-domain";
import { WorkflowWaitResolver } from "../../src/workflow/workflow-wait-resolver";
import { workflowConsumerId } from "../../src/workflow/workflow-consumer-id";
import { readWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-store";
import {
  compileWorkflowSourceResult,
  parseWorkflowCallSiteManifestUnchecked,
} from "../../src/workflow/workflow-source-compiler";

function compileWorkflowSource(source: string, sourceSha256: string): string {
  const result = compileWorkflowSourceResult(source, sourceSha256);
  if (result.status === "error") throw result.error;
  return result.value;
}

function parseWorkflowCallSiteManifest(source: string) {
  const result = parseWorkflowCallSiteManifestUnchecked(source);
  if (result.status === "error") throw result.error;
  return result.value;
}
const HASH_A = "a".repeat(64);
const blobStore = await createWorkflowTestBlobStore();
class HandoffInterceptStore extends DurableWorkflowStore {
  beforeHandoff: (() => void) | null = null;
  override getWorkflowRequestDispatchHandoff(
    input: Parameters<DurableWorkflowStore["getWorkflowRequestDispatchHandoff"]>[0],
  ) {
    const intercept = this.beforeHandoff;
    this.beforeHandoff = null;
    intercept?.();
    return super.getWorkflowRequestDispatchHandoff(input);
  }
}
class HeartbeatTrackingWorkflowStore extends DurableWorkflowStore {
  readonly runClaimRefreshes: number[] = [];
  private queuedScanObserver: {
    resolve: () => void;
    error?: Error;
  } | null = null;
  observeNextQueuedScan(error?: Error): Promise<void> {
    return new Promise((resolve) => {
      this.queuedScanObserver = { resolve, ...(error ? { error } : {}) };
    });
  }
  override listRuns(options?: Parameters<DurableWorkflowStore["listRuns"]>[0]) {
    const runs = super.listRuns(options);
    if (options?.state === "queued" && this.queuedScanObserver) {
      const observer = this.queuedScanObserver;
      this.queuedScanObserver = null;
      queueMicrotask(observer.resolve);
      if (observer.error) throw observer.error;
    }
    return runs;
  }
  override refreshRunClaim(runId: string, claimerId: string, now: number): boolean {
    this.runClaimRefreshes.push(now);
    return super.refreshRunClaim(runId, claimerId, now);
  }
}
class CapturingRawBus implements RawBus {
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];
  readonly history: Message<unknown>[] = [];
  readonly subscriptionOptions: Array<{ topic: string; options: SubscriptionOptions }> = [];
  subscribe = subscribeForTest;
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
    this.messages.push(message);
    return { id: `${this.messages.length}-0`, cursor: `${this.messages.length}-0` };
  }
  async openTestSubscription(
    topic: string,
    options: SubscriptionOptions,
    _handler: TestRawMessageHandler,
  ) {
    this.subscriptionOptions.push({ topic, options });
    return { stop: async () => {} };
  }
  async fetch(topic: string, _options: FetchOptions) {
    return {
      messages: this.history
        .filter((message) => message.topic === topic)
        .map((msg) => ({ msg, cursor: msg.id })),
    };
  }
  async watermark(topic: string) {
    return this.history.filter((message) => message.topic === topic).at(-1)?.id ?? null;
  }
  async trimBeforeCheckpoint() {
    return 0;
  }
  async retireConsumerGroup() {
    return "absent" as const;
  }
  async close() {}
}
class LiveCapturingRawBus implements RawBus {
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];
  readonly subscriptionOptions: Array<{ topic: string; options: SubscriptionOptions }> = [];
  subscribe = subscribeForTest;
  private sequence = 0;
  private readonly subscriptions = new Set<{
    topic: string;
    handler: TestRawMessageHandler;
  }>();
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
    this.messages.push(message);
    const id = `${++this.sequence}-0`;
    const stored: Message<TData> = { ...message, id, ts: Date.now(), topic: options.topic };
    for (const subscription of this.subscriptions) {
      if (subscription.topic === options.topic) {
        await subscription.handler(stored, id);
      }
    }
    return { id, cursor: id };
  }
  async openTestSubscription(
    topic: string,
    options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    this.subscriptionOptions.push({ topic, options });
    const subscription = { topic, handler };
    this.subscriptions.add(subscription);
    return { stop: async () => void this.subscriptions.delete(subscription) };
  }
  async fetch(_topic: string, _options: FetchOptions) {
    return { messages: [] };
  }
  async trimBeforeCheckpoint() {
    return 0;
  }
  async retireConsumerGroup() {
    return "absent" as const;
  }
  async close() {
    this.subscriptions.clear();
  }
}
class FailingWorkflowRunPublishRawBus extends LiveCapturingRawBus {
  runPublishFailures = 0;
  readonly durableFailurePublishAttempted = Promise.withResolvers<void>();
  override async publish<TData>(
    message: Omit<Message<TData>, "id" | "ts">,
    options: PublishOptions,
  ) {
    if (message.type === lilacEventTypes.EvtWorkflowRunChanged) {
      this.runPublishFailures += 1;
      if (this.runPublishFailures === 2) this.durableFailurePublishAttempted.resolve();
      throw new Error("workflow run publication failed");
    }
    return await super.publish(message, options);
  }
}
class DeferredInterruptFailureRawBus extends LiveCapturingRawBus {
  readonly interruptStarted = Promise.withResolvers<void>();
  readonly releaseInterrupt = Promise.withResolvers<void>();
  requestSubscriptionStops = 0;
  interruptDispatchEpoch: string | undefined;
  override async publish<TData>(
    message: Omit<Message<TData>, "id" | "ts">,
    options: PublishOptions,
  ) {
    if (message.type === lilacEventTypes.CmdRequestMessage) {
      const data = message.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "queue" in data &&
        data.queue === "interrupt"
      ) {
        this.interruptDispatchEpoch = message.headers?.workflow_dispatch_epoch;
        this.interruptStarted.resolve();
        await this.releaseInterrupt.promise;
        throw new Error("interrupt publication unavailable");
      }
    }
    return await super.publish(message, options);
  }
  override async openTestSubscription(
    topic: string,
    options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    const subscription = await super.openTestSubscription(topic, options, handler);
    if (topic === "evt.workflow") return subscription;
    return {
      stop: async () => {
        this.requestSubscriptionStops += 1;
        return await subscription.stop();
      },
    };
  }
}
function createTrustedRun(
  store: DurableWorkflowStore,
  runId = "run-1",
  args: Record<string, boolean> = {},
  outputLimits: {
    operation: number;
    result: number;
  } = { operation: 10000, result: 10000 },
  completionTarget: WorkflowCompletionTarget = { kind: "detached" },
  editing = false,
  canonicalWorkspaceRoot = process.cwd(),
  mixedEditing = false,
  operationIdleTimeoutMs = 2000,
  originUserId: string | null = "user-1",
) {
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    properties: { timeout: { type: "boolean" } },
  };
  const resources = normalizeWorkflowResourcePolicy({
    agents: {
      maxConcurrent: mixedEditing ? 3 : editing ? 1 : 2,
      maxTotal: 4,
    },
    maxNestingDepth: 4,
    operationIdleTimeoutMs,
    waits: ["reply", "sleep"],
  });
  const limits = {
    maxSourceBytes: 100000,
    maxInputBytes: 10000,
    maxOperationOutputBytes: outputLimits.operation,
    maxResultBytes: outputLimits.result,
  };
  const revision = {
    revisionId: "revision-1",
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot,
    scope: "project" as const,
    normalizedPath: "audit.js",
    name: "audit",
    snapshotArtifact: workflowArtifactReferenceForTest(`workflow-source:${HASH_A}`),
    sourceSha256: HASH_A,
    inputSchemaSha256: canonicalJsonSha256(inputSchema),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "audit", description: "Audit" },
    inputSchema,
    resources,
    limits,
    runtimeVersion: "lilac-workflow-js-v4",
    createdAt: 1,
  };
  const invocation = store.createInvocation({
    revision,
    run: {
      runId,
      revisionId: revision.revisionId,
      state: "queued",
      inputSchemaSnapshot: revision.inputSchema,
      args,
      argsSha256: canonicalJsonSha256(args),
      origin: {
        requestId: "origin-1",
        sessionId: "channel-1",
        client: "discord",
        userId: originUserId,
        projectCwd: canonicalWorkspaceRoot,
      },
      completionTarget,
      progressTarget: null,
      terminalDetail: null,
      result: null,
      resultArtifact: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 1,
      startedAt: null,
      updatedAt: 1,
      terminalAt: null,
    },
  });
  return invocation;
}
const createApprovedRun = createTrustedRun;
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for workflow state");
    // test-wait-justification: polls workflow state produced by the engine's independently scheduled worker loop
    await Bun.sleep(10);
  }
}
function persistedAgentInput(prompt: string, editing = false, cwd = process.cwd()) {
  return {
    prompt,
    options: {
      profile: editing ? "general" : "explore",
      cwd,
    },
  };
}
function workflowSource(bindings: string, body: string): string {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  async run({ ${bindings} }) {
    ${body}
  },
});
`;
}
function compileTestWorkflow(source: string): string {
  return compileWorkflowSource(source, sha256(source));
}
function agentWorkflowSource(prompt = "inspect", options = '{ profile: "explore" }'): string {
  return workflowSource("agent", `return await agent(${JSON.stringify(prompt)}, ${options});`);
}
function firstOperationId(source: string): string {
  const callSite = parseWorkflowCallSiteManifest(compileTestWorkflow(source))[0];
  if (!callSite) throw new Error("Test workflow has no host call");
  return `wfop:${sha256(`root:${callSite.callSiteId}:0`).slice(0, 40)}`;
}
describe("WorkflowEngine", () => {
  it("creates boot-unique workflow consumer identities", () => {
    const first = workflowConsumerId("core:workflow");
    const second = workflowConsumerId("core:workflow");
    expect(first).toStartWith(`core:workflow:${process.pid}:`);
    expect(second).toStartWith(`core:workflow:${process.pid}:`);
    expect(first).not.toBe(second);
  });
  it("maps owned delivery failures to the required subscription dispositions", () => {
    const cases: readonly [
      WorkflowWakeDeliveryFailed | WorkflowOutputDeliveryFailed | WorkflowLifecycleDeliveryFailed,
      DeliveryDisposition,
    ][] = [
      [new WorkflowWakeDeliveryFailed({ message: "wake failed" }), "park-pending"],
      [new WorkflowOutputDeliveryFailed({ message: "output failed" }), "park-pending"],
      [new WorkflowLifecycleDeliveryFailed({ message: "lifecycle failed" }), "stop"],
    ];
    for (const [error, disposition] of cases) {
      expect(applyWorkflowEventDeliveryPolicy(error)).toBe(disposition);
    }
  });
  it("adapts wake subscription start failure to the engine host contract", async () => {
    const dbPath = join(tmpdir(), `workflow-start-failure-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    class StartFailingRawBus extends CapturingRawBus {
      override async openTestSubscription(
        _topic: string,
        _options: SubscriptionOptions,
        _handler: TestRawMessageHandler,
      ): Promise<TestRawSubscription> {
        throw new Error("workflow subscription unavailable");
      }
    }
    const bus = createLilacBus(new StartFailingRawBus());
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "start-failure",
    });
    try {
      await expect(engine.start()).rejects.toThrow("Test subscription start failed");
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves compiler Panic without terminalizing the claimed run", async () => {
    const dbPath = join(tmpdir(), `workflow-compiler-panic-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const panic = new Panic({ message: "workflow compiler defect" });
    createApprovedRun(store);
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "compiler-panic",
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: () => {
        throw panic;
      },
    });
    try {
      await expect(engine.start()).rejects.toBe(panic);
      expect(workflowStoreValue(store.getRun("run-1"))).toMatchObject({
        state: "running",
        terminalAt: null,
        terminalDetail: null,
      });
      expect(
        raw.messages.some(
          (message) =>
            message.type === lilacEventTypes.EvtWorkflowRunChanged &&
            typeof message.data === "object" &&
            message.data !== null &&
            "state" in message.data &&
            message.data.state === "failed",
        ),
      ).toBe(false);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("returns timer failures as values and preserves Panic", async () => {
    const failed = await runWorkflowTimerTick(async () => {
      throw new Error("timer operation failed");
    });
    expect(failed.status).toBe("error");
    if (failed.status === "error") {
      expect(failed.error.message).toContain("timer operation failed");
    }
    const panic = new Panic({ message: "timer panic" });
    await expect(
      runWorkflowTimerTick(async () => {
        throw panic;
      }),
    ).rejects.toBe(panic);
  });
  it("returns terminal receipt adoption failures as values and preserves Panic", async () => {
    const failed = await captureWorkflowTerminalReceiptAdoption(async () => {
      throw new Error("receipt artifact unavailable");
    });
    expect(failed.status).toBe("error");
    if (failed.status === "error") {
      expect(failed.error.message).toContain("receipt artifact unavailable");
    }
    const panic = new Panic({ message: "receipt adoption defect" });
    await expect(
      captureWorkflowTerminalReceiptAdoption(async () => {
        throw panic;
      }),
    ).rejects.toBe(panic);
  });
  it("returns idle cancellation publication failures as values and preserves Panic", async () => {
    class CancellationFailingRawBus extends CapturingRawBus {
      constructor(private readonly cause: unknown) {
        super();
      }
      override async publish<TData>(
        _message: Omit<Message<TData>, "id" | "ts">,
        _options: PublishOptions,
      ): Promise<{
        id: string;
        cursor: string;
      }> {
        throw this.cause;
      }
    }
    const failedBus = createLilacBus(
      new CancellationFailingRawBus(new Error("cancellation transport unavailable")),
    );
    const failed = await captureWorkflowIdleCancellationPublication(failedBus, {
      requestId: "request-1",
      sessionId: "session-1",
      dispatchEpoch: "epoch-1",
    });
    expect(failed.status).toBe("error");
    if (failed.status === "error") {
      expect(failed.error.message).toBe("Workflow idle cancellation publication failed");
    }
    const panic = new Panic({ message: "idle cancellation defect" });
    const panicBus = createLilacBus(new CancellationFailingRawBus(panic));
    await expect(
      captureWorkflowIdleCancellationPublication(panicBus, {
        requestId: "request-2",
        sessionId: "session-2",
        dispatchEpoch: "epoch-2",
      }),
    ).rejects.toBe(panic);
  });
  it("paces active run heartbeats independently of polling and event-triggered ticks", async () => {
    const dbPath = join(tmpdir(), `workflow-heartbeat-pacing-${crypto.randomUUID()}.sqlite`);
    const store = new HeartbeatTrackingWorkflowStore(dbPath);
    const bus = createLilacBus(new LiveCapturingRawBus());
    let now = 100;
    createApprovedRun(store);
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "heartbeat-pacing",
      now: () => now,
      pollMs: 1000000,
      runClaimHeartbeatMs: 20000,
      loadSnapshot: async () => agentWorkflowSource("hold the run open"),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ signal }) =>
        await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "stopped", usage: null }),
            { once: true },
          );
        }),
    });
    const triggerTick = async (): Promise<void> => {
      const scanned = store.observeNextQueuedScan();
      await startResultForTest(
        bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
          runId: "run-1",
          revisionId: "revision-1",
          reason: "operation_changed",
          ts: now,
        }),
      );
      await scanned;
    };
    try {
      await engine.start();
      expect(workflowStoreValue(store.getRun("run-1"))?.claimedAt).toBe(100);
      now = 20099;
      await triggerTick();
      await triggerTick();
      expect(store.runClaimRefreshes).toEqual([]);
      now = 20100;
      await triggerTick();
      await triggerTick();
      expect(store.runClaimRefreshes).toEqual([20100]);
      now = 40099;
      await triggerTick();
      expect(store.runClaimRefreshes).toEqual([20100]);
      now = 40100;
      await triggerTick();
      expect(store.runClaimRefreshes).toEqual([20100, 40100]);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("awaits a wake-triggered tick failure before acknowledging the event", async () => {
    const dbPath = join(tmpdir(), `workflow-wake-tick-failure-${crypto.randomUUID()}.sqlite`);
    const store = new HeartbeatTrackingWorkflowStore(dbPath);
    const bus = createLilacBus(new LiveCapturingRawBus());
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "wake-tick-failure",
      pollMs: 1000000,
    });
    try {
      await engine.start();
      const scan = store.observeNextQueuedScan(new Error("wake tick failed"));
      const published = await bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: "missing-run",
        revisionId: "missing-revision",
        reason: "operation_changed",
        ts: 1,
      });
      expect(published.status).toBe("error");
      if (published.status === "error") {
        expect(published.error).toMatchObject({
          _tag: "EventPublishTransportFailed",
          cause: expect.objectContaining({ message: "wake tick failed" }),
        });
      }
      await scan;
    } finally {
      await expect(engine.stop()).rejects.toThrow(
        "Workflow engine stop failed while cancelling active work",
      );
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("contains timer tick failures and continues polling", async () => {
    const dbPath = join(tmpdir(), `workflow-timer-tick-failure-${crypto.randomUUID()}.sqlite`);
    const store = new HeartbeatTrackingWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "timer-tick-failure",
      pollMs: 1,
    });
    try {
      await engine.start();
      await store.observeNextQueuedScan(new Error("timer tick failed"));
      await store.observeNextQueuedScan();
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("durably fails a run when its initial publication fails without leaking the run rejection", async () => {
    const dbPath = join(tmpdir(), `workflow-initial-publish-failure-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new FailingWorkflowRunPublishRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(store);
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "initial-publish-failure",
      pollMs: 1000000,
      loadSnapshot: async () => workflowSource("", 'return "unused";'),
      compileSource: compileTestWorkflow,
    });
    try {
      await engine.start();
      await raw.durableFailurePublishAttempted.promise;
      expect(workflowStoreValue(store.getRun("run-1"))?.terminalDetail).toBe(
        "Event publish failed",
      );
      expect(raw.runPublishFailures).toBe(2);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("allows concurrent shared profile-native writers", async () => {
    const dbPath = join(tmpdir(), `workflow-mixed-authority-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10000, result: 10000 },
      { kind: "detached" },
      true,
      process.cwd(),
      true,
    );
    let active = 0;
    let activeEditors = 0;
    let maxActive = 0;
    let maxEditors = 0;
    let releaseEditors: () => void = () => {};
    const editorsOverlapped = new Promise<void>((resolve) => {
      releaseEditors = resolve;
    });
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "mixed-operation-authority",
      pollMs: 5,
      loadSnapshot: async () =>
        workflowSource(
          "agent",
          `return await Promise.all([
            agent("edit-a", { profile: "general" }),
            agent("edit-b", { profile: "general" }),
            agent("read-a", { profile: "explore" }),
            agent("read-b", { profile: "explore" }),
          ]);`,
        ),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ policy }) => {
        active += 1;
        if (policy.profile !== "explore") activeEditors += 1;
        maxActive = Math.max(maxActive, active);
        maxEditors = Math.max(maxEditors, activeEditors);
        if (activeEditors === 2) releaseEditors();
        if (policy.profile !== "explore") {
          await Promise.race([
            editorsOverlapped,
            Bun.sleep(1000).then(() => {
              throw new Error("shared writers did not overlap");
            }),
          ]);
        } else {
          // test-wait-justification: keeps shared read operations active while writer overlap is measured
          await Bun.sleep(30);
        }
        if (policy.profile !== "explore") activeEditors -= 1;
        active -= 1;
        return { state: "resolved", output: policy.operationId, detail: null, usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "succeeded");
      expect(
        workflowStoreValue(store.listOperations("run-1")).filter(
          (operation) => operation.kind === "agent",
        ),
      ).toHaveLength(4);
      expect(maxActive).toBeGreaterThan(1);
      expect(maxEditors).toBe(2);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("uses the engine data directory while resolving cwd before dispatch", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "workflow-engine-data-dir-"));
    const workspace = join(root, "workspace");
    const requestedCwd = join(workspace, ".lilac-data", "work");
    const dataDir = join(root, "runtime-data");
    const dbPath = join(dataDir, "workflow.sqlite");
    await fs.mkdir(requestedCwd, { recursive: true });
    await fs.mkdir(dataDir);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10000, result: 10000 },
      { kind: "detached" },
      true,
      workspace,
    );
    const dispatchedCwds: string[] = [];
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir,
      subscriptionId: "actual-data-dir-cwd",
      pollMs: 5,
      loadSnapshot: async () =>
        workflowSource(
          "agent",
          `return await agent("work in nested cwd", { profile: "general", cwd: ${JSON.stringify(requestedCwd)} });`,
        ),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async (request) => {
        dispatchedCwds.push(request.agentCwd);
        return { state: "failed", output: "", detail: "test complete", usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "failed");
      expect(dispatchedCwds).toEqual([requestedCwd]);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("refreshes or clears only fallbacks while preserving the pinned head on stale redispatch", async () => {
    const scenarios = [
      {
        model: "changed-head-alias",
        currentFallbacks: [
          {
            alias: "current-fallback",
            spec: "provider/model-c",
            provider: "provider",
            modelId: "model-c",
            providerOptions: { provider: { route: "current" } },
            reasoning: "medium" as const,
            responseCommentary: true,
            anthropicPromptCache: true,
            reasoningDisplay: "none" as const,
          },
        ],
      },
      { model: "removed-head-alias", currentFallbacks: [] },
    ];
    for (const scenario of scenarios) {
      const dbPath = join(tmpdir(), `workflow-stale-policy-${crypto.randomUUID()}.sqlite`);
      const store = new DurableWorkflowStore(dbPath);
      const bus = createLilacBus(new CapturingRawBus());
      createApprovedRun(
        store,
        "run-1",
        {},
        { operation: 10000, result: 10000 },
        { kind: "detached" },
        true,
      );
      let now = 10;
      let firstDispatched = false;
      let staleFullValidations = 0;
      let staleFallbackResolutions = 0;
      const recoveredPolicies: WorkflowRequestPolicy[] = [];
      const source = workflowSource(
        "agent",
        `return await agent("durable request", { profile: "general", model: ${JSON.stringify(scenario.model)} });`,
      );
      const first = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `stale-policy-first-${scenario.model}`,
        pollMs: 5,
        now: () => now,
        loadSnapshot: async () => source,
        compileSource: compileTestWorkflow,
        validateAgentSelection: () => ({
          model: "provider/model-a",
          reasoning: "high",
          request: {
            alias: scenario.model,
            spec: "provider/model-a",
            provider: "provider",
            modelId: "model-a",
            reasoningDisplay: "detailed",
            providerOptions: { provider: { route: "pinned" } },
            reasoning: "high",
            responseCommentary: true,
            anthropicPromptCache: true,
            fallbacks: [
              {
                spec: "provider/model-old-fallback",
                provider: "provider",
                modelId: "model-old-fallback",
                reasoningDisplay: "detailed",
              },
            ],
          },
        }),
        dispatchAgentRequest: async (request) => {
          firstDispatched = true;
          return await new Promise((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => resolve({ state: "cancelled", output: "", detail: "paused", usage: null }),
              { once: true },
            );
          });
        },
      });
      const replacement = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `stale-policy-replacement-${scenario.model}`,
        pollMs: 5,
        now: () => now,
        loadSnapshot: async () => source,
        compileSource: compileTestWorkflow,
        validateAgentSelection: () => {
          staleFullValidations += 1;
          throw new Error("stale dispatch must not validate the pinned head");
        },
        resolveAgentFallbacks: () => {
          staleFallbackResolutions += 1;
          return scenario.currentFallbacks;
        },
        dispatchAgentRequest: async (request) => {
          recoveredPolicies.push(request.policy);
          return { state: "failed", output: "", detail: "test complete", usage: null };
        },
      });
      try {
        await first.start();
        await waitFor(() => firstDispatched);
        const pinnedRun = workflowStoreValue(store.getRun("run-1"));
        const pinnedOperation = workflowStoreValue(store.listOperations("run-1")).find(
          (operation) => operation.kind === "agent",
        );
        if (!pinnedRun || !pinnedOperation) throw new Error("initial workflow dispatch is missing");
        const pinnedRequestId = pinnedOperation.requestId;
        if (!pinnedRequestId) throw new Error("initial workflow request ID is missing");
        expect(store.pauseRunAndChildren({ runId: "run-1", now: 11, detail: "pause" })?.state).toBe(
          "paused",
        );
        await first.stop();
        now = 40100;
        expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now })).toBe(
          true,
        );
        await replacement.start();
        await waitFor(() => recoveredPolicies.length > 0);
        expect(staleFullValidations).toBe(0);
        expect(staleFallbackResolutions).toBe(1);
        expect(recoveredPolicies[0]?.resolvedModelRequest).toEqual({
          alias: scenario.model,
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          providerOptions: { provider: { route: "pinned" } },
          reasoning: "high",
          responseCommentary: true,
          anthropicPromptCache: true,
          reasoningDisplay: "detailed",
          fallbacks: scenario.currentFallbacks,
        });
        const recoveredRun = workflowStoreValue(store.getRun("run-1"));
        const recoveredOperation = workflowStoreValue(
          store.getOperation("run-1", pinnedOperation.operationId),
        );
        expect(recoveredRun?.revisionId).toBe(pinnedRun.revisionId);
        expect(recoveredRun?.argsSha256).toBe(pinnedRun.argsSha256);
        expect(recoveredOperation?.operationId).toBe(pinnedOperation.operationId);
        expect(recoveredOperation?.inputSha256).toBe(pinnedOperation.inputSha256);
        expect(recoveredOperation?.requestId).toBe(pinnedRequestId);
      } finally {
        await replacement.stop();
        await first.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    }
  });
  it("fails closed for every receiptless terminal request outcome", async () => {
    for (const terminalState of ["resolved", "failed", "cancelled"] as const) {
      const dbPath = join(
        tmpdir(),
        `workflow-engine-terminal-${terminalState}-${crypto.randomUUID()}.sqlite`,
      );
      const store = new DurableWorkflowStore(dbPath);
      const raw = new CapturingRawBus();
      const bus = createLilacBus(raw);
      createApprovedRun(store);
      const source = agentWorkflowSource();
      const operationId = firstOperationId(source);
      const requestId = workflowAgentRequestId("run-1", operationId, 0);
      const dispatchEpoch = `historical-epoch-${terminalState}`;
      const headers = {
        request_id: requestId,
        session_id: `workflow:run-1:${operationId}`,
        request_client: "unknown",
        workflow_dispatch_epoch: dispatchEpoch,
      };
      raw.history.push(
        {
          topic: outReqTopic(requestId),
          id: "1-0",
          ts: 10,
          type: lilacEventTypes.EvtAgentOutputResponseText,
          key: requestId,
          headers,
          data: { finalText: "historical result" },
        },
        {
          topic: "evt.request",
          id: "2-0",
          ts: 11,
          type: lilacEventTypes.EvtRequestLifecycleChanged,
          key: requestId,
          headers,
          data: { state: terminalState, ts: 11 },
        },
      );
      const engine = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `terminal-${terminalState}`,
        pollMs: 5,
        loadSnapshot: async () => source,
        compileSource: compileTestWorkflow,
        createDispatchEpoch: () => dispatchEpoch,
      });
      try {
        await engine.start();
        await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "paused");
        expect(workflowStoreValue(store.getRun("run-1"))?.terminalDetail).toBe(
          WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
        );
        expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
          state: "blocked",
          attempt: 0,
          requestId,
          error: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
        });
        expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now: 12 })).toBe(
          false,
        );
        expect(
          raw.messages.some(
            (message) =>
              message.type === lilacEventTypes.CmdRequestMessage &&
              message.headers?.request_id === requestId &&
              typeof message.data === "object" &&
              message.data !== null &&
              "queue" in message.data &&
              message.data.queue === "prompt",
          ),
        ).toBe(false);
      } finally {
        await engine.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    }
  });
  it("fails both reconciliation fetches on contract-invalid events without exposing payloads", async () => {
    for (const invalidTopic of ["output", "lifecycle"] as const) {
      const dbPath = join(
        tmpdir(),
        `workflow-engine-invalid-${invalidTopic}-fetch-${crypto.randomUUID()}.sqlite`,
      );
      const store = new DurableWorkflowStore(dbPath);
      class ContractInvalidFetchRawBus extends CapturingRawBus {
        readonly fetchedTopics: string[] = [];
        override async fetch(topic: string, options: FetchOptions) {
          this.fetchedTopics.push(topic);
          return await super.fetch(topic, options);
        }
      }
      const raw = new ContractInvalidFetchRawBus();
      const bus = createLilacBus(raw);
      createApprovedRun(store);
      const source = agentWorkflowSource();
      const operationId = firstOperationId(source);
      const requestId = workflowAgentRequestId("run-1", operationId, 0);
      const topic = invalidTopic === "output" ? outReqTopic(requestId) : "evt.request";
      raw.history.push({
        topic,
        id: `invalid-${invalidTopic}-1`,
        ts: 10,
        type:
          invalidTopic === "output"
            ? lilacEventTypes.EvtAgentOutputResponseText
            : lilacEventTypes.EvtRequestLifecycleChanged,
        key: requestId,
        headers: {
          request_id: requestId,
          session_id: `workflow:run-1:${operationId}`,
          request_client: "unknown",
          workflow_dispatch_epoch: "invalid-fetch-epoch",
        },
        data:
          invalidTopic === "output"
            ? { finalText: { secretUndecodedPayload: "must-not-escape" } }
            : { state: { secretUndecodedPayload: "must-not-escape" } },
      });
      const engine = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `invalid-${invalidTopic}-fetch`,
        pollMs: 5,
        loadSnapshot: async () => source,
        compileSource: compileTestWorkflow,
        createDispatchEpoch: () => "invalid-fetch-epoch",
      });
      try {
        await engine.start();
        await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "failed");
        expect(raw.fetchedTopics).toEqual(
          invalidTopic === "output" ? [outReqTopic(requestId)] : [outReqTopic(requestId), topic],
        );
        expect(workflowStoreValue(store.getRun("run-1"))?.terminalDetail).toContain(
          `Workflow reconciliation rejected an invalid ${topic} event`,
        );
        expect(workflowStoreValue(store.getRun("run-1"))?.terminalDetail).not.toContain(
          "secretUndecodedPayload",
        );
        expect(
          raw.messages.some(
            (message) =>
              message.type === lilacEventTypes.CmdRequestMessage &&
              typeof message.data === "object" &&
              message.data !== null &&
              "queue" in message.data &&
              message.data.queue === "prompt",
          ),
        ).toBe(false);
      } finally {
        await engine.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    }
  });
  it("fails closed for every terminal lifecycle state that mismatches its exact receipt", async () => {
    const cases = [
      { lifecycleState: "resolved", receiptState: "failed" },
      { lifecycleState: "failed", receiptState: "resolved" },
      { lifecycleState: "cancelled", receiptState: "failed" },
    ] as const;
    for (const { lifecycleState, receiptState } of cases) {
      const dbPath = join(
        tmpdir(),
        `workflow-engine-mismatched-${lifecycleState}-${crypto.randomUUID()}.sqlite`,
      );
      const store = new DurableWorkflowStore(dbPath);
      const raw = new LiveCapturingRawBus();
      const bus = createLilacBus(raw);
      createApprovedRun(store);
      const responder = await startResultForTest(
        bus.subscribeTopic(
          "cmd.request",
          { mode: "fanout", subscriptionId: `mismatch-${lifecycleState}` },
          async (message) => {
            if (
              message.type === lilacEventTypes.CmdRequestMessage &&
              message.data.queue === "prompt"
            ) {
              const requestId = message.headers?.request_id;
              const sessionId = message.headers?.session_id;
              if (!requestId || !sessionId) throw new Error("Missing workflow request identity");
              const workflow = z
                .object({
                  workflow: z.strictObject({
                    runId: z.string(),
                    operationId: z.string(),
                    dispatchEpoch: z.string(),
                  }),
                })
                .parse(message.data.raw).workflow;
              expect(
                store.authorizeWorkflowRequest({
                  requestId,
                  sessionId,
                  platform: "unknown",
                })?.policy,
              ).toMatchObject(workflow);
              expect(
                store.claimWorkflowRequest({
                  requestId,
                  dispatchEpoch: workflow.dispatchEpoch,
                  ownerId: "mismatch-runner",
                  now: 10,
                }),
              ).toBe(true);
              expect(
                store.recordWorkflowRequestTerminal({
                  requestId,
                  runId: workflow.runId,
                  operationId: workflow.operationId,
                  dispatchEpoch: workflow.dispatchEpoch,
                  ownerId: "mismatch-runner",
                  state: receiptState,
                  detail: `receipt ${receiptState}`,
                  ...(receiptState === "resolved" ? { output: "receipt output" } : {}),
                  now: 11,
                }),
              ).toBe(true);
              await bus.publish(
                lilacEventTypes.EvtRequestLifecycleChanged,
                { state: lifecycleState, ts: 12 },
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
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `mismatched-${lifecycleState}`,
        pollMs: 5,
        receiptPollMs: 10000,
        now: () => 10,
        loadSnapshot: async () => agentWorkflowSource(),
        compileSource: compileTestWorkflow,
      });
      try {
        await engine.start();
        await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "paused");
        expect(workflowStoreValue(store.getRun("run-1"))?.terminalDetail).toBe(
          WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
        );
        expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
          state: "blocked",
          attempt: 0,
          requestId: expect.stringMatching(/^wfr:/u),
          error: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
        });
        expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now: 13 })).toBe(
          false,
        );
      } finally {
        await engine.stop();
        await stopResultForTest(responder.stop());
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    }
  });
  it("does not auto-resume a blocked run marked for manual reconciliation", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-manual-block-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    expect(store.transitionRun({ runId: "run-1", from: "queued", to: "running", now: 3 })).toBe(
      true,
    );
    expect(
      store.transitionRun({
        runId: "run-1",
        from: "running",
        to: "blocked",
        now: 4,
        detail: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      }),
    ).toBe(true);
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "manual-block",
      pollMs: 5,
    });
    try {
      await engine.start();
      // test-wait-justification: crosses several engine poll intervals to prove manual blocks are not reclaimed
      await Bun.sleep(25);
      expect(workflowStoreValue(store.getRun("run-1"))).toMatchObject({
        state: "blocked",
        terminalDetail: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("does not publish when a durable terminal receipt wins after history scan", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-terminal-race-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(store);
    let receiptRecorded = false;
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "terminal-race",
      pollMs: 5,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      beforePromptPublication: async ({
        requestId,
        runId,
        operationId,
        dispatchEpoch,
        runOwnerId,
      }) => {
        expect(
          store.claimWorkflowRequestPromptPublication({
            requestId,
            runId,
            operationId,
            runOwnerId,
            now: 19,
          }),
        ).toBe(true);
        expect(
          store.claimWorkflowRequest({
            requestId,
            dispatchEpoch,
            ownerId: "runner-race",
            now: 19,
          }),
        ).toBe(true);
        receiptRecorded = store.recordWorkflowRequestTerminal({
          requestId,
          runId,
          operationId,
          dispatchEpoch,
          ownerId: "runner-race",
          state: "resolved",
          output: "receipt result",
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          now: 20,
        });
      },
    });
    try {
      await engine.start();
      await waitFor(
        () => receiptRecorded && workflowStoreValue(store.getRun("run-1"))?.state === "succeeded",
      );
      expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe("receipt result");
      expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
        state: "succeeded",
        output: "receipt result",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      });
      expect(
        raw.messages.some(
          (message) =>
            message.type === lilacEventTypes.CmdRequestMessage &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "prompt",
        ),
      ).toBe(false);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("fails as a value when prompt publication loses without a terminal receipt", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-missing-receipt-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(store);
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "missing-terminal-receipt",
      pollMs: 5,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      beforePromptPublication: async ({ requestId, runId, operationId, runOwnerId }) => {
        expect(
          store.claimWorkflowRequestPromptPublication({
            requestId,
            runId,
            operationId,
            runOwnerId,
            now: 19,
          }),
        ).toBe(true);
      },
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "failed");
      expect(workflowStoreValue(store.getRun("run-1"))?.terminalDetail).toBe(
        "Workflow prompt publication was rejected without a terminal receipt",
      );
      expect(
        raw.messages.some(
          (message) =>
            message.type === lilacEventTypes.CmdRequestMessage &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "prompt",
        ),
      ).toBe(false);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("adopts a post-publication receipt when the runner crashes before terminal streams", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-live-receipt-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10000, result: 10000 },
      {
        kind: "live_parent",
        parentRequestId: "parent-crash",
        parentSessionId: "parent-session",
        parentRequestClient: "discord",
        parentToolCallId: "parent-tool",
        childRequestId: "child-crash",
        childSessionId: "child-session",
        profile: "explore",
        sessionName: "crash-test",
        stableNamedContinuation: true,
        depth: 1,
        reasoning: null,
        fallbackToSurface: false,
        fallbackProgressTarget: null,
        deferredDelivery: true,
      },
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "live-terminal-receipt",
      pollMs: 5,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
    });
    try {
      await engine.start();
      await waitFor(() =>
        raw.messages.some((message) => message.type === lilacEventTypes.CmdRequestMessage),
      );
      const command = raw.messages.find(
        (message) => message.type === lilacEventTypes.CmdRequestMessage,
      );
      if (!command?.headers) throw new Error("Missing workflow prompt command");
      const commandData = z
        .object({
          raw: z.object({
            workflow: z.strictObject({
              runId: z.string(),
              operationId: z.string(),
              dispatchEpoch: z.string(),
            }),
          }),
        })
        .parse(command.data);
      const requestId = command.headers["request_id"];
      const sessionId = command.headers["session_id"];
      if (!requestId || !sessionId) throw new Error("Missing workflow command identity");
      const authorized = store.authorizeWorkflowRequest({
        requestId,
        sessionId,
        platform: "unknown",
      });
      if (!authorized) throw new Error("Workflow command was not authorized");
      expect(authorized.policy.stableNamedContinuation).toEqual({
        sessionId: "child-session",
        requestClient: "discord",
      });
      expect(
        store.claimWorkflowRequest({
          requestId,
          dispatchEpoch: commandData.raw.workflow.dispatchEpoch,
          ownerId: "crashing-runner",
          now: Date.now(),
        }),
      ).toBe(true);
      expect(
        store.recordWorkflowRequestTerminal({
          requestId,
          runId: authorized.policy.runId,
          operationId: authorized.policy.operationId,
          dispatchEpoch: commandData.raw.workflow.dispatchEpoch,
          ownerId: "crashing-runner",
          state: "resolved",
          output: "durable crash result",
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
          now: Date.now(),
        }),
      ).toBe(true);
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "succeeded");
      expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe("durable crash result");
      expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
        state: "succeeded",
        output: "durable crash result",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      });
      expect([
        ...workflowStoreValue(store.listPendingLiveParentCompletions("parent-crash", 100, true)),
      ]).toMatchObject([{ runId: "run-1", result: "durable crash result" }]);
      expect(store.markLiveParentCompletionDelivered("run-1", Date.now())).toBe(true);
      expect([
        ...workflowStoreValue(store.listPendingLiveParentCompletions("parent-crash", 100, true)),
      ]).toEqual([]);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("lets a replacement engine adopt a tombstoned receipt before redispatch", async () => {
    const dbPath = join(
      tmpdir(),
      `workflow-engine-replacement-receipt-${crypto.randomUUID()}.sqlite`,
    );
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10000, result: 10000 },
      {
        kind: "live_parent",
        parentRequestId: "parent-replacement",
        parentSessionId: "parent-session",
        parentRequestClient: "discord",
        parentToolCallId: "parent-tool",
        childRequestId: "child-replacement",
        childSessionId: "child-session",
        profile: "explore",
        sessionName: "replacement-test",
        depth: 1,
        reasoning: null,
        fallbackToSurface: false,
        fallbackProgressTarget: null,
        deferredDelivery: true,
      },
    );
    let firstNow = 10;
    let receiptCommitted = false;
    const first = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "replacement-receipt-first",
      pollMs: 5,
      now: () => firstNow,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async (request) => {
        const runOwnerId = workflowStoreValue(store.getRun(request.run.runId))?.claimedBy;
        if (!runOwnerId) throw new Error("Missing initial run owner");
        expect(
          store.claimWorkflowRequestPromptPublication({
            requestId: request.requestId,
            runId: request.run.runId,
            operationId: request.operation.operationId,
            runOwnerId,
            now: firstNow,
          }),
        ).toBe(true);
        expect(
          store.claimWorkflowRequest({
            requestId: request.requestId,
            dispatchEpoch: request.dispatchEpoch,
            ownerId: "runner-before-crash",
            now: firstNow,
          }),
        ).toBe(true);
        firstNow += 1;
        receiptCommitted = store.recordWorkflowRequestTerminal({
          requestId: request.requestId,
          runId: request.run.runId,
          operationId: request.operation.operationId,
          dispatchEpoch: request.dispatchEpoch,
          ownerId: "runner-before-crash",
          state: "resolved",
          output: "replacement receipt result",
          usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
          now: firstNow,
        });
        return await new Promise((resolve) => {
          request.signal.addEventListener(
            "abort",
            () =>
              resolve({ state: "cancelled", output: "", detail: "engine crashed", usage: null }),
            { once: true },
          );
        });
      },
    });
    let replacementDispatches = 0;
    const replacement = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "replacement-receipt-second",
      pollMs: 5,
      now: () => 100000,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async () => {
        replacementDispatches += 1;
        throw new Error("Replacement engine must adopt the receipt before dispatch");
      },
    });
    try {
      await first.start();
      await waitFor(() => receiptCommitted);
      await first.stop();
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("running");
      expect(workflowStoreValue(store.listOperations("run-1"))[0]?.state).toBe("dispatched");
      await replacement.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "succeeded");
      expect(replacementDispatches).toBe(0);
      expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe("replacement receipt result");
      expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
        state: "succeeded",
        output: "replacement receipt result",
        usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      });
      expect([
        ...workflowStoreValue(
          store.listPendingLiveParentCompletions("parent-replacement", 100, true),
        ),
      ]).toMatchObject([{ runId: "run-1", result: "replacement receipt result" }]);
    } finally {
      await first.stop();
      await replacement.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  for (const raceWindow of ["handoff", "authorization"] as const) {
    it(`adopts a receipt committed during the ${raceWindow} dispatch window`, async () => {
      const dbPath = join(
        tmpdir(),
        `workflow-engine-${raceWindow}-receipt-${crypto.randomUUID()}.sqlite`,
      );
      const store = new HandoffInterceptStore(dbPath);
      const bus = createLilacBus(new CapturingRawBus());
      createApprovedRun(
        store,
        "run-1",
        {},
        { operation: 10000, result: 10000 },
        { kind: "detached" },
      );
      let captured:
        | {
            requestId: string;
            runId: string;
            operationId: string;
            dispatchEpoch: string;
          }
        | undefined;
      const first = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `${raceWindow}-receipt-first`,
        pollMs: 5,
        now: () => 10,
        loadSnapshot: async () => agentWorkflowSource(),
        compileSource: compileTestWorkflow,
        dispatchAgentRequest: async (request) => {
          const runOwnerId = workflowStoreValue(store.getRun(request.run.runId))?.claimedBy;
          if (!runOwnerId) throw new Error("Missing initial run owner");
          expect(
            store.claimWorkflowRequestPromptPublication({
              requestId: request.requestId,
              runId: request.run.runId,
              operationId: request.operation.operationId,
              runOwnerId,
              now: 10,
            }),
          ).toBe(true);
          expect(
            store.claimWorkflowRequest({
              requestId: request.requestId,
              dispatchEpoch: request.dispatchEpoch,
              ownerId: "handoff-runner",
              now: 10,
            }),
          ).toBe(true);
          captured = {
            requestId: request.requestId,
            runId: request.run.runId,
            operationId: request.operation.operationId,
            dispatchEpoch: request.dispatchEpoch,
          };
          return await new Promise((resolve) => {
            request.signal.addEventListener(
              "abort",
              () => resolve({ state: "cancelled", output: "", detail: "stopped", usage: null }),
              { once: true },
            );
          });
        },
      });
      let replacementDispatches = 0;
      const commitReceipt = () => {
        if (!captured) throw new Error("Missing captured dispatch");
        expect(
          store.recordWorkflowRequestTerminal({
            ...captured,
            ownerId: "handoff-runner",
            state: "resolved",
            output: `${raceWindow} receipt result`,
            now: 70000,
          }),
        ).toBe(true);
      };
      const replacement = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `${raceWindow}-receipt-second`,
        pollMs: 5,
        now: () => 70000,
        loadSnapshot: async () => agentWorkflowSource(),
        compileSource: compileTestWorkflow,
        createDispatchEpoch:
          raceWindow === "authorization"
            ? () => {
                commitReceipt();
                return "replacement-dispatch-epoch";
              }
            : undefined,
        dispatchAgentRequest: async () => {
          replacementDispatches += 1;
          throw new Error("Replacement must adopt the raced receipt");
        },
      });
      try {
        await first.start();
        await waitFor(() => captured !== undefined);
        await first.stop();
        if (raceWindow === "handoff") store.beforeHandoff = commitReceipt;
        await replacement.start();
        await waitFor(() =>
          ["succeeded", "failed"].includes(workflowStoreValue(store.getRun("run-1"))?.state ?? ""),
        );
        expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("succeeded");
        expect(replacementDispatches).toBe(0);
        expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe(
          `${raceWindow} receipt result`,
        );
      } finally {
        await first.stop();
        await replacement.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    });
  }
  it("keeps the exact dispatch alive when its receipt commits immediately after pause", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-pause-receipt-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    let now = 10;
    let dispatches = 0;
    let captured:
      | {
          requestId: string;
          runId: string;
          operationId: string;
          dispatchEpoch: string;
        }
      | undefined;
    const capturedByRun = new Map<
      string,
      {
        requestId: string;
        runId: string;
        operationId: string;
        dispatchEpoch: string;
      }
    >();
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "pause-receipt",
      pollMs: 5,
      now: () => now,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async (request) => {
        dispatches += 1;
        const runOwnerId = workflowStoreValue(store.getRun(request.run.runId))?.claimedBy;
        if (!runOwnerId) throw new Error("Missing run owner");
        expect(
          store.claimWorkflowRequestPromptPublication({
            requestId: request.requestId,
            runId: request.run.runId,
            operationId: request.operation.operationId,
            runOwnerId,
            now,
          }),
        ).toBe(true);
        expect(
          store.claimWorkflowRequest({
            requestId: request.requestId,
            dispatchEpoch: request.dispatchEpoch,
            ownerId: "pause-runner",
            now,
          }),
        ).toBe(true);
        captured = {
          requestId: request.requestId,
          runId: request.run.runId,
          operationId: request.operation.operationId,
          dispatchEpoch: request.dispatchEpoch,
        };
        capturedByRun.set(request.run.runId, captured);
        return await new Promise((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "paused", usage: null }),
            { once: true },
          );
        });
      },
    });
    try {
      await engine.start();
      await waitFor(() => captured !== undefined);
      now += 1;
      expect(store.pauseRunAndChildren({ runId: "run-1", now, detail: "pause race" })?.state).toBe(
        "paused",
      );
      if (!captured) throw new Error("Missing captured pause dispatch");
      expect(
        store.recordWorkflowRequestTerminal({
          ...captured,
          ownerId: "pause-runner",
          state: "resolved",
          output: "receipt survived pause",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          now,
        }),
      ).toBe(true);
      await waitFor(
        () => workflowStoreValue(store.listOperations("run-1"))[0]?.state === "dispatched",
      );
      expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
        attempt: 0,
        requestId: captured.requestId,
      });
      now += 1;
      expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now })).toBe(true);
      await waitFor(() =>
        ["succeeded", "failed"].includes(workflowStoreValue(store.getRun("run-1"))?.state ?? ""),
      );
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("succeeded");
      expect(dispatches).toBe(1);
      expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe("receipt survived pause");
      expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
        state: "succeeded",
        output: "receipt survived pause",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
      createApprovedRun(store, "run-cancelled-receipt");
      await waitFor(() => capturedByRun.has("run-cancelled-receipt"));
      now += 1;
      expect(
        store.pauseRunAndChildren({
          runId: "run-cancelled-receipt",
          now,
          detail: "pause after side effect",
        })?.state,
      ).toBe("paused");
      const cancelledCapture = capturedByRun.get("run-cancelled-receipt");
      if (!cancelledCapture) throw new Error("Missing cancelled pause dispatch");
      expect(
        store.recordWorkflowRequestTerminal({
          ...cancelledCapture,
          ownerId: "pause-runner",
          state: "cancelled",
          detail: "interrupt raced completed side effect",
          now,
        }),
      ).toBe(true);
      now += 1;
      expect(
        store.transitionRun({
          runId: "run-cancelled-receipt",
          from: "paused",
          to: "queued",
          now,
        }),
      ).toBe(false);
      expect(workflowStoreValue(store.getRun("run-cancelled-receipt"))).toMatchObject({
        state: "paused",
        terminalDetail: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      expect(workflowStoreValue(store.listOperations("run-cancelled-receipt"))[0]).toMatchObject({
        state: "blocked",
        attempt: 0,
        requestId: cancelledCapture.requestId,
        error: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      // test-wait-justification: crosses several engine poll intervals to prove terminal receipts prevent redispatch
      await Bun.sleep(25);
      expect(dispatches).toBe(2);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("stops only the local sandbox after lease loss without interrupting successor requests", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-lease-loss-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    let now = 3;
    createApprovedRun(store);
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "lease-loss-local-only",
      pollMs: 5,
      now: () => now,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ signal }) =>
        await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "lease lost", usage: null }),
            { once: true },
          );
        }),
    });
    try {
      await engine.start();
      await waitFor(
        () =>
          workflowStoreValue(store.listOperations("run-1", { state: "dispatched" })).length === 1,
      );
      expect(
        store.tryClaimRun({
          runId: "run-1",
          claimerId: "successor",
          now: 100,
          staleAfterMs: 50,
        })?.claimedBy,
      ).toBe("successor");
      now = 101;
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.claimedBy === "successor");
      // test-wait-justification: crosses several engine poll intervals to detect an incorrect successor interrupt
      await Bun.sleep(25);
      expect(
        raw.messages.some(
          (message) =>
            message.type === lilacEventTypes.CmdRequestMessage &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "interrupt",
        ),
      ).toBe(false);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("journals deterministic operations and captures usage and output", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    let dispatches = 0;
    createApprovedRun(store);
    createApprovedRun(store, "run-2");
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "test-workflow-engine",
      pollMs: 5,
      loadSnapshot: async () =>
        workflowSource(
          "phase, agent",
          `return await phase("audit", async () => {
            const first = await agent("inspect", { profile: "explore", label: "Inspect" });
            return { first, cached: first };
          });`,
        ),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ requestId }) => {
        dispatches += 1;
        expect(requestId).toMatch(/^wfr:[a-f0-9]{20}:[a-f0-9]{20}:0$/u);
        return {
          state: "resolved",
          output: "agent output",
          detail: null,
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        };
      },
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "succeeded");
      await waitFor(() => workflowStoreValue(store.getRun("run-2"))?.state === "succeeded");
      expect(dispatches).toBe(2);
      expect(workflowStoreValue(store.getRun("run-1"))?.result).toEqual({
        first: "agent output",
        cached: "agent output",
      });
      const operations = workflowStoreValue(store.listOperations("run-1", { limit: 100 }));
      const secondOperations = workflowStoreValue(store.listOperations("run-2", { limit: 100 }));
      expect(operations.map((operation) => operation.kind)).toEqual(["phase", "agent"]);
      expect(operations[1]).toMatchObject({
        operationId: expect.stringMatching(/^wfop:/u),
        state: "succeeded",
        output: "agent output",
        usage: { totalTokens: 14 },
      });
      expect(secondOperations.map((operation) => operation.operationId)).toEqual(
        operations.map((operation) => operation.operationId),
      );
      expect(secondOperations[1]?.requestId).not.toBe(operations[1]?.requestId);
      expect(raw.messages.some((message) => message.type === "evt.workflow.usage.changed")).toBe(
        true,
      );
      expect(raw.messages.some((message) => message.type === "evt.workflow.result.ready")).toBe(
        true,
      );
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it.each([false, true])(
    "rechecks running leases after a fast restart, with live-owner refresh=%s",
    async (refreshOwner) => {
      const dbPath = join(tmpdir(), `workflow-fast-restart-${crypto.randomUUID()}.sqlite`);
      const store = new HeartbeatTrackingWorkflowStore(dbPath);
      const bus = createLilacBus(new LiveCapturingRawBus());
      createApprovedRun(store);
      store.tryClaimRun({ runId: "run-1", claimerId: "previous-owner", now: 100 });
      let now = 200;
      let dispatches = 0;
      const engine = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: "fast-restart",
        now: () => now,
        pollMs: 1000000,
        loadSnapshot: async () => agentWorkflowSource(),
        compileSource: compileTestWorkflow,
        dispatchAgentRequest: async () => {
          dispatches += 1;
          return { state: "resolved", output: "recovered", detail: null, usage: null };
        },
      });
      const tick = async () => {
        const scanned = store.observeNextQueuedScan();
        await startResultForTest(
          bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
            runId: "run-1",
            revisionId: "revision-1",
            reason: "operation_changed",
            ts: now,
          }),
        );
        await scanned;
      };
      try {
        await engine.start();
        expect(dispatches).toBe(0);
        now = 60099;
        await tick();
        expect(workflowStoreValue(store.getRun("run-1"))?.claimedBy).toBe("previous-owner");
        if (refreshOwner) {
          expect(store.refreshRunClaim("run-1", "previous-owner", now)).toBe(true);
          now = 60100;
          await tick();
          expect(dispatches).toBe(0);
          expect(workflowStoreValue(store.getRun("run-1"))?.claimedBy).toBe("previous-owner");
          now = 120099;
        } else {
          now = 60100;
        }
        await tick();
        await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "succeeded");
        await tick();
        expect(dispatches).toBe(1);
        expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe("recovered");
      } finally {
        await engine.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    },
  );
  it("recovers an older expired claim behind a full page of newer live owners", async () => {
    const dbPath = join(tmpdir(), `workflow-recovery-page-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    const expired = store.tryClaimRun({ runId: "run-1", claimerId: "dead-owner", now: 100 });
    if (!expired) throw new Error("expired fixture run was not claimed");
    const now = 60200;
    for (let index = 0; index < 1000; index += 1) {
      expect(
        store.createRun({
          ...expired,
          runId: `live-${index}`,
          claimedBy: "live-owner",
          claimedAt: now,
          createdAt: index + 2,
          updatedAt: now,
        }),
      ).toBe(true);
    }
    const firstPage = workflowStoreValue(store.listRuns({ state: "running", limit: 1000 }));
    expect(firstPage).toHaveLength(1000);
    expect(firstPage.some((run) => run.runId === expired.runId)).toBe(false);
    const dispatched: string[] = [];
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "expired-claim-page",
      now: () => now,
      pollMs: 1000000,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ run }) => {
        dispatched.push(run.runId);
        return { state: "resolved", output: "recovered", detail: null, usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun(expired.runId))?.state === "succeeded");
      expect(dispatched).toEqual([expired.runId]);
      expect(workflowStoreValue(store.getRun("live-0"))?.claimedBy).toBe("live-owner");
      expect(workflowStoreValue(store.getRun("live-999"))?.claimedBy).toBe("live-owner");
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reclaims a crashed running run and replays completed operations without dispatch", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-restart-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    const source = agentWorkflowSource();
    const claimed = store.tryClaimRun({ runId: "run-1", claimerId: "dead", now: 3 });
    expect(claimed?.state).toBe("running");
    store.createOperation(
      {
        runId: "run-1",
        operationId: firstOperationId(source),
        callSiteId: parseWorkflowCallSiteManifest(compileTestWorkflow(source))[0]!.callSiteId,
        parentOperationId: null,
        phase: null,
        label: null,
        kind: "agent",
        input: persistedAgentInput("inspect"),
        inputSha256: canonicalJsonSha256(persistedAgentInput("inspect")),
        state: "succeeded",
        attempt: 0,
        requestId: "wfr:completed",
        output: "cached",
        resultArtifact: null,
        error: null,
        usage: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 3,
        startedAt: 3,
        updatedAt: 3,
        terminalAt: 3,
      },
      "dead",
    );
    let dispatches = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "test-workflow-restart",
      pollMs: 5,
      loadSnapshot: async () => source,
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async () => {
        dispatches += 1;
        return { state: "resolved", output: "duplicate", detail: null, usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "succeeded");
      expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe("cached");
      expect(dispatches).toBe(0);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("fails operations that exceed configured output limits", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-limits-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    createApprovedRun(store, "run-failure");
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "test-workflow-limits",
      pollMs: 5,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ run }) =>
        run.runId === "run-failure"
          ? {
              state: "failed",
              output: "Error: provider failed",
              detail: "provider failed",
              usage: null,
            }
          : {
              state: "resolved",
              output: "x".repeat(10001),
              detail: null,
              usage: null,
            },
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "failed");
      await waitFor(() => workflowStoreValue(store.getRun("run-failure"))?.state === "failed");
      expect(workflowStoreValue(store.getRun("run-1"))?.terminalDetail).toContain(
        "output exceeds 10000 bytes",
      );
      expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
        state: "failed",
      });
      expect(workflowStoreValue(store.listOperations("run-failure"))[0]).toMatchObject({
        state: "failed",
        error: "provider failed",
        output: "Error: provider failed",
      });
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("persists large operation output and terminal results as bounded durable artifacts", async () => {
    const root = join(tmpdir(), `workflow-engine-artifacts-${crypto.randomUUID()}`);
    const dbPath = `${root}.sqlite`;
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    const largeOutput = "x".repeat(70000);
    await fs.mkdir(root);
    createApprovedRun(store, "run-artifact", {}, { operation: 100000, result: 100000 });
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: root,
      subscriptionId: "test-workflow-artifacts",
      pollMs: 5,
      loadSnapshot: async () => agentWorkflowSource("large"),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async () => ({
        state: "resolved",
        output: largeOutput,
        detail: null,
        usage: null,
      }),
    });
    try {
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-artifact"))?.state === "succeeded");
      const operation = workflowStoreValue(store.listOperations("run-artifact"))[0];
      const run = workflowStoreValue(store.getRun("run-artifact"));
      expect(operation).toMatchObject({
        output: null,
        resultArtifact: { artifactId: expect.any(String), blobRef: expect.any(Object) },
      });
      expect(run).toMatchObject({
        result: null,
        resultArtifact: { artifactId: expect.any(String), blobRef: expect.any(Object) },
      });
      await engine.stop();
      store.close();
      const reopened = new DurableWorkflowStore(dbPath);
      const persistedOperation = workflowStoreValue(reopened.listOperations("run-artifact"))[0]!;
      const persistedRun = workflowStoreValue(reopened.getRun("run-artifact"))!;
      const operationArtifact = await readWorkflowValueArtifact({
        blobStore,
        reference: persistedOperation.resultArtifact!,
        maxBytes: 100000,
      });
      expect(operationArtifact.status).toBe("ok");
      if (operationArtifact.status === "ok") expect(operationArtifact.value).toBe(largeOutput);
      const runArtifact = await readWorkflowValueArtifact({
        blobStore,
        reference: persistedRun.resultArtifact!,
        maxBytes: 100000,
      });
      expect(runArtifact.status).toBe("ok");
      if (runArtifact.status === "ok") expect(runArtifact.value).toBe(largeOutput);
      reopened.close();
    } finally {
      await engine.stop();
      await bus.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dbPath, { force: true });
    }
  });
  it("durably pauses, requeues active operations, resumes, and cascades cancellation", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-controls-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(store);
    let launches = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "test-workflow-controls",
      pollMs: 5,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ run, signal }) => {
        launches += 1;
        if (run.runId === "run-cancel") {
          return await new Promise((resolve) => {
            signal.addEventListener(
              "abort",
              () => resolve({ state: "cancelled", output: "", detail: "cancelled", usage: null }),
              { once: true },
            );
          });
        }
        if (launches > 1) {
          return { state: "resolved", output: "resumed", detail: null, usage: null };
        }
        return await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "paused", usage: null }),
            { once: true },
          );
        });
      },
    });
    try {
      await engine.start();
      await waitFor(
        () =>
          workflowStoreValue(store.listOperations("run-1", { state: "dispatched" })).length === 1,
      );
      expect(
        store.pauseRunAndChildren({ runId: "run-1", now: 10, detail: "test pause" })?.state,
      ).toBe("paused");
      await waitFor(
        () =>
          workflowStoreValue(store.listOperations("run-1", { state: "dispatched" })).length === 1,
      );
      expect(workflowStoreValue(store.listOperations("run-1"))[0]?.attempt).toBe(0);
      expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now: 11 })).toBe(
        true,
      );
      await waitFor(() => workflowStoreValue(store.getRun("run-1"))?.state === "succeeded");
      expect(workflowStoreValue(store.getRun("run-1"))?.result).toBe("resumed");
      expect(launches).toBe(2);
      createApprovedRun(store, "run-cancel");
      await waitFor(
        () =>
          workflowStoreValue(store.listOperations("run-cancel", { state: "dispatched" })).length ===
          1,
      );
      expect(
        store.cancelRunAndChildren({
          runId: "run-cancel",
          now: 12,
          detail: "test cancellation",
        })?.state,
      ).toBe("cancelled");
      await waitFor(
        () =>
          workflowStoreValue(store.listOperations("run-cancel", { state: "cancelled" })).length ===
          1,
      );
      await waitFor(() =>
        raw.messages.some(
          (message) =>
            message.type === "cmd.request.message" &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "interrupt",
        ),
      );
      expect(
        raw.messages.some(
          (message) =>
            message.type === "cmd.request.message" &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "interrupt",
        ),
      ).toBe(true);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("awaits abort cancellation publication failure before request subscription cleanup", async () => {
    const dbPath = join(
      tmpdir(),
      `workflow-engine-abort-publication-${crypto.randomUUID()}.sqlite`,
    );
    const store = new DurableWorkflowStore(dbPath);
    const raw = new DeferredInterruptFailureRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(store);
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "test-workflow-abort-publication",
      pollMs: 5,
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
    });
    try {
      await engine.start();
      await waitFor(() =>
        raw.messages.some(
          (message) =>
            message.type === lilacEventTypes.CmdRequestMessage &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "prompt",
        ),
      );
      const lifecycleSubscription = raw.subscriptionOptions.find(
        ({ topic, options }) => topic === "evt.request" && options.mode === "tail",
      );
      expect(lifecycleSubscription?.options).toEqual({
        mode: "tail",
        offset: { type: "begin" },
        batch: { maxWaitMs: 100 },
      });
      expect(
        store.cancelRunAndChildren({ runId: "run-1", now: 10, detail: "test cancellation" })?.state,
      ).toBe("cancelled");
      await raw.interruptStarted.promise;
      expect(raw.requestSubscriptionStops).toBe(0);
      expect(raw.interruptDispatchEpoch).toBeUndefined();

      raw.releaseInterrupt.resolve();
      await waitFor(() => raw.requestSubscriptionStops === 2);
      expect(workflowStoreValue(store.getRun("run-1"))).toMatchObject({ state: "cancelled" });
      expect(workflowStoreValue(store.listOperations("run-1"))[0]).toMatchObject({
        state: "cancelled",
      });
    } finally {
      raw.releaseInterrupt.resolve();
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("cancels the exact idle request and waits for its fenced terminal receipt", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-idle-receipt-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    class IdleReceiptBus extends LiveCapturingRawBus {
      cancelledRequestId: string | null = null;
      stateBeforeReceipt: string | null = null;
      interruptAttempts = 0;
      readonly receiptRecordingStarted = Promise.withResolvers<void>();
      readonly releaseReceiptRecording = Promise.withResolvers<void>();
      override async publish<TData>(
        message: Omit<Message<TData>, "id" | "ts">,
        options: PublishOptions,
      ) {
        if (message.type === lilacEventTypes.CmdRequestMessage) {
          const data = z
            .object({
              queue: z.string().optional(),
              raw: z
                .object({
                  cancel: z.boolean().optional(),
                  workflow: z
                    .strictObject({
                      runId: z.string(),
                      operationId: z.string(),
                      dispatchEpoch: z.string(),
                    })
                    .optional(),
                })
                .optional(),
            })
            .parse(message.data);
          const requestId = message.headers?.request_id;
          const sessionId = message.headers?.session_id;
          if (data.queue === "prompt" && requestId && sessionId && data.raw?.workflow) {
            const authorized = store.authorizeWorkflowRequest({
              requestId,
              sessionId,
              platform: "unknown",
            });
            if (!authorized) throw new Error("Idle workflow request was not authorized");
            const claimed = store.claimWorkflowRequest({
              requestId,
              dispatchEpoch: data.raw.workflow.dispatchEpoch,
              ownerId: "idle-test-runner",
              now: Date.now(),
            });
            if (!claimed) throw new Error("Idle workflow request was not claimed");
            await super.publish(
              {
                topic: "evt.request",
                type: lilacEventTypes.EvtRequestLifecycleChanged,
                key: requestId,
                data: { state: "running" },
                headers: {
                  request_id: requestId,
                  session_id: sessionId,
                  request_client: "unknown",
                  workflow_dispatch_epoch: data.raw.workflow.dispatchEpoch,
                },
              },
              { topic: "evt.request", type: lilacEventTypes.EvtRequestLifecycleChanged },
            );
          }
          if (data.queue === "interrupt" && data.raw?.cancel === true && requestId) {
            this.interruptAttempts += 1;
            if (this.interruptAttempts === 1) throw new Error("transient cancel publish failure");
            this.cancelledRequestId = requestId;
            this.stateBeforeReceipt =
              workflowStoreValue(store.getOperationByRequestId(requestId))?.state ?? null;
            this.receiptRecordingStarted.resolve();
            await this.releaseReceiptRecording.promise;
            const operation = workflowStoreValue(store.getOperationByRequestId(requestId));
            if (!operation) throw new Error("Missing idle operation");
            const dispatch = store.getWorkflowRequestDispatchHandoff({
              requestId,
              now: Date.now(),
              staleAfterMs: 60000,
            });
            if (dispatch.status !== "live") throw new Error("Missing live idle dispatch");
            const recorded = store.recordWorkflowRequestTerminal({
              requestId,
              runId: operation.runId,
              operationId: operation.operationId,
              dispatchEpoch: dispatch.dispatchEpoch,
              ownerId: "idle-test-runner",
              state: "cancelled",
              detail: "idle process tree quiesced",
              now: Date.now(),
            });
            if (!recorded) throw new Error("Failed to record idle receipt");
            await super.publish(
              {
                topic: "evt.request",
                type: lilacEventTypes.EvtRequestLifecycleChanged,
                key: requestId,
                data: { state: "cancelled", detail: "idle process tree quiesced" },
                headers: {
                  request_id: requestId,
                  session_id: message.headers?.session_id ?? "",
                  request_client: "unknown",
                  workflow_dispatch_epoch: dispatch.dispatchEpoch,
                },
              },
              { topic: "evt.request", type: lilacEventTypes.EvtRequestLifecycleChanged },
            );
          }
        }
        return await super.publish(message, options);
      }
    }
    const raw = new IdleReceiptBus();
    const bus = createLilacBus(raw);
    createApprovedRun(
      store,
      "run-idle-receipt",
      {},
      { operation: 10000, result: 10000 },
      { kind: "detached" },
      false,
      process.cwd(),
      false,
      1000,
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "idle-receipt",
      pollMs: 5,
      receiptPollMs: 5,
      loadSnapshot: async () => agentWorkflowSource("wait forever"),
      compileSource: compileTestWorkflow,
    });
    try {
      await engine.start();
      await raw.receiptRecordingStarted.promise;
      const runningOperation = workflowStoreValue(store.listOperations("run-idle-receipt"))[0];
      expect(raw.cancelledRequestId).toBe(runningOperation?.requestId ?? null);
      expect(raw.interruptAttempts).toBe(2);
      expect(raw.stateBeforeReceipt).toBe("running");
      expect(runningOperation?.state).toBe("running");
      raw.releaseReceiptRecording.resolve();
      await waitFor(() => workflowStoreValue(store.getRun("run-idle-receipt"))?.state === "failed");
      const operation = workflowStoreValue(store.listOperations("run-idle-receipt"))[0];
      expect(raw.cancelledRequestId).toBe(operation?.requestId ?? null);
      expect(raw.interruptAttempts).toBe(2);
      expect(raw.stateBeforeReceipt).toBe("running");
      expect(operation).toMatchObject({
        state: "timed_out",
        error: "Agent operation idle timeout",
      });
      expect(
        workflowStoreValue(store.getWorkflowRequestTerminalReceipt(raw.cancelledRequestId!)),
      ).toMatchObject({
        state: "cancelled",
        detail: "idle process tree quiesced",
      });
    } finally {
      raw.releaseReceiptRecording.resolve();
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("resolves sleep and reply-timeout host operations through the durable wait journal", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-waits-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 100;
    createApprovedRun(store, "run-sleep");
    createApprovedRun(store, "run-timeout", { timeout: true });
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "test-engine-waits",
      now: () => now,
      pollMs: 5,
    });
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "test-engine-waits",
      now: () => now,
      pollMs: 5,
      loadSnapshot: async () =>
        workflowSource(
          "args, waitForReply, sleep",
          `if (args.timeout === true) return await waitForReply({ timeoutMs: 10 });
          return await sleep(10);`,
        ),
      compileSource: compileTestWorkflow,
    });
    try {
      await resolver.start();
      await engine.start();
      await waitFor(
        () => workflowStoreValue(store.listOperations("run-sleep"))[0]?.state === "blocked",
      );
      await waitFor(
        () => workflowStoreValue(store.listOperations("run-timeout"))[0]?.state === "blocked",
      );
      now = 110;
      await resolver.reconcileTimers();
      const timeoutOperation = workflowStoreValue(store.listOperations("run-timeout"))[0];
      if (!timeoutOperation) throw new Error("Missing timeout operation");
      const barrier = store.prepareWaitExpiryBarrier({
        runId: "run-timeout",
        operationId: timeoutOperation.operationId,
        barrierId: "unused-existing-barrier",
        now,
        retryBefore: 0,
      });
      if (!barrier) throw new Error("Missing timeout barrier");
      store.markWaitExpiryBarrierProcessed(barrier.barrierId, "1-0", now);
      await resolver.reconcileTimers();
      await waitFor(() => workflowStoreValue(store.getRun("run-sleep"))?.state === "succeeded");
      await waitFor(() => workflowStoreValue(store.getRun("run-timeout"))?.state === "failed");
      expect(workflowStoreValue(store.listOperations("run-sleep"))[0]).toMatchObject({
        kind: "wait",
        state: "succeeded",
      });
      expect(workflowStoreValue(store.listOperations("run-timeout"))[0]).toMatchObject({
        kind: "wait",
        state: "timed_out",
      });
    } finally {
      await engine.stop();
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("replays a reply received while the engine is offline without duplicating the wait", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-reply-restart-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store, "run-reply");
    let now = 10;
    const makeEngine = () =>
      new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir: dirname(dbPath),
        subscriptionId: `test-reply-restart-${crypto.randomUUID()}`,
        pollMs: 5,
        now: () => now,
        loadSnapshot: async () =>
          workflowSource(
            "waitForReply",
            'return await waitForReply({ messageId: "anchor-1", timeoutMs: 1000 });',
          ),
        compileSource: compileTestWorkflow,
      });
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "test-reply-restart-resolver",
      now: () => 20,
      pollMs: 5,
    });
    let engine = makeEngine();
    try {
      await engine.start();
      await waitFor(
        () => workflowStoreValue(store.listOperations("run-reply"))[0]?.state === "blocked",
      );
      await engine.stop();
      expect(
        workflowStoreValue(
          store.getWait(
            "run-reply",
            workflowStoreValue(store.listOperations("run-reply"))[0]!.operationId,
          ),
        )?.state,
      ).toBe("pending");
      await resolver.start();
      await resolver.resolveAdapterEvent(
        {
          platform: "discord",
          channelId: "channel-1",
          messageId: "reply-1",
          userId: "user-1",
          text: "continue",
          ts: 20,
          raw: { discord: { replyToMessageId: "anchor-1" } },
        },
        "offline-cursor",
      );
      now = 60011;
      engine = makeEngine();
      await engine.start();
      await waitFor(() => workflowStoreValue(store.getRun("run-reply"))?.state === "succeeded");
      expect(workflowStoreValue(store.getRun("run-reply"))?.result).toMatchObject({
        text: "continue",
      });
      expect(workflowStoreValue(store.listOperations("run-reply"))).toHaveLength(1);
    } finally {
      await engine.stop();
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("rejects reply waits without an authenticated Discord origin user", async () => {
    const dbPath = join(
      tmpdir(),
      `workflow-engine-unauthenticated-reply-${crypto.randomUUID()}.sqlite`,
    );
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-unauthenticated-reply",
      {},
      { operation: 10000, result: 10000 },
      { kind: "detached" },
      false,
      process.cwd(),
      false,
      2000,
      null,
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir: dirname(dbPath),
      subscriptionId: "test-unauthenticated-reply",
      pollMs: 5,
      loadSnapshot: async () =>
        workflowSource("waitForReply", "return await waitForReply({ timeoutMs: 1000 });"),
      compileSource: compileTestWorkflow,
    });
    try {
      await engine.start();
      await waitFor(
        () => workflowStoreValue(store.getRun("run-unauthenticated-reply"))?.state === "failed",
      );
      expect(
        workflowStoreValue(store.getRun("run-unauthenticated-reply"))?.terminalDetail,
      ).toContain("authenticated originating Discord session and user");
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
