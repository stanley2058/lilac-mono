import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "../helpers/real-core-bus";
import { Result } from "better-result";
import { normalizeWorkflowResourcePolicy, workflowStoreValue } from "./workflow-store-test-helpers";
import { describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Panic } from "better-result";
import {
  subscribeForTest,
  testDeliveriesRemainOpenOnPolicyStop,
  testDeliveryActions,
  type TestRawMessageHandler,
} from "../helpers/result-raw-bus";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { canonicalJsonSha256, sha256 } from "../../src/workflow/workflow-definition";
import { type WorkflowWait } from "../../src/workflow/workflow-domain";
import { shouldSuppressRouterForWorkflowReply } from "../../src/workflow/workflow-router-suppression";
import { WorkflowWaitResolver } from "../../src/workflow/workflow-wait-resolver";
import { workflowArtifactReferenceForTest } from "./workflow-test-blob-store";
class IdleRawBus implements RawBus {
  readonly subscribe = subscribeForTest;
  readonly retiredGroups: Array<{
    topic: string;
    group: string;
    activated: boolean;
  }> = [];
  private sequence = 0;
  private readonly watermarks = new Map<string, string>();
  private readonly history: Message<unknown>[];
  private readonly subscriptions: Array<{
    topic: string;
    handler: TestRawMessageHandler;
  }> = [];
  constructor(history: readonly Message<unknown>[] = []) {
    this.history = [...history];
  }
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
    const id = `${++this.sequence}-0`;
    this.watermarks.set(message.topic, id);
    const stored: Message<unknown> = { ...message, id, ts: Date.now() };
    this.history.push(stored);
    for (const subscription of this.subscriptions) {
      if (subscription.topic !== message.topic) continue;
      await subscription.handler(stored, id);
    }
    return { id, cursor: id };
  }
  async openTestSubscription(
    topic: string,
    options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    const subscription = { topic, handler };
    this.subscriptions.push(subscription);
    const offset = options.mode === "tail" ? options.offset : undefined;
    if (offset?.type === "begin" || offset?.type === "cursor") {
      const topicHistory = this.history.filter((message) => message.topic === topic);
      const requestedCursor = offset.type === "cursor" ? offset.cursor : null;
      const start =
        requestedCursor !== null
          ? topicHistory.findIndex((message) => message.id === requestedCursor) + 1
          : 0;
      for (const message of topicHistory.slice(Math.max(0, start))) {
        await subscription.handler(message, message.id);
      }
    }
    return {
      stop: async () => {
        const index = this.subscriptions.indexOf(subscription);
        if (index >= 0) this.subscriptions.splice(index, 1);
      },
    };
  }
  async fetch(topic: string, _options: FetchOptions) {
    return {
      messages: this.history
        .filter((message) => message.topic === topic)
        .map((message) => ({ msg: message, cursor: message.id })),
    };
  }
  async watermark(topic: string) {
    return this.watermarks.get(topic) ?? null;
  }
  setWatermark(topic: string, cursor: string): void {
    this.watermarks.set(topic, cursor);
  }
  async retireConsumerGroup(topic: string, group: string) {
    this.retiredGroups.push({
      topic,
      group,
      activated: this.subscriptions.some((subscription) => subscription.topic === topic),
    });
    return "absent" as const;
  }
  async close() {}
}
class HistoricalReplyRawBus extends IdleRawBus {
  constructor(historical: Message<unknown>) {
    super([historical]);
  }
}
class FailingFirstWakeupRawBus extends IdleRawBus {
  wakeupFailures = 0;
  override async publish<TData>(
    message: Omit<Message<TData>, "id" | "ts">,
    options: PublishOptions,
  ) {
    if (
      message.type === lilacEventTypes.EvtWorkflowProgressRequested &&
      this.wakeupFailures === 0
    ) {
      this.wakeupFailures += 1;
      throw new Error("simulated advisory wakeup failure");
    }
    return await super.publish(message, options);
  }
}
class ConfigurablePublicationFailureRawBus extends IdleRawBus {
  barrierFailure: Error | null = null;
  wakeupFailure: Error | null = null;
  override async publish<TData>(
    message: Omit<Message<TData>, "id" | "ts">,
    options: PublishOptions,
  ) {
    if (message.type === lilacEventTypes.EvtWorkflowWaitResolverBarrier && this.barrierFailure) {
      throw this.barrierFailure;
    }
    if (message.type === lilacEventTypes.EvtWorkflowProgressRequested && this.wakeupFailure) {
      throw this.wakeupFailure;
    }
    return await super.publish(message, options);
  }
}
class RetirementFailingRawBus extends IdleRawBus {
  subscriptionStops = 0;
  retirementFailure: Error | null = null;
  subscriptionStopFailure: Error | null = null;
  override async openTestSubscription(
    topic: string,
    options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    const subscription = await super.openTestSubscription(topic, options, handler);
    return {
      stop: async () => {
        this.subscriptionStops += 1;
        if (this.subscriptionStopFailure) throw this.subscriptionStopFailure;
        await subscription.stop();
      },
    };
  }
  override async retireConsumerGroup(topic: string, group: string) {
    if (this.retirementFailure) throw this.retirementFailure;
    return await super.retireConsumerGroup(topic, group);
  }
}
class HeartbeatTrackingWaitStore extends DurableWorkflowStore {
  readonly resolverLeaseRefreshes: number[] = [];
  override refreshWorkflowWaitResolverLease(ownerId: string, now: number): boolean {
    this.resolverLeaseRefreshes.push(now);
    return super.refreshWorkflowWaitResolverLease(ownerId, now);
  }
}
class LeaseTrackingWaitStore extends DurableWorkflowStore {
  resolverLeaseReleases = 0;
  private nextLeaseClaimObserver: (() => void) | null = null;
  observeNextLeaseClaim(): Promise<void> {
    return new Promise((resolve) => {
      this.nextLeaseClaimObserver = resolve;
    });
  }
  override claimWorkflowWaitResolverLease(
    input: Parameters<DurableWorkflowStore["claimWorkflowWaitResolverLease"]>[0],
  ): boolean {
    const claimed = super.claimWorkflowWaitResolverLease(input);
    const observer = this.nextLeaseClaimObserver;
    this.nextLeaseClaimObserver = null;
    observer?.();
    return claimed;
  }
  override releaseWorkflowWaitResolverLease(ownerId: string): void {
    this.resolverLeaseReleases += 1;
    super.releaseWorkflowWaitResolverLease(ownerId);
  }
}
class CheckpointRejectingWaitStore extends DurableWorkflowStore {
  checkpointAttempts = 0;
  override advanceWorkflowWaitResolverCheckpoint(): boolean {
    this.checkpointAttempts += 1;
    return false;
  }
}
class CompletingRawBus extends IdleRawBus {
  subscriptionCount = 0;
  subscriptionAttempts = 0;
  private failingSubscriptions = 0;
  private readonly completions: Array<{
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private nextSubscriptionObserver: (() => void) | null = null;
  observeNextSubscription(): Promise<void> {
    return new Promise((resolve) => {
      this.nextSubscriptionObserver = resolve;
    });
  }
  failNextSubscriptions(count: number): void {
    this.failingSubscriptions = count;
  }
  terminate(index: number, error?: unknown): void {
    const completion = this.completions[index];
    if (!completion) throw new Error(`Missing subscription completion ${index}`);
    if (error === undefined) completion.resolve();
    else completion.reject(error);
  }
  override async openTestSubscription(
    topic: string,
    options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    this.subscriptionAttempts += 1;
    if (this.failingSubscriptions > 0) {
      this.failingSubscriptions -= 1;
      throw new Error("simulated subscription startup failure");
    }
    const subscription = await super.openTestSubscription(topic, options, handler);
    const completion = Promise.withResolvers<void>();
    this.completions.push(completion);
    this.subscriptionCount += 1;
    const observer = this.nextSubscriptionObserver;
    this.nextSubscriptionObserver = null;
    observer?.();
    return {
      done: completion.promise,
      stop: async () => {
        completion.resolve();
        await subscription.stop();
      },
    };
  }
}
function createRunAndWait(
  store: DurableWorkflowStore,
  input: {
    runId: string;
    operationId: string;
    wait: Omit<WorkflowWait, "runId" | "operationId">;
  },
): void {
  const revisionId = `revision-${input.runId}`;
  store.createInvocation({
    revision: {
      revisionId,
      canonicalProjectId: "project-1",
      canonicalWorkspaceRoot: "/workspace",
      scope: "project",
      normalizedPath: `${input.runId}.js`,
      name: input.runId,
      snapshotArtifact: workflowArtifactReferenceForTest(`workflow-source:${sha256(input.runId)}`),
      sourceSha256: sha256(input.runId),
      inputSchemaSha256: "a".repeat(64),
      resourcePolicySha256: "b".repeat(64),
      metadata: { name: input.runId, description: "Wait test" },
      inputSchema: { type: "object", additionalProperties: false },
      resources: normalizeWorkflowResourcePolicy({
        agents: {
          maxConcurrent: 1,
          maxTotal: 1,
        },
        maxNestingDepth: 2,
        operationIdleTimeoutMs: 10000,
        waits: ["reply", "sleep"],
      }),
      limits: {
        maxSourceBytes: 10000,
        maxInputBytes: 10000,
        maxOperationOutputBytes: 10000,
        maxResultBytes: 10000,
      },
      runtimeVersion: "lilac-workflow-js-v4",
      createdAt: 1,
    },
    run: {
      runId: input.runId,
      revisionId,
      state: "queued",
      inputSchemaSnapshot: { type: "object", additionalProperties: false },
      args: {},
      argsSha256: canonicalJsonSha256({}),
      origin: {
        requestId: "origin-1",
        sessionId: "channel-1",
        client: "discord",
        userId: "user-1",
        projectCwd: "/workspace",
      },
      completionTarget: { kind: "detached" },
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
  store.tryClaimRun({ runId: input.runId, claimerId: "engine", now: 3 });
  store.createOperation(
    {
      runId: input.runId,
      operationId: input.operationId,
      callSiteId: `site-${input.operationId}`,
      parentOperationId: null,
      phase: null,
      label: "wait",
      kind: "wait",
      input: {},
      inputSha256: canonicalJsonSha256({}),
      state: "blocked",
      attempt: 0,
      requestId: null,
      output: null,
      resultArtifact: null,
      error: null,
      usage: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 3,
      startedAt: 3,
      updatedAt: 3,
      terminalAt: null,
    },
    "engine",
  );
  store.createWait({ ...input.wait, runId: input.runId, operationId: input.operationId }, "engine");
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for resolver");
    // test-wait-justification: polls for resolver work performed by its independently scheduled bus consumer
    await Bun.sleep(5);
  }
}
describe("WorkflowWaitResolver", () => {
  it("paces lease heartbeats independently of timer polls and adapter events", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-heartbeat-${crypto.randomUUID()}.sqlite`);
    const store = new HeartbeatTrackingWaitStore(dbPath);
    const bus = createLilacBus(new IdleRawBus());
    let now = 100;
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "resolver-heartbeat-pacing",
      now: () => now,
      pollMs: 1000000,
      leaseHeartbeatMs: 1000,
    });
    const publishAdapterEvent = async (messageId: string): Promise<void> => {
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: "unused-channel",
        messageId,
        userId: "user-1",
        text: "unused",
        ts: now,
        raw: {},
      });
    };
    try {
      await resolver.start();
      expect(store.resolverLeaseRefreshes).toEqual([]);
      now = 350;
      await resolver.reconcileTimers();
      now = 600;
      await publishAdapterEvent("early-event");
      now = 1099;
      await resolver.reconcileTimers();
      expect(store.resolverLeaseRefreshes).toEqual([]);
      now = 1100;
      await publishAdapterEvent("due-event");
      await publishAdapterEvent("same-time-event");
      expect(store.resolverLeaseRefreshes).toEqual([1100]);
      now = 2100;
      await resolver.reconcileTimers();
      expect(store.resolverLeaseRefreshes).toEqual([1100, 2100]);
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("checks lease ownership without refreshing before timer side effects", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-read-ownership-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new IdleRawBus());
    let now = 50;
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "resolver-read-ownership",
      now: () => now,
      pollMs: 1000000,
      leaseHeartbeatMs: 1000,
    });
    try {
      createRunAndWait(store, {
        runId: "lease-lost-sleep",
        operationId: "sleep-1",
        wait: {
          state: "pending",
          match: { kind: "sleep" },
          matchKey: "sleep:100",
          dueAt: 100,
          deadlineAt: null,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      await resolver.start();
      expect(
        store.claimWorkflowWaitResolverLease({
          ownerId: "successor",
          now: 60,
          staleBefore: Number.MAX_SAFE_INTEGER,
        }),
      ).toBe(true);
      now = 100;
      await resolver.reconcileTimers();
      expect(workflowStoreValue(store.getWait("lease-lost-sleep", "sleep-1"))?.state).toBe(
        "pending",
      );
      expect(store.isWorkflowWaitResolverLeaseOwner("successor")).toBe(true);
    } finally {
      await resolver.stop();
      store.releaseWorkflowWaitResolverLease("successor");
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  for (const termination of ["completion", "failure"] as const) {
    it(`releases its lease and resubscribes after unexpected subscription ${termination}`, async () => {
      const dbPath = join(tmpdir(), `workflow-wait-subscription-${crypto.randomUUID()}.sqlite`);
      const store = new LeaseTrackingWaitStore(dbPath);
      const raw = new CompletingRawBus();
      const bus = createLilacBus(raw);
      const resolver = new WorkflowWaitResolver({
        bus,
        store,
        subscriptionId: `resolver-${termination}`,
        pollMs: 1000000,
        subscriptionRecoveryRetryMs: 0,
      });
      try {
        await resolver.start();
        const resubscribed = raw.observeNextSubscription();
        raw.terminate(0, termination === "failure" ? new Error("subscription failed") : undefined);
        await resubscribed;
        expect(raw.subscriptionCount).toBe(2);
        expect(store.resolverLeaseReleases).toBe(1);
        expect(
          store.claimWorkflowWaitResolverLease({
            ownerId: "competing-resolver",
            now: Date.now(),
            staleBefore: Number.MIN_SAFE_INTEGER,
          }),
        ).toBe(false);
      } finally {
        await resolver.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    });
  }
  it("continues subscription recovery beyond transient startup failures", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-subscription-retry-${crypto.randomUUID()}.sqlite`);
    const store = new LeaseTrackingWaitStore(dbPath);
    const raw = new CompletingRawBus();
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "resolver-retry-until-recovered",
      pollMs: 1000000,
      subscriptionRecoveryRetryMs: 0,
    });
    try {
      await resolver.start();
      raw.failNextSubscriptions(6);
      const resubscribed = raw.observeNextSubscription();
      raw.terminate(0, new Error("subscription failed"));
      await resubscribed;
      expect(raw.subscriptionAttempts).toBe(8);
      expect(raw.subscriptionCount).toBe(2);
      expect(store.resolverLeaseReleases).toBe(7);
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("keeps the startup failure primary when subscription cleanup returns an error", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-startup-cleanup-${crypto.randomUUID()}.sqlite`);
    const store = new LeaseTrackingWaitStore(dbPath);
    const raw = new RetirementFailingRawBus();
    raw.retirementFailure = new Error("retirement unavailable");
    raw.subscriptionStopFailure = new Error("cleanup unavailable");
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "resolver-startup-cleanup-precedence",
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(resolver.start()).rejects.toMatchObject({
        _tag: "WorkflowWaitResolverConsumerGroupRetirementFailed",
      });
      expect(raw.subscriptionStops).toBe(1);
      expect(store.resolverLeaseReleases).toBe(1);
    } finally {
      logged.mockRestore();
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("cleans up startup and preserves consumer-group retirement Panic identity", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-startup-panic-${crypto.randomUUID()}.sqlite`);
    const store = new LeaseTrackingWaitStore(dbPath);
    const raw = new RetirementFailingRawBus();
    const panic = new Panic({ message: "retirement defect" });
    raw.retirementFailure = panic;
    raw.subscriptionStopFailure = new Error("cleanup unavailable");
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "resolver-startup-panic",
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(resolver.start()).rejects.toBe(panic);
      expect(raw.subscriptionStops).toBe(1);
      expect(store.resolverLeaseReleases).toBe(1);
    } finally {
      logged.mockRestore();
      raw.subscriptionStopFailure = null;
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("releases its lease when the public stop adapter rejects a cleanup Result", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-stop-result-${crypto.randomUUID()}.sqlite`);
    const store = new LeaseTrackingWaitStore(dbPath);
    const raw = new RetirementFailingRawBus();
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "resolver-stop-result",
    });
    try {
      await resolver.start();
      raw.subscriptionStopFailure = new Error("cleanup unavailable");
      await expect(resolver.stop()).rejects.toMatchObject({ _tag: "EventDeliveryStopFailed" });
      expect(store.resolverLeaseReleases).toBe(1);
    } finally {
      raw.subscriptionStopFailure = null;
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("does not recover a subscription completed by intentional stop", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-subscription-stop-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CompletingRawBus();
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "resolver-intentional-stop",
      pollMs: 1000000,
      subscriptionRecoveryRetryMs: 0,
    });
    try {
      await resolver.start();
      await resolver.stop();
      await Promise.resolve();
      expect(raw.subscriptionCount).toBe(1);
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("advances its checkpoint and processes the next reply after wakeup publication fails", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-advisory-wakeup-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new FailingFirstWakeupRawBus();
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "advisory-wakeup",
      now: () => 10,
    });
    try {
      for (const index of [1, 2]) {
        createRunAndWait(store, {
          runId: `run-${index}`,
          operationId: `wait-${index}`,
          wait: {
            state: "pending",
            match: {
              kind: "reply",
              platform: "discord",
              channelId: `channel-${index}`,
              messageId: `anchor-${index}`,
              fromUserId: "user-1",
            },
            matchKey: `discord:channel-${index}`,
            dueAt: null,
            deadlineAt: 1000,
            resolverCursor: null,
            result: null,
            resolvedBy: null,
            claimedBy: null,
            claimedAt: null,
            createdAt: 3,
            updatedAt: 3,
            resolvedAt: null,
          },
        });
      }
      await resolver.start();
      const firstResult = await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: "channel-1",
        messageId: "reply-1",
        userId: "user-1",
        text: "first",
        ts: 10,
        raw: { discord: { replyToMessageId: "anchor-1" } },
      });
      const secondResult = await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: "channel-2",
        messageId: "reply-2",
        userId: "user-1",
        text: "second",
        ts: 10,
        raw: { discord: { replyToMessageId: "anchor-2" } },
      });
      if (firstResult.status === "error") throw firstResult.error;
      if (secondResult.status === "error") throw secondResult.error;
      const first = firstResult.value;
      const second = secondResult.value;
      expect(raw.wakeupFailures).toBe(1);
      expect(workflowStoreValue(store.getWait("run-1", "wait-1"))?.state).toBe("resolved");
      expect(workflowStoreValue(store.getWait("run-2", "wait-2"))?.state).toBe("resolved");
      expect(store.getWorkflowWaitResolverCheckpoint("evt.adapter")).toBe(second.cursor);
      expect(first.cursor).not.toBe(second.cursor);
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves wakeup publication Panic identity after durable reply resolution", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-wakeup-panic-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new ConfigurablePublicationFailureRawBus();
    const bus = createLilacBus(raw);
    const panic = new Panic({ message: "wakeup publication defect" });
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "wakeup-panic",
      now: () => 10,
      pollMs: 1000000,
    });
    try {
      createRunAndWait(store, {
        runId: "wakeup-panic-run",
        operationId: "wakeup-panic-wait",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: "anchor-1",
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 1000,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      await resolver.start();
      raw.wakeupFailure = panic;
      await expect(
        resolver.resolveAdapterEvent(
          {
            platform: "discord",
            channelId: "channel-1",
            messageId: "reply-1",
            userId: "user-1",
            text: "continue",
            ts: 10,
            raw: { discord: { replyToMessageId: "anchor-1" } },
          },
          "wakeup-panic-cursor",
        ),
      ).rejects.toBe(panic);
      expect(
        workflowStoreValue(store.getWait("wakeup-panic-run", "wakeup-panic-wait"))?.state,
      ).toBe("resolved");
    } finally {
      raw.wakeupFailure = null;
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("clears reconciliation state and preserves barrier publication Panic identity", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-barrier-panic-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new ConfigurablePublicationFailureRawBus();
    const bus = createLilacBus(raw);
    const panic = new Panic({ message: "barrier publication defect" });
    let now = 50;
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "barrier-panic",
      now: () => now,
      pollMs: 1000000,
    });
    try {
      createRunAndWait(store, {
        runId: "barrier-panic-run",
        operationId: "barrier-panic-wait",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: null,
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 100,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      await resolver.start();
      now = 100;
      raw.barrierFailure = panic;
      await expect(resolver.reconcileTimers()).rejects.toBe(panic);
      expect(
        workflowStoreValue(store.getWait("barrier-panic-run", "barrier-panic-wait"))?.state,
      ).toBe("pending");
      raw.barrierFailure = null;
      now = 5101;
      await resolver.reconcileTimers();
      await resolver.reconcileTimers();
      expect(
        workflowStoreValue(store.getWait("barrier-panic-run", "barrier-panic-wait"))?.state,
      ).toBe("expired");
    } finally {
      raw.barrierFailure = null;
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("enforces one ordered resolver consumer and releases its durable lease", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-lease-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new IdleRawBus();
    const bus = createLilacBus(raw);
    const first = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "ordered-resolver-first",
      now: () => 100,
    });
    const second = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "ordered-resolver-second",
      now: () => 100,
      leaseAcquireTimeoutMs: 10,
      leaseRetryMs: 2,
    });
    try {
      await first.start();
      expect(raw.retiredGroups[0]).toEqual({
        topic: "evt.adapter",
        group: "ordered-resolver-first",
        activated: true,
      });
      await expect(second.start()).rejects.toThrow("ordered workflow wait resolver");
      await first.stop();
      await second.start();
      await second.stop();
    } finally {
      await first.stop();
      await second.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("waits for and takes over a crashed resolver lease after it becomes stale", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-crash-lease-${crypto.randomUUID()}.sqlite`);
    const store = new LeaseTrackingWaitStore(dbPath);
    const bus = createLilacBus(new IdleRawBus());
    let now = 100;
    const crashed = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "crashed-resolver",
      now: () => now,
      leaseStaleMs: 20,
    });
    const replacement = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "replacement-resolver",
      now: () => now,
      leaseStaleMs: 20,
      leaseAcquireTimeoutMs: 200,
      leaseRetryMs: 0,
    });
    try {
      await crashed.start();
      const acquisitionAttempted = store.observeNextLeaseClaim();
      const takeover = replacement.start();
      await acquisitionAttempted;
      now = 121;
      await takeover;
    } finally {
      await replacement.stop();
      await crashed.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("resolves an offline on-time reply before expiring its deadline on restart", async () => {
    const dbPath = join(tmpdir(), `workflow-reply-catchup-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const event = {
      platform: "discord" as const,
      channelId: "channel-1",
      messageId: "reply-before-deadline",
      userId: "user-1",
      text: "on time",
      ts: 90,
      raw: { discord: { replyToMessageId: "anchor-1" } },
    };
    const raw = new HistoricalReplyRawBus({
      topic: "evt.adapter",
      id: "9-0",
      ts: 90,
      type: lilacEventTypes.EvtAdapterMessageCreated,
      key: "reply-before-deadline",
      data: event,
    });
    const bus = createLilacBus(raw);
    try {
      createRunAndWait(store, {
        runId: "reply-catchup",
        operationId: "wait-catchup",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: "anchor-1",
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 100,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      const resolver = new WorkflowWaitResolver({
        bus,
        store,
        subscriptionId: "historical-before-expiry",
        now: () => 200,
        pollMs: 10,
      });
      await resolver.start();
      expect(workflowStoreValue(store.getWait("reply-catchup", "wait-catchup"))).toMatchObject({
        state: "resolved",
        resolverCursor: "9-0",
        result: { text: "on time", messageId: "reply-before-deadline" },
      });
      await resolver.stop();
    } finally {
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("resumes after its durable checkpoint and processes replies published during downtime", async () => {
    const dbPath = join(tmpdir(), `workflow-reply-checkpoint-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new IdleRawBus([
      {
        topic: "evt.adapter",
        id: "checkpoint-1",
        ts: 10,
        type: lilacEventTypes.EvtAdapterMessageCreated,
        key: "irrelevant",
        data: {
          platform: "discord",
          channelId: "other-channel",
          messageId: "irrelevant",
          userId: "user-1",
          text: "ignore",
          ts: 10,
        },
      },
    ]);
    const bus = createLilacBus(raw);
    const first = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "checkpoint-first",
      now: () => 20,
    });
    const restarted = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "checkpoint-restarted",
      now: () => 20,
    });
    try {
      createRunAndWait(store, {
        runId: "checkpoint-run",
        operationId: "checkpoint-wait",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: "anchor-1",
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 1000,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      await first.start();
      await first.stop();
      expect(store.getWorkflowWaitResolverCheckpoint("evt.adapter")).toBe("checkpoint-1");
      await bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
        platform: "discord",
        channelId: "channel-1",
        messageId: "reply-during-downtime",
        userId: "user-1",
        text: "resume",
        ts: 19,
        raw: { discord: { replyToMessageId: "anchor-1" } },
      });
      expect(workflowStoreValue(store.getWait("checkpoint-run", "checkpoint-wait"))?.state).toBe(
        "pending",
      );
      await restarted.start();
      expect(workflowStoreValue(store.getWait("checkpoint-run", "checkpoint-wait"))).toMatchObject({
        state: "resolved",
        result: { messageId: "reply-during-downtime", text: "resume" },
      });
    } finally {
      await restarted.stop();
      await first.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("does not advance the tail when the SQLite checkpoint cannot advance", async () => {
    const dbPath = join(
      tmpdir(),
      `workflow-reply-checkpoint-failure-${crypto.randomUUID()}.sqlite`,
    );
    const store = new CheckpointRejectingWaitStore(dbPath);
    const raw = new IdleRawBus([
      {
        topic: "evt.adapter",
        id: "checkpoint-rejected",
        ts: 10,
        type: lilacEventTypes.EvtAdapterMessageCreated,
        key: "irrelevant",
        data: {
          platform: "discord",
          channelId: "other-channel",
          messageId: "irrelevant",
          userId: "user-1",
          text: "ignore",
          ts: 10,
        },
      },
    ]);
    const actions: string[] = [];
    testDeliveryActions.set(raw, actions);
    testDeliveriesRemainOpenOnPolicyStop.add(raw);
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "checkpoint-rejected",
      now: () => 20,
    });
    try {
      await resolver.start();
      expect(store.checkpointAttempts).toBe(1);
      expect(store.getWorkflowWaitResolverCheckpoint("evt.adapter")).toBeNull();
      expect(actions).toEqual(["stop"]);
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("replays an offline reply, persists its cursor, and expires router suppression after consumption", async () => {
    const dbPath = join(tmpdir(), `workflow-reply-wait-${crypto.randomUUID()}.sqlite`);
    let store = new DurableWorkflowStore(dbPath);
    const raw = new IdleRawBus();
    const bus = createLilacBus(raw);
    const event = {
      platform: "discord" as const,
      channelId: "channel-1",
      messageId: "reply-1",
      userId: "user-1",
      text: "continue",
      ts: 20,
      raw: { discord: { replyToMessageId: "anchor-1" } },
    };
    try {
      createRunAndWait(store, {
        runId: "reply-wait",
        operationId: "wait-1",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: "anchor-1",
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 1000,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      expect(shouldSuppressRouterForWorkflowReply({ store, event, now: 10 }).suppress).toBe(true);
      const resolver = new WorkflowWaitResolver({
        bus,
        store,
        subscriptionId: "test-wait-offline",
        now: () => 20,
        pollMs: 10,
      });
      await resolver.start();
      await resolver.resolveAdapterEvent({ ...event, messageId: "historical", ts: 2 }, "0-1");
      await resolver.resolveAdapterEvent({ ...event, messageId: "late", ts: 1001 }, "0-2");
      expect(workflowStoreValue(store.getWait("reply-wait", "wait-1"))?.state).toBe("pending");
      expect(
        shouldSuppressRouterForWorkflowReply({
          store,
          event: { ...event, messageId: "exact", ts: 1000 },
          now: 20,
        }).suppress,
      ).toBe(false);
      await resolver.resolveAdapterEvent(event, "1-0");
      await waitFor(
        () => workflowStoreValue(store.getWait("reply-wait", "wait-1"))?.state === "resolved",
      );
      const resolved = workflowStoreValue(store.getWait("reply-wait", "wait-1"));
      expect(resolved).toMatchObject({
        resolverCursor: "1-0",
        result: { text: "continue", messageId: "reply-1" },
      });
      expect(shouldSuppressRouterForWorkflowReply({ store, event, now: 21 }).suppress).toBe(true);
      expect(shouldSuppressRouterForWorkflowReply({ store, event, now: 22 }).suppress).toBe(true);
      expect(
        shouldSuppressRouterForWorkflowReply({ store, event, now: 20 + 5 * 60000 }).suppress,
      ).toBe(false);
      await resolver.stop();
    } finally {
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("expires an exact-deadline reply deterministically regardless of resolver order", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-deadline-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new IdleRawBus());
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "test-wait-exact-deadline",
      now: () => 100,
    });
    const event = {
      platform: "discord" as const,
      channelId: "channel-1",
      messageId: "reply-at-deadline",
      userId: "user-1",
      text: "continue",
      ts: 100,
      raw: { discord: { replyToMessageId: "anchor-1" } },
    };
    try {
      createRunAndWait(store, {
        runId: "exact-deadline",
        operationId: "wait-1",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: "anchor-1",
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 100,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      await resolver.start();
      await resolver.resolveAdapterEvent(event, "1-0");
      expect(workflowStoreValue(store.getWait("exact-deadline", "wait-1"))?.state).toBe("pending");
      await resolver.reconcileTimers();
      expect(workflowStoreValue(store.getWait("exact-deadline", "wait-1"))?.state).toBe("expired");
      await resolver.resolveAdapterEvent(event, "1-1");
      expect(workflowStoreValue(store.getWait("exact-deadline", "wait-1"))?.state).toBe("expired");
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("waits until its ordered adapter barrier is processed before expiring a reply", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-watermark-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new IdleRawBus();
    const bus = createLilacBus(raw);
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "test-wait-watermark",
      now: () => 100,
    });
    try {
      createRunAndWait(store, {
        runId: "watermark-wait",
        operationId: "wait-1",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: "anchor-1",
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 100,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      await resolver.start();
      expect(workflowStoreValue(store.getWait("watermark-wait", "wait-1"))?.state).toBe("pending");
      await resolver.reconcileTimers();
      expect(workflowStoreValue(store.getWait("watermark-wait", "wait-1"))?.state).toBe("expired");
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("resolves sleeps once, expires reply deadlines, and recovers both after restart", async () => {
    const dbPath = join(tmpdir(), `workflow-timer-wait-${crypto.randomUUID()}.sqlite`);
    let store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new IdleRawBus());
    let now = 50;
    const resolver = new WorkflowWaitResolver({
      bus,
      store,
      subscriptionId: "test-wait-timers",
      now: () => now,
      pollMs: 5,
    });
    try {
      createRunAndWait(store, {
        runId: "sleep-wait",
        operationId: "sleep-1",
        wait: {
          state: "pending",
          match: { kind: "sleep" },
          matchKey: "sleep:100",
          dueAt: 100,
          deadlineAt: null,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      createRunAndWait(store, {
        runId: "timeout-wait",
        operationId: "reply-2",
        wait: {
          state: "pending",
          match: {
            kind: "reply",
            platform: "discord",
            channelId: "channel-1",
            messageId: null,
            fromUserId: "user-1",
          },
          matchKey: "discord:channel-1",
          dueAt: null,
          deadlineAt: 90,
          resolverCursor: null,
          result: null,
          resolvedBy: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 3,
          updatedAt: 3,
          resolvedAt: null,
        },
      });
      await resolver.start();
      await resolver.stop();
      expect(workflowStoreValue(store.getWait("sleep-wait", "sleep-1"))?.state).toBe("pending");
      store.close();
      store = new DurableWorkflowStore(dbPath);
      now = 100;
      const restarted = new WorkflowWaitResolver({
        bus,
        store,
        subscriptionId: "test-wait-timers",
        now: () => now,
        pollMs: 5,
      });
      await restarted.start();
      await waitFor(
        () => workflowStoreValue(store.getWait("sleep-wait", "sleep-1"))?.state === "resolved",
      );
      await waitFor(
        () => workflowStoreValue(store.getWait("timeout-wait", "reply-2"))?.state === "expired",
      );
      expect(workflowStoreValue(store.getWait("sleep-wait", "sleep-1"))?.result).toMatchObject({
        dueAt: 100,
      });
      await restarted.stop();
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});

it("resolves a reply from Redis, publishes progress, and resumes its persisted cursor after restart", async () => {
  const f = await createRealCoreBusFixture();
  const file = join(f.directory, "waits.sqlite");
  let store = new DurableWorkflowStore(file);
  const makeResolver = () =>
    new WorkflowWaitResolver({
      bus: f.bus,
      store,
      subscriptionId: "real-reply-resolver",
      now: () => 10,
      pollMs: 60_000,
    });
  let resolver = makeResolver();
  const wakeups: string[] = [];
  let wakeup = Promise.withResolvers<void>();
  const subscription = requireBusOk(
    await f.bus.subscribeTopic(
      "evt.workflow",
      { mode: "fanout", subscriptionId: "reply-progress-observer" },
      async (message) => {
        if (message.type === lilacEventTypes.EvtWorkflowProgressRequested) {
          wakeups.push(message.data.runId);
          wakeup.resolve();
        }
        return Result.ok(undefined);
      },
      () => "commit",
    ),
  );
  const createWait = (index: number) =>
    createRunAndWait(store, {
      runId: `real-reply-${index}`,
      operationId: "reply",
      wait: {
        state: "pending",
        match: {
          kind: "reply",
          platform: "discord",
          channelId: "channel",
          messageId: `anchor-${index}`,
          fromUserId: "user-1",
        },
        matchKey: "discord:channel",
        dueAt: null,
        deadlineAt: 1000,
        resolverCursor: null,
        result: null,
        resolvedBy: null,
        claimedBy: null,
        claimedAt: null,
        createdAt: 3,
        updatedAt: 3,
        resolvedAt: null,
      },
    });
  const publishReply = (index: number) =>
    f.bus.publish(lilacEventTypes.EvtAdapterMessageCreated, {
      platform: "discord",
      channelId: "channel",
      messageId: `reply-${index}`,
      userId: "user-1",
      text: `answer-${index}`,
      ts: 10,
      raw: { discord: { replyToMessageId: `anchor-${index}` } },
    });
  try {
    createWait(1);
    await resolver.start();
    const first = requireBusOk(await publishReply(1));
    await withBusDeadline(wakeup.promise, "first reply progress");
    await waitFor(() => store.getWorkflowWaitResolverCheckpoint("evt.adapter") === first.cursor);
    expect(workflowStoreValue(store.getWait("real-reply-1", "reply"))?.state).toBe("resolved");
    await resolver.stop();
    store.close();
    store = new DurableWorkflowStore(file);
    createWait(2);
    wakeup = Promise.withResolvers<void>();
    const second = requireBusOk(await publishReply(2));
    resolver = makeResolver();
    await resolver.start();
    await withBusDeadline(wakeup.promise, "offline reply replay");
    await waitFor(() => store.getWorkflowWaitResolverCheckpoint("evt.adapter") === second.cursor);
    expect(workflowStoreValue(store.getWait("real-reply-2", "reply"))?.state).toBe("resolved");
    expect(wakeups).toEqual(["real-reply-1", "real-reply-2"]);
  } finally {
    await resolver.stop();
    requireBusOk(await subscription.stop());
    store.close();
    await f.close();
  }
}, 15_000);
