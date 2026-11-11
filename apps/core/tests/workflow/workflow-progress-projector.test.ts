import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "../helpers/real-core-bus";
import { normalizeWorkflowResourcePolicy, workflowStoreValue } from "./workflow-store-test-helpers";
import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type RawDeliveryAction,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result } from "better-result";
import { subscribeForTest, type TestRawMessageHandler } from "../helpers/result-raw-bus";
import { workflowArtifactReferenceForTest } from "./workflow-test-blob-store";
import {
  SurfaceMessageNotFound,
  SurfaceOperationPartiallyCompleted,
  SurfaceOperationUnsupported,
  SurfaceRateLimited,
  SurfaceUnavailable,
  type SurfaceOperationError,
} from "../../src/surface/adapter";
import { createDiscordWorkflowProgressPort } from "../../src/surface/discord/discord-runtime-descriptor";
import { discordSurfaceProtocol } from "../../src/surface/discord/discord-surface-protocol";
import { createGithubWorkflowProgressPort } from "../../src/surface/github/github-runtime-descriptor";
import { githubSurfaceProtocol } from "../../src/surface/github/github-surface-protocol";
import type {
  RegisteredSurfacePlatform,
  RegisteredSurfaceWorkflowProgressRegistration,
  SurfaceProtocolResolver,
  SurfaceWorkflowProgressPort,
  WorkflowProgressContent,
} from "../../src/surface/runtime-descriptor";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";
import { SurfaceAdapterTestBase } from "../helpers/surface-adapter-test-base";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { startWorkflowActionResolver as startWorkflowActionResolverProduction } from "../../src/workflow/workflow-action-resolver";
import { sha256 } from "../../src/workflow/workflow-definition";
import { WorkflowProgressProjector } from "../../src/workflow/workflow-progress-projector";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const TEST_SURFACE_PROTOCOL_RESOLVER: SurfaceProtocolResolver = {
  resolve: (platform) => {
    switch (platform) {
      case "discord":
        return { platform, protocol: discordSurfaceProtocol };
      case "github":
        return { platform, protocol: githubSurfaceProtocol };
      default:
        return null;
    }
  },
};

function startWorkflowActionResolver(
  input: Parameters<typeof startWorkflowActionResolverProduction>[0],
) {
  return startWorkflowActionResolverProduction({
    ...input,
    surfaceProtocolResolver: input.surfaceProtocolResolver ?? TEST_SURFACE_PROTOCOL_RESOLVER,
  });
}

type WorkflowProgressProjectorTestInput = Omit<
  ConstructorParameters<typeof WorkflowProgressProjector>[0],
  "reportFatalPanic"
> &
  Partial<Pick<ConstructorParameters<typeof WorkflowProgressProjector>[0], "reportFatalPanic">>;

function createWorkflowProgressProjectorForTest(input: WorkflowProgressProjectorTestInput) {
  return new WorkflowProgressProjector({
    reportFatalPanic: (panic) => {
      throw panic;
    },
    ...input,
  });
}
class CapturingRawBus implements RawBus {
  readonly subscribe = subscribeForTest;
  readonly publishedOutboxIds: string[] = [];
  commits = 0;
  onCommit: (() => void) | null = null;
  outboxPublicationFailure: Error | null = null;
  subscriptionStopFailure: Error | null = null;
  private sequence = 0;
  private readonly subscriptions: Array<{
    topic: string;
    handler: TestRawMessageHandler;
  }> = [];
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
    const outboxId = options.headers?.["workflow_outbox_id"];
    if (outboxId && this.outboxPublicationFailure) throw this.outboxPublicationFailure;
    if (outboxId) this.publishedOutboxIds.push(outboxId);
    const id = `${++this.sequence}-0`;
    const stored: Message<unknown> = { ...message, id, ts: Date.now() };
    for (const subscription of this.subscriptions) {
      if (subscription.topic !== message.topic) continue;
      await subscription.handler(stored, id);
    }
    return { id, cursor: id };
  }
  async openTestSubscription(
    topic: string,
    _options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    const subscription = { topic, handler };
    this.subscriptions.push(subscription);
    return {
      stop: async () => {
        if (this.subscriptionStopFailure) throw this.subscriptionStopFailure;
        const index = this.subscriptions.indexOf(subscription);
        if (index >= 0) this.subscriptions.splice(index, 1);
      },
    };
  }
  onTestDeliveryAction(action: RawDeliveryAction): void {
    if (action.disposition !== "commit" && action.disposition !== "dead-letter") return;
    this.commits += 1;
    this.onCommit?.();
  }
  async fetch(_topic: string, _options: FetchOptions) {
    return { messages: [] };
  }
  async close() {}
}
class ProjectionAdapter extends SurfaceAdapterTestBase {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;
  edits = 0;
  reads = 0;
  failNextSend = false;
  failNextRead = false;
  failNextEditNotFound = false;
  partialNextSend = false;
  sendFailure: SurfaceOperationError | null = null;
  editOperationFailure: SurfaceOperationError | null = null;
  sendRejection: { readonly value: unknown } | null = null;
  editFailure: Error | null = null;
  constructor(readonly platform: "discord" | "github" = "discord") {
    super();
  }
  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: this.platform, userId: "bot", userName: "bot" };
  }
  async listSessions() {
    return Result.ok([]);
  }
  async startOutput() {
    return Result.ok({
      push: async () => Result.ok("visible" as const),
      finish: async () => {
        const ref: MsgRef = {
          platform: this.platform,
          channelId: "unused",
          messageId: "unused",
        };
        return Result.ok({ created: [ref], last: ref });
      },
      abort: async () => Result.ok(undefined),
    });
  }
  async sendMsg(session: SessionRef, content: ContentOpts, _opts?: SendOpts) {
    if (this.sendRejection) {
      const rejection = this.sendRejection.value;
      this.sendRejection = null;
      throw rejection;
    }
    if (this.failNextSend) {
      this.failNextSend = false;
      return Result.err(
        new SurfaceUnavailable({
          platform: this.platform,
          operation: "send-message",
          message: "transient surface failure",
        }),
      );
    }
    if (this.sendFailure) return Result.err(this.sendFailure);
    if (this.partialNextSend) {
      this.partialNextSend = false;
      const ref: MsgRef =
        this.platform === "discord"
          ? { platform: "discord", channelId: session.channelId, messageId: "partial-card" }
          : { platform: "github", channelId: session.channelId, messageId: "partial-card" };
      this.messages.set(ref.messageId, {
        ref,
        session,
        userId: "bot",
        text: content.text ?? "",
        ts: Date.now(),
      });
      return Result.err(
        new SurfaceOperationPartiallyCompleted({
          platform: this.platform,
          operation: "send-message",
          created: ref,
          message: "message created before controls failed",
        }),
      );
    }
    this.sends += 1;
    this.contents.push(content);
    const ref: MsgRef =
      this.platform === "discord"
        ? { platform: "discord", channelId: session.channelId, messageId: `card-${this.sends}` }
        : { platform: "github", channelId: session.channelId, messageId: `card-${this.sends}` };
    this.messages.set(ref.messageId, {
      ref,
      session,
      userId: "bot",
      text: content.text ?? "",
      ts: Date.now(),
    });
    return Result.ok(ref);
  }
  async readMsg(ref: MsgRef) {
    this.reads += 1;
    if (this.failNextRead) {
      this.failNextRead = false;
      return Result.err(
        new SurfaceUnavailable({
          platform: this.platform,
          operation: "read-message",
          message: "transient lookup failure",
        }),
      );
    }
    return Result.ok(this.messages.get(ref.messageId) ?? null);
  }
  async listMsg(_session: SessionRef, _opts?: LimitOpts) {
    return Result.ok([...this.messages.values()]);
  }
  async editMsg(ref: MsgRef, content: ContentOpts) {
    if (this.editOperationFailure) return Result.err(this.editOperationFailure);
    if (this.editFailure) {
      if (Panic.is(this.editFailure)) throw this.editFailure;
      return Result.err(
        new SurfaceUnavailable({
          platform: this.platform,
          operation: "edit-message",
          message: this.editFailure.message,
        }),
      );
    }
    if (this.failNextEditNotFound) {
      this.failNextEditNotFound = false;
      this.messages.delete(ref.messageId);
      return Result.err(
        new SurfaceMessageNotFound({
          platform: this.platform,
          operation: "edit-message",
          message: "missing",
        }),
      );
    }
    const current = this.messages.get(ref.messageId);
    if (!current)
      return Result.err(
        new SurfaceMessageNotFound({
          platform: this.platform,
          operation: "edit-message",
          message: "missing",
        }),
      );
    this.edits += 1;
    this.contents.push(content);
    this.messages.set(ref.messageId, { ...current, text: content.text ?? "" });
    return Result.ok(undefined);
  }
  async deleteMsg(ref: MsgRef) {
    this.messages.delete(ref.messageId);
    return Result.ok(undefined);
  }
  async getReplyContext() {
    return Result.ok([]);
  }
  async addReaction() {
    return Result.ok(undefined);
  }
  async removeReaction() {
    return Result.ok(undefined);
  }
  async listReactions() {
    return Result.ok([]);
  }
  async getUnRead() {
    return Result.ok([]);
  }
  async markRead() {
    return Result.ok(undefined);
  }
}
class BlockingProjectionAdapter extends ProjectionAdapter {
  private releaseSend: (() => void) | null = null;
  private resolveSendStarted: () => void = () => {};
  readonly sendStarted = new Promise<void>((resolve) => {
    this.resolveSendStarted = resolve;
  });
  release(): void {
    this.releaseSend?.();
  }
  override async sendMsg(session: SessionRef, content: ContentOpts, options?: SendOpts) {
    this.resolveSendStarted();
    await new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
    return await super.sendMsg(session, content, options);
  }
}
class LateBlockingProjectionAdapter extends ProjectionAdapter {
  private readonly releaseLateSend = Promise.withResolvers<void>();
  private readonly lateSendStartedResolver = Promise.withResolvers<void>();
  readonly lateSendStarted = this.lateSendStartedResolver.promise;

  release(): void {
    this.releaseLateSend.resolve();
  }

  override async sendMsg(session: SessionRef, content: ContentOpts, options?: SendOpts) {
    if (session.channelId === "late-channel") {
      this.lateSendStartedResolver.resolve();
      await this.releaseLateSend.promise;
    }
    return await super.sendMsg(session, content, options);
  }
}
class ReconciliationFailureStore extends DurableWorkflowStore {
  listCalls = 0;

  constructor(
    dbPath: string,
    private readonly failures: ReadonlyMap<number, unknown>,
    private readonly onListCall?: (call: number) => void,
  ) {
    super(dbPath);
  }

  override listRunsNeedingProjectionReconciliation(
    options?: Parameters<DurableWorkflowStore["listRunsNeedingProjectionReconciliation"]>[0],
  ) {
    this.listCalls += 1;
    this.onListCall?.(this.listCalls);
    const failure = this.failures.get(this.listCalls);
    if (failure !== undefined) throw failure;
    return super.listRunsNeedingProjectionReconciliation(options);
  }
}
function projectionPorts(
  adapter: ProjectionAdapter,
): Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration> {
  const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration>();
  if (adapter.platform === "discord") {
    ports.set("discord", {
      platform: "discord",
      protocol: discordSurfaceProtocol,
      port: createDiscordWorkflowProgressPort(adapter),
    });
  } else {
    ports.set("github", {
      platform: "github",
      protocol: githubSurfaceProtocol,
      port: createGithubWorkflowProgressPort(adapter),
    });
  }
  return ports;
}
function combinedProjectionPorts(
  ...adapters: readonly ProjectionAdapter[]
): Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration> {
  const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration>();
  for (const adapter of adapters) {
    for (const [platform, port] of projectionPorts(adapter)) ports.set(platform, port);
  }
  return ports;
}
function createInvocation(
  store: DurableWorkflowStore,
  {
    hasProgressTarget = true,
    platform = "discord",
    targetChannelId = "channel-1",
    origin,
    runId = "run-1",
  }: {
    readonly hasProgressTarget?: boolean;
    readonly platform?: "discord" | "github";
    readonly targetChannelId?: string;
    readonly origin?: { readonly platform: "discord" | "github"; readonly sessionId: string };
    readonly runId?: string;
  } = {},
): void {
  const invocationOrigin = origin ?? { platform, sessionId: "channel-1" };
  store.createInvocation({
    revision: {
      revisionId: "revision-1",
      canonicalProjectId: "project-1",
      canonicalWorkspaceRoot: "/workspace",
      scope: "project",
      normalizedPath: "audit.js",
      name: "audit",
      snapshotArtifact: workflowArtifactReferenceForTest(`workflow-source:${HASH_A}`),
      sourceSha256: HASH_A,
      inputSchemaSha256: HASH_B,
      resourcePolicySha256: "c".repeat(64),
      metadata: { name: "audit", description: "Audit routes" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { directory: { type: "string" }, token: { type: "string", sensitive: true } },
      },
      resources: normalizeWorkflowResourcePolicy({
        agents: { maxConcurrent: 2, maxTotal: 8 },
        maxNestingDepth: 4,
        operationIdleTimeoutMs: 10000,
        waits: [],
      }),
      limits: {
        maxSourceBytes: 100000,
        maxInputBytes: 10000,
        maxOperationOutputBytes: 10000,
        maxResultBytes: 10000,
      },
      runtimeVersion: "lilac-workflow-js-v4",
      createdAt: 10,
    },
    run: {
      runId,
      revisionId: "revision-1",
      state: "queued",
      inputSchemaSnapshot: {
        type: "object",
        additionalProperties: false,
        properties: { directory: { type: "string" }, token: { type: "string", sensitive: true } },
      },
      args: { directory: "src", token: "secret" },
      argsSha256: "d".repeat(64),
      origin: {
        requestId: `${invocationOrigin.platform}:${invocationOrigin.sessionId}:origin-1`,
        sessionId: invocationOrigin.sessionId,
        client: invocationOrigin.platform,
        userId: "user-1",
        projectCwd: "/workspace",
      },
      completionTarget: { kind: "durable_surface" },
      progressTarget: hasProgressTarget
        ? { platform, channelId: targetChannelId, replyToMessageId: "origin-1" }
        : null,
      terminalDetail: null,
      result: null,
      resultArtifact: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 10,
      startedAt: null,
      updatedAt: 10,
      terminalAt: null,
    },
    maxActiveRuns: 2_000,
  });
}
function contentActionToken(content: ContentOpts | undefined, label: string): string {
  const token = content?.actions?.find((action) => action.label === label)?.actionId;
  if (!token) throw new Error(`Missing ${label} action`);
  return token;
}
function actionToken(adapter: ProjectionAdapter, label: string): string {
  return contentActionToken(adapter.contents.at(-1), label);
}
function appliedSurfaceActionStatus(
  result: ReturnType<DurableWorkflowStore["applySurfaceAction"]>,
): string {
  expect(result.status).toBe("ok");
  if (result.status === "error") throw result.error;
  return result.value.status;
}
function tempDbPath(label: string): string {
  return join(tmpdir(), `${label}-${crypto.randomUUID()}.sqlite`);
}

class FakeProjectionScheduler {
  private tasks: Array<{
    at: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];
  private readonly scheduleObservers = new Map<number, Set<() => void>>();

  constructor(readonly clock: { now: number }) {}

  readonly scheduleTimeout = (callback: () => void, delayMs: number) => {
    const task = { at: this.clock.now + delayMs, callback, cancelled: false };
    this.tasks.push(task);
    const observers = this.scheduleObservers.get(task.at);
    if (observers) {
      this.scheduleObservers.delete(task.at);
      for (const resolve of observers) resolve();
    }
    return { cancel: () => (task.cancelled = true) };
  };

  whenScheduledAt(at: number): Promise<void> {
    if (this.tasks.some((task) => !task.cancelled && task.at === at)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const observers = this.scheduleObservers.get(at) ?? new Set<() => void>();
      observers.add(resolve);
      this.scheduleObservers.set(at, observers);
    });
  }

  scheduledTimes(): number[] {
    return this.tasks
      .filter((task) => !task.cancelled)
      .map((task) => task.at)
      .sort((left, right) => left - right);
  }

  allScheduledTimes(): number[] {
    return this.tasks.map((task) => task.at);
  }

  advanceTo(now: number): void {
    this.clock.now = now;
    const due = this.tasks.filter((task) => !task.cancelled && task.at <= now);
    for (const task of due) {
      task.cancelled = true;
      task.callback();
    }
  }
}
describe("WorkflowProgressProjector", () => {
  it("ignores event projection for a null target and rejects explicit card creation", async () => {
    const dbPath = tempDbPath("workflow-null-target");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "null-target",
      coalesceMs: 0,
      minEditIntervalMs: 0,
    });
    try {
      createInvocation(store, { hasProgressTarget: false });
      projector.requestProjection("run-1");
      // test-wait-justification: allows an asynchronously requested null-target projection to be ignored
      await Bun.sleep(20);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toBeNull();
      expect(adapter.sends).toBe(0);
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "has no supported durable progress target",
      );
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("creates one durable binding and skips unchanged edits by rendered hash", async () => {
    const dbPath = tempDbPath("workflow-one-binding");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "one-binding",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const first = await projector.ensureInitialCard("run-1");
      const binding = workflowStoreValue(store.getSurfaceBinding("run-1"));
      expect(binding?.messageRef).toEqual(first);
      expect(binding?.lastRenderedSha256).toHaveLength(64);
      const content = adapter.contents[0];
      expect(content?.text).toContain("## audit\nAudit routes\n\n**Queued**");
      expect(content?.attachments).toEqual([]);
      for (const internalValue of [
        "run-1",
        "revision-1",
        "project-1",
        "/workspace",
        "audit.js",
        HASH_A,
        HASH_B,
        "Resources and durability",
        "Hashes",
        "Source access",
        "tokens",
      ]) {
        expect(content?.text).not.toContain(internalValue);
      }
      await projector.ensureInitialCard("run-1");
      expect(adapter.sends).toBe(1);
      expect(adapter.edits).toBe(0);
      expect(workflowStoreValue(store.listSurfaceBindings())).toHaveLength(1);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("coalesces repeated wakeups into one changed-state edit", async () => {
    const dbPath = tempDbPath("workflow-coalescing");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 100 };
    const scheduler = new FakeProjectionScheduler(clock);
    const edited = Promise.withResolvers<void>();
    const originalEdit = adapter.editMsg.bind(adapter);
    const edit = spyOn(adapter, "editMsg").mockImplementation(async (...args) => {
      const result = await originalEdit(...args);
      edited.resolve();
      return result;
    });
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "coalescing",
      now: () => clock.now,
      scheduleTimeout: scheduler.scheduleTimeout,
      coalesceMs: 5,
      minEditIntervalMs: 0,
    });
    try {
      createInvocation(store);
      await projector.ensureInitialCard("run-1");
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: 101 })?.state).toBe(
        "running",
      );
      projector.requestProjection("run-1");
      projector.requestProjection("run-1");
      expect(scheduler.scheduledTimes().filter((at) => at === 105)).toHaveLength(1);
      scheduler.advanceTo(105);
      await edited.promise;
      expect(adapter.edits).toBe(1);
      expect(adapter.contents.at(-1)?.text).toContain("**Running**");
    } finally {
      edit.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("schedules an event projection before transport commit", async () => {
    const dbPath = tempDbPath("workflow-schedule-before-commit");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "schedule-before-commit",
      coalesceMs: 1000000,
    });
    const order: string[] = [];
    const requestProjection = projector.requestProjection.bind(projector);
    const requestSpy = spyOn(projector, "requestProjection").mockImplementation((runId) => {
      order.push("schedule");
      requestProjection(runId);
    });
    raw.onCommit = () => order.push("commit");
    try {
      createInvocation(store);
      await projector.start();
      order.length = 0;
      await bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: "run-1",
        revisionId: "revision-1",
        reason: "reconcile",
        ts: 20,
      });
      expect(order).toEqual(["schedule", "commit"]);
    } finally {
      requestSpy.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reconciles targeted runs at startup and recreates a missing bound card", async () => {
    const dbPath = tempDbPath("workflow-startup-reconcile");
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "startup-first",
      now: () => 20,
    });
    try {
      createInvocation(store);
      await projector.start();
      expect(adapter.sends).toBe(1);
      const firstRef = workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef;
      if (!firstRef) throw new Error("Missing startup binding");
      await projector.stop();
      store.close();
      adapter.messages.delete(firstRef.messageId);
      store = new DurableWorkflowStore(dbPath);
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: "startup-second",
        now: () => 30,
      });
      await projector.start();
      expect(adapter.reads).toBe(1);
      expect(adapter.sends).toBe(2);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef?.messageId).toBe(
        "card-2",
      );
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("bounds startup reconciliation and owns the later keyset drain through stop", async () => {
    const dbPath = tempDbPath("workflow-startup-reconcile-pages");
    const failedPage = Promise.withResolvers<void>();
    const store = new ReconciliationFailureStore(
      dbPath,
      new Map([[2, new Error("transient reconciliation read failure")]]),
      (call) => {
        if (call === 2) failedPage.resolve();
      },
    );
    const adapter = new LateBlockingProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 20 };
    const scheduler = new FakeProjectionScheduler(clock);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "startup-reconcile-pages",
      now: () => clock.now,
      reconciliationBatchSize: 3,
      scheduleTimeout: scheduler.scheduleTimeout,
    });
    let stopping: Promise<void> | undefined;
    try {
      for (let index = 0; index < 3; index += 1) {
        createInvocation(store, {
          platform: "discord",
          targetChannelId: "early-channel",
          origin: { platform: "discord", sessionId: "channel-1" },
          runId: `run-${index.toString().padStart(4, "0")}`,
        });
      }
      createInvocation(store, {
        platform: "discord",
        targetChannelId: "late-channel",
        origin: { platform: "discord", sessionId: "channel-1" },
        runId: "run-0003",
      });
      store.upsertSurfaceBinding({
        runId: "run-0003",
        target: {
          platform: "discord",
          channelId: "late-channel",
          replyToMessageId: "origin-1",
        },
        messageRef: null,
        lastRenderedSha256: null,
        lastError: "old permanent gate",
        retryCount: 0,
        nextAttemptAt: null,
        permanentFailure: {
          operation: "send",
          reason: "unsupported",
          configurationRevision: "old-discord-contract",
          message: "old permanent gate",
          failedAt: 10,
        },
        createdAt: 10,
        updatedAt: 10,
      });

      let startReturned = false;
      const starting = projector.start().then(() => {
        startReturned = true;
      });
      await failedPage.promise;
      await scheduler.whenScheduledAt(1_020);

      expect(startReturned).toBe(true);
      expect(store.listCalls).toBe(2);
      scheduler.advanceTo(1_020);
      await adapter.lateSendStarted;

      await starting;
      expect(adapter.sends).toBe(3);

      stopping = projector.stop();
      expect(
        await Promise.race([
          stopping.then(() => "stopped" as const),
          Promise.resolve("pending" as const),
        ]),
      ).toBe("pending");
      adapter.release();
      await stopping;

      expect(adapter.sends).toBe(4);
      expect(store.listCalls).toBe(3);
      expect(workflowStoreValue(store.getSurfaceBinding("run-0003"))).toMatchObject({
        messageRef: { channelId: "late-channel" },
        permanentFailure: null,
      });
    } finally {
      adapter.release();
      await stopping;
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("backs off repeated reconciliation failures and eventually completes", async () => {
    const dbPath = tempDbPath("workflow-reconcile-repeated-retry");
    const store = new ReconciliationFailureStore(
      dbPath,
      new Map(
        Array.from({ length: 8 }, (_, index): readonly [number, Error] => [
          index + 1,
          new Error(`reconciliation failure ${index + 1}`),
        ]),
      ),
    );
    const adapter = new ProjectionAdapter();
    const sent = Promise.withResolvers<void>();
    const originalSend = adapter.sendMsg.bind(adapter);
    const send = spyOn(adapter, "sendMsg").mockImplementation(async (...args) => {
      const result = await originalSend(...args);
      sent.resolve();
      return result;
    });
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 20 };
    const scheduler = new FakeProjectionScheduler(clock);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "reconcile-repeated-retry",
      now: () => clock.now,
      scheduleTimeout: scheduler.scheduleTimeout,
    });
    try {
      createInvocation(store);

      await projector.reconcile();
      const retryTimes = [1_020, 3_020, 7_020, 15_020, 31_020, 63_020, 123_020, 183_020];
      for (const [index, retryAt] of retryTimes.entries()) {
        expect(scheduler.scheduledTimes()).toContain(retryAt);
        scheduler.advanceTo(retryAt);
        const nextRetryAt = retryTimes[index + 1];
        if (nextRetryAt !== undefined) await scheduler.whenScheduledAt(nextRetryAt);
      }
      await sent.promise;
      await projector.stop();

      expect(store.listCalls).toBe(9);
      expect(scheduler.allScheduledTimes().slice(0, retryTimes.length)).toEqual(retryTimes);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef).not.toBeNull();
    } finally {
      send.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("lets manual reconciliation preempt a pending retry without a concurrent drain", async () => {
    const dbPath = tempDbPath("workflow-reconcile-manual-retry");
    const store = new ReconciliationFailureStore(
      dbPath,
      new Map([[1, new Error("manual reconciliation retry")]]),
    );
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 20 };
    const scheduler = new FakeProjectionScheduler(clock);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "reconcile-manual-retry",
      now: () => clock.now,
      scheduleTimeout: scheduler.scheduleTimeout,
    });
    try {
      createInvocation(store);
      await projector.reconcile();
      expect(scheduler.scheduledTimes()).toContain(1_020);

      clock.now = 100;
      await projector.reconcile();
      scheduler.advanceTo(1_020);

      expect(store.listCalls).toBe(2);
      expect(adapter.sends).toBe(1);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef).not.toBeNull();
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reports reconciliation Panic once without scheduling a retry", async () => {
    const dbPath = tempDbPath("workflow-reconcile-panic");
    const panic = new Panic({ message: "reconciliation read panic" });
    const store = new ReconciliationFailureStore(dbPath, new Map([[1, panic]]));
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 20 };
    const scheduler = new FakeProjectionScheduler(clock);
    const reported = Promise.withResolvers<Panic>();
    let reportCount = 0;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "reconcile-panic",
      now: () => clock.now,
      scheduleTimeout: scheduler.scheduleTimeout,
      reportFatalPanic: (fatalPanic) => {
        reportCount += 1;
        reported.resolve(fatalPanic);
      },
    });
    try {
      createInvocation(store);
      await projector.reconcile();

      expect(await reported.promise).toBe(panic);
      expect(reportCount).toBe(1);
      expect(store.listCalls).toBe(1);
      expect(scheduler.scheduledTimes()).toEqual([]);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("cancels a pending reconciliation retry on stop", async () => {
    const dbPath = tempDbPath("workflow-reconcile-stop-retry");
    const store = new ReconciliationFailureStore(
      dbPath,
      new Map([[1, new Error("stopped reconciliation retry")]]),
    );
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 20 };
    const scheduler = new FakeProjectionScheduler(clock);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "reconcile-stop-retry",
      now: () => clock.now,
      scheduleTimeout: scheduler.scheduleTimeout,
    });
    try {
      createInvocation(store);
      await projector.reconcile();
      expect(scheduler.scheduledTimes()).toContain(1_020);

      await projector.stop();
      scheduler.advanceTo(1_020);
      await projector.reconcile();

      expect(store.listCalls).toBe(1);
      expect(adapter.sends).toBe(0);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it.each([
    ["discord", "platform"],
    ["discord", "session"],
    ["github", "platform"],
    ["github", "session"],
  ] as const)(
    "repairs a persisted %s binding ref %s mismatch and does not duplicate after restart",
    async (platform, mismatch) => {
      const dbPath = tempDbPath(`workflow-binding-${mismatch}-mismatch-${platform}`);
      let store = new DurableWorkflowStore(dbPath);
      const discordAdapter = new ProjectionAdapter("discord");
      const githubAdapter = new ProjectionAdapter("github");
      const targetAdapter = platform === "discord" ? discordAdapter : githubAdapter;
      const otherAdapter = platform === "discord" ? githubAdapter : discordAdapter;
      const bus = createLilacBus(new CapturingRawBus());
      let projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: combinedProjectionPorts(discordAdapter, githubAdapter),
        subscriptionId: `binding-${mismatch}-mismatch-${platform}`,
        now: () => 20,
      });
      const mismatchedRef: MsgRef =
        mismatch === "platform"
          ? platform === "discord"
            ? { platform: "github", channelId: "channel-1", messageId: "42" }
            : { platform: "discord", channelId: "channel-1", messageId: "message-1" }
          : platform === "discord"
            ? { platform: "discord", channelId: "other-channel", messageId: "message-1" }
            : { platform: "github", channelId: "other-channel", messageId: "42" };
      try {
        createInvocation(store, { platform });
        store.upsertSurfaceBinding({
          runId: "run-1",
          target: { platform, channelId: "channel-1", replyToMessageId: "origin-1" },
          messageRef: mismatchedRef,
          lastRenderedSha256: HASH_A,
          lastError: "retry due",
          retryCount: 2,
          nextAttemptAt: 20,
          permanentFailure: null,
          createdAt: 10,
          updatedAt: 10,
        });

        const recreated = await projector.ensureInitialCard("run-1");
        expect(recreated.platform).toBe(platform);
        expect(targetAdapter.sends).toBe(1);
        expect(otherAdapter.sends).toBe(0);
        expect(otherAdapter.reads).toBe(0);
        expect(otherAdapter.edits).toBe(0);
        expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
          messageRef: recreated,
          lastError: null,
          retryCount: 0,
          nextAttemptAt: null,
        });
        expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.lastRenderedSha256).not.toBe(
          HASH_A,
        );

        await projector.stop();
        store.close();
        store = new DurableWorkflowStore(dbPath);
        projector = createWorkflowProgressProjectorForTest({
          bus,
          store,
          ports: combinedProjectionPorts(discordAdapter, githubAdapter),
          subscriptionId: `binding-${mismatch}-mismatch-${platform}-restarted`,
          now: () => 30,
        });
        await projector.start();

        expect(targetAdapter.sends).toBe(1);
        expect(otherAdapter.sends).toBe(0);
        expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef).toEqual(recreated);
      } finally {
        await projector.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    },
  );
  it("repairs stale terminal cards, skips clean history, and retries failed bindings", async () => {
    const dbPath = tempDbPath("workflow-terminal-reconcile");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "terminal-reconcile",
      now: () => now,
      coalesceMs: 0,
      minEditIntervalMs: 0,
      retryIntervalMs: 5,
    });
    try {
      createInvocation(store);
      await projector.ensureInitialCard("run-1");
      expect(
        store.transitionRun({
          runId: "run-1",
          from: "queued",
          to: "cancelled",
          now: 30,
        }),
      ).toBe(true);
      now = 40;
      await projector.reconcile();
      expect(adapter.reads).toBe(1);
      expect(adapter.contents.at(-1)?.text).toContain("**Cancelled**");
      await projector.reconcile();
      expect(adapter.reads).toBe(1);
      const binding = workflowStoreValue(store.getSurfaceBinding("run-1"));
      if (!binding) throw new Error("Missing terminal surface binding");
      store.upsertSurfaceBinding({
        ...binding,
        lastError: "transient terminal projection failure",
        retryCount: 1,
        nextAttemptAt: 100,
        updatedAt: 99,
      });
      now = 100;
      await projector.start();
      for (
        let attempt = 0;
        attempt < 100 && workflowStoreValue(store.getSurfaceBinding("run-1"))?.lastError !== null;
        attempt += 1
      ) {
        // test-wait-justification: polls for the projector's independently scheduled persisted retry
        await Bun.sleep(5);
      }
      expect(adapter.reads).toBe(2);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
      });
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("persists projection failures and retries with backoff", async () => {
    const dbPath = tempDbPath("workflow-projector-retry");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 100 };
    const scheduler = new FakeProjectionScheduler(clock);
    const sendStarted = Promise.withResolvers<void>();
    const originalSend = adapter.sendMsg.bind(adapter);
    const send = spyOn(adapter, "sendMsg").mockImplementation(async (...args) => {
      const result = await originalSend(...args);
      if (result.status === "ok") sendStarted.resolve();
      return result;
    });
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "retry",
      now: () => clock.now,
      scheduleTimeout: scheduler.scheduleTimeout,
      coalesceMs: 0,
      minEditIntervalMs: 0,
      retryIntervalMs: 5,
    });
    try {
      createInvocation(store);
      adapter.failNextSend = true;
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "initial progress card could not be created",
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: null,
        retryCount: 1,
        nextAttemptAt: 1100,
        lastError: "transient surface failure",
      });
      await projector.start();
      expect(scheduler.scheduledTimes()).toContain(1_100);
      scheduler.advanceTo(1_100);
      await sendStarted.promise;
      await projector.stop();
      expect(adapter.sends).toBe(1);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        retryCount: 0,
        nextAttemptAt: null,
        lastError: null,
      });
    } finally {
      send.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves unrecognized non-Error surface rejections as defects", async () => {
    const dbPath = tempDbPath("workflow-projector-opaque-rejection");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "opaque-rejection",
      now: () => 100,
    });
    try {
      createInvocation(store);
      const rejection = "provider-secret-rejection";
      adapter.sendRejection = { value: rejection };

      await expect(projector.ensureInitialCard("run-1")).rejects.toBe(rejection);
      const binding = workflowStoreValue(store.getSurfaceBinding("run-1"));
      expect(binding?.lastError).toBeNull();
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("clears a missing edit target and recreates the card on the next projection", async () => {
    const dbPath = tempDbPath("workflow-projector-missing-edit");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "missing-edit",
      now: () => now,
    });
    try {
      createInvocation(store);
      const firstRef = await projector.ensureInitialCard("run-1");
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: 21 })?.state).toBe(
        "running",
      );
      adapter.failNextEditNotFound = true;
      now = 30;
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "initial progress card could not be created",
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: null,
        lastRenderedSha256: null,
        retryCount: 1,
        lastError: "Workflow progress message was not found",
      });

      now = 1_030;
      const recreated = await projector.ensureInitialCard("run-1");
      expect(recreated.messageId).not.toBe(firstRef.messageId);
      expect(adapter.sends).toBe(2);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("recovers persisted partial GitHub creation at its deadline after hard restart", async () => {
    const dbPath = tempDbPath("workflow-projector-created-outcome");
    let store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    let sends = 0;
    let edits = 0;
    const sentContents: ContentOpts[] = [];
    const editedContents: WorkflowProgressContent[] = [];
    const createdRef = {
      platform: "github" as const,
      channelId: "channel-1",
      messageId: "created-card",
    };
    const port: SurfaceWorkflowProgressPort<"github"> = {
      configurationRevision: "test-github-v1",
      checkMessage: async () => Result.ok("found"),
      send: async (input) => {
        sends += 1;
        sentContents.push(input.content);
        return sends === 1
          ? Result.err({ kind: "created", ref: createdRef })
          : Result.ok(createdRef);
      },
      edit: async (_target, content) => {
        edits += 1;
        editedContents.push(content);
        return Result.ok(undefined);
      },
    };
    let projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: new Map([
        ["github", { platform: "github", protocol: githubSurfaceProtocol, port } as const],
      ]),
      subscriptionId: "created-outcome",
      now: () => now,
    });
    try {
      createInvocation(store, { platform: "github" });
      await expect(projector.ensureInitialCard("run-1")).resolves.toEqual(createdRef);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: createdRef,
        lastRenderedSha256: null,
        retryCount: 1,
        lastError: "Workflow progress message was created but could not be fully rendered",
      });
      expect(sends).toBe(1);
      expect(edits).toBe(0);
      const initialToken = contentActionToken(sentContents.at(-1), "Pause");
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(sha256(initialToken)))
          ?.expectedMessageRef,
      ).toBeNull();

      await projector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: createdRef,
        lastRenderedSha256: null,
        retryCount: 1,
        nextAttemptAt: 1_020,
        lastError: "Workflow progress message was created but could not be fully rendered",
      });

      now = 21;
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: new Map([
          ["github", { platform: "github", protocol: githubSurfaceProtocol, port } as const],
        ]),
        subscriptionId: "created-outcome-restarted",
        now: () => now,
      });
      await projector.start();
      expect(sends).toBe(1);
      expect(edits).toBe(0);
      now = 1_020;
      await projector.reconcile();
      expect(edits).toBe(1);
      const restartedContent = editedContents.at(-1);
      const restartedToken = contentActionToken(restartedContent, "Pause");
      expect(restartedToken).not.toBe(initialToken);
      const restartedHash = sha256(
        JSON.stringify({
          text: restartedContent?.text,
          actions: restartedContent?.actions,
          workflow: restartedContent?.workflow,
          revision: HASH_A,
        }),
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: createdRef,
        lastRenderedSha256: restartedHash,
        retryCount: 0,
        nextAttemptAt: null,
        lastError: null,
      });
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(sha256(restartedToken)))
          ?.expectedMessageRef,
      ).toEqual(createdRef);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(restartedToken),
            platform: "github",
            userId: "user-1",
            messageRef: { ...createdRef, messageId: "different-card" },
            now: 22,
          }),
        ),
      ).toBe("unauthorized");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(restartedToken),
            platform: "github",
            userId: "user-1",
            messageRef: createdRef,
            now: 23,
          }),
        ),
      ).toBe("applied");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("renders pause, resume, cancel, and terminal card states", async () => {
    const dbPath = tempDbPath("workflow-controls");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "controls",
      now: () => now,
    });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
      await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Resume",
        "Cancel",
      ]);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Resume")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Cancel")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
      await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions).toEqual([]);
      expect(adapter.contents.at(-1)?.text).toContain("**Cancelled**");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves workflow progress actions for GitHub cards", async () => {
    const dbPath = tempDbPath("workflow-github-controls");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter("github");
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "github-controls",
      now: () => 20,
    });
    try {
      createInvocation(store, { platform: "github" });
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "github",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("does not republish or reproject completed durable action outbox entries after restart", async () => {
    const dbPath = tempDbPath("workflow-action-outbox");
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const initialProjector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-initial",
      now: () => 20,
    });
    let resolver: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    try {
      createInvocation(store);
      const messageRef = await initialProjector.ensureInitialCard("run-1");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      resolver = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "outbox-resolver-first",
        now: () => 30,
      });
      expect(raw.publishedOutboxIds).toHaveLength(2);
      await resolver.stop();
      resolver = null;
      const projecting = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: "outbox-projector-first",
        now: () => 30,
      });
      await projecting.start();
      expect([...workflowStoreValue(store.listPendingActionOutboxEvents(30))]).toEqual([]);
      expect([...workflowStoreValue(store.listPendingActionOutboxProjections())]).toEqual([]);
      await projecting.stop();
      await initialProjector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      resolver = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "outbox-resolver-second",
        now: () => 40,
      });
      const restartedProjector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: "outbox-projector-second",
        now: () => 40,
      });
      await restartedProjector.start();
      expect(raw.publishedOutboxIds).toHaveLength(2);
      expect(new Set(raw.publishedOutboxIds).size).toBe(2);
      expect([...workflowStoreValue(store.listPendingActionOutboxProjections())]).toEqual([]);
      await restartedProjector.stop();
    } finally {
      await resolver?.stop();
      await initialProjector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("rolls back state, consumption, and both outbox rows when SQLite rejects the second row", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-atomic-driver-failure");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-atomic-driver-failure",
      now: () => 20,
    });
    const inspection = new Database(dbPath);
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      const tokenSha256 = sha256(actionToken(adapter, "Pause"));
      inspection.run(`CREATE TRIGGER reject_workflow_progress_outbox
        BEFORE INSERT ON workflow_action_outbox
        WHEN NEW.event_type = 'evt.workflow.progress.requested'
        BEGIN
          SELECT RAISE(ABORT, 'reject deterministic second outbox row');
        END`);
      const applied = store.applySurfaceAction({
        tokenSha256,
        platform: "discord",
        userId: "user-1",
        messageRef,
        now: 21,
      });
      expect(applied.status).toBe("error");
      if (applied.status === "error") {
        expect(applied.error._tag).toBe("DurableWorkflowSqliteDriverFailure");
      }
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("queued");
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256))?.consumedAt,
      ).toBeNull();
      expect([...workflowStoreValue(store.listPendingActionOutboxEvents(100))]).toEqual([]);
    } finally {
      inspection.close();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves Panic identity and rolls back a surface action before consumption and outbox", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-atomic-panic");
    const panic = new Panic({ message: "surface action atomicity defect" });
    const store = new DurableWorkflowStore(dbPath, {
      testHooks: {
        afterSurfaceActionStateChange: () => {
          throw panic;
        },
      },
    });
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-atomic-panic",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      const tokenSha256 = sha256(actionToken(adapter, "Pause"));
      expect(() =>
        store.applySurfaceAction({
          tokenSha256,
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 21,
        }),
      ).toThrow(panic);
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("queued");
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256))?.consumedAt,
      ).toBeNull();
      expect([...workflowStoreValue(store.listPendingActionOutboxEvents(100))]).toEqual([]);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("records external action outbox publication failures for durable retry", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-publication-failure");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-publication-failure-projector",
      now: () => 20,
    });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    let resolver: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      raw.outboxPublicationFailure = new Error("outbox transport unavailable");
      resolver = await startWorkflowActionResolver({
        bus,
        store,
        subscriptionId: "outbox-publication-failure",
        now: () => 30,
      });
      expect(workflowStoreValue(store.listPendingActionOutboxEvents(10000))).toHaveLength(2);
      expect(raw.publishedOutboxIds).toEqual([]);
      expect(
        workflowStoreValue(store.listPendingActionOutboxEvents(10000)).every(
          (entry) => entry.publishedAt === null,
        ),
      ).toBe(true);
      expect(workflowStoreValue(store.listPendingActionOutboxEvents(10000))[0]).toMatchObject({
        attemptCount: 1,
        lastError: "Workflow action outbox publication failed",
      });
    } finally {
      warning.mockRestore();
      await resolver?.stop();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("preserves Panic identity from action outbox publication", async () => {
    const dbPath = tempDbPath("workflow-action-outbox-panic");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "outbox-panic-projector",
      now: () => 20,
    });
    const panic = new Panic({ message: "outbox publication defect" });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      raw.outboxPublicationFailure = panic;
      await expect(
        startWorkflowActionResolver({
          bus,
          store,
          subscriptionId: "outbox-panic",
          now: () => 30,
        }),
      ).rejects.toBe(panic);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reports projection timer Panic to the fatal supervisor", async () => {
    const dbPath = tempDbPath("workflow-projection-timer-panic");
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    const panic = new Panic({ message: "projection timer defect" });
    const firstReport = Promise.withResolvers<void>();
    const secondAttempt = Promise.withResolvers<void>();
    const reported: Panic[] = [];
    let attempts = 0;
    const getRun = spyOn(store, "getRun").mockImplementation(() => {
      attempts += 1;
      if (attempts === 2) secondAttempt.resolve();
      throw panic;
    });
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: new Map(),
      subscriptionId: "projection-timer-panic",
      coalesceMs: 0,
      minEditIntervalMs: 0,
      reportFatalPanic: (fatalPanic) => {
        reported.push(fatalPanic);
        firstReport.resolve();
      },
    });
    try {
      projector.requestProjection("run-panic");
      await firstReport.promise;
      projector.requestProjection("run-panic");
      await secondAttempt.promise;
      await Promise.resolve();
      expect(reported).toEqual([panic]);
    } finally {
      getRun.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("reports detached action outbox projection Panic to the fatal supervisor", async () => {
    const dbPath = tempDbPath("workflow-projection-outbox-panic");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const panic = new Panic({ message: "projection outbox defect" });
    const reported = Promise.withResolvers<Panic>();
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "projection-outbox-panic",
      now: () => 20,
      retryIntervalMs: 1,
      reportFatalPanic: reported.resolve,
    });
    try {
      createInvocation(store);
      const messageRef = await projector.ensureInitialCard("run-1");
      await projector.start();
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform: "discord",
            userId: "user-1",
            messageRef,
            now: 21,
          }),
        ),
      ).toBe("applied");
      adapter.editFailure = panic;

      await expect(reported.promise).resolves.toBe(panic);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("adapts action and projector subscription lifecycle Result failures", async () => {
    const dbPath = tempDbPath("workflow-subscription-result-adapters");
    const store = new DurableWorkflowStore(dbPath);
    const startFailureRaw = new CapturingRawBus();
    Reflect.deleteProperty(startFailureRaw, "subscribe");
    const startFailureBus = createLilacBus(startFailureRaw);
    const projector = createWorkflowProgressProjectorForTest({
      bus: startFailureBus,
      store,
      ports: new Map(),
      subscriptionId: "projector-start-result-failure",
    });
    try {
      await expect(
        startWorkflowActionResolver({
          bus: startFailureBus,
          store,
          subscriptionId: "action-start-result-failure",
        }),
      ).rejects.toMatchObject({ _tag: "EventDeliveryStartFailed" });
      await expect(projector.start()).rejects.toMatchObject({ _tag: "EventDeliveryStartFailed" });
      const stopFailureRaw = new CapturingRawBus();
      const stopFailureBus = createLilacBus(stopFailureRaw);
      const actionResolver = await startWorkflowActionResolver({
        bus: stopFailureBus,
        store,
        subscriptionId: "action-stop-result-failure",
      });
      const stoppingProjector = createWorkflowProgressProjectorForTest({
        bus: stopFailureBus,
        store,
        ports: new Map(),
        subscriptionId: "projector-stop-result-failure",
      });
      await stoppingProjector.start();
      stopFailureRaw.subscriptionStopFailure = new Error("subscription cleanup unavailable");
      await expect(actionResolver.stop()).rejects.toMatchObject({
        _tag: "EventDeliveryStopFailed",
      });
      await expect(stoppingProjector.stop()).rejects.toMatchObject({
        _tag: "EventDeliveryStopFailed",
      });
      await stopFailureBus.close();
    } finally {
      await startFailureBus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("commits actions with mismatched refs or unregistered platforms as malformed", async () => {
    const dbPath = tempDbPath("workflow-malformed-action-commit");
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const resolver = await startWorkflowActionResolver({
      bus,
      store,
      subscriptionId: "malformed-action-commit",
      now: () => 20,
    });
    try {
      await bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
        actionId: "malformed-action-token",
        platform: "discord",
        userId: "user-1",
        messageRef: {
          platform: "github",
          channelId: "issue-1",
          messageId: "comment-1",
        },
        ts: 20,
      });
      await bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
        actionId: "unregistered-action-token",
        platform: "slack",
        userId: "user-1",
        messageRef: {
          platform: "slack",
          channelId: "channel-1",
          messageId: "message-1",
        },
        ts: 20,
      });
      expect(raw.commits).toBe(2);
    } finally {
      warning.mockRestore();
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
  it("waits for an in-flight projection during shutdown", async () => {
    const dbPath = tempDbPath("workflow-projector-shutdown");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new BlockingProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: "shutdown",
    });
    try {
      createInvocation(store);
      const projection = projector.ensureInitialCard("run-1");
      await adapter.sendStarted;
      let stopped = false;
      const stopping = projector.stop().then(() => {
        stopped = true;
      });
      // test-wait-justification: verifies shutdown remains pending while a real in-flight projection is blocked
      await Bun.sleep(10);
      expect(stopped).toBe(false);
      adapter.release();
      await projection;
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      adapter.release();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});

describe.each(["discord", "github"] as const)("%s workflow progress port contract", (platform) => {
  it("creates, edits, recreates not-found cards, and recovers partial creation across restart", async () => {
    const dbPath = tempDbPath(`workflow-port-lifecycle-${platform}`);
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    let projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-lifecycle-${platform}`,
      now: () => now,
    });
    try {
      createInvocation(store, { platform });
      adapter.partialNextSend = true;
      const partialRef = await projector.ensureInitialCard("run-1");
      expect(partialRef).toEqual({
        platform,
        channelId: "channel-1",
        messageId: "partial-card",
      });
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: partialRef,
        retryCount: 1,
        permanentFailure: null,
      });

      await projector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: `workflow-port-lifecycle-restart-${platform}`,
        now: () => now,
      });
      await projector.start();
      expect(adapter.sends).toBe(0);
      expect(adapter.edits).toBe(0);
      now = 1_020;
      await projector.reconcile();
      expect(adapter.edits).toBe(1);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        messageRef: partialRef,
        retryCount: 0,
        nextAttemptAt: null,
        permanentFailure: null,
      });

      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: ++now })).not.toBeNull();
      adapter.failNextEditNotFound = true;
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "initial progress card could not be created",
      );
      now += 1_000;
      const recreated = await projector.ensureInitialCard("run-1");
      expect(recreated.messageId).not.toBe(partialRef.messageId);
      expect(adapter.sends).toBe(1);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it.each(["rate-limited", "unavailable"] as const)(
    "retries %s failures with bounded backoff",
    async (reason) => {
      const dbPath = tempDbPath(`workflow-port-retry-${platform}-${reason}`);
      const store = new DurableWorkflowStore(dbPath);
      const adapter = new ProjectionAdapter(platform);
      const send = spyOn(adapter, "sendMsg");
      const bus = createLilacBus(new CapturingRawBus());
      const clock = { now: 100 };
      const scheduler = new FakeProjectionScheduler(clock);
      const projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: `workflow-port-retry-${platform}-${reason}`,
        now: () => clock.now,
        scheduleTimeout: scheduler.scheduleTimeout,
      });
      try {
        createInvocation(store, { platform });
        adapter.sendFailure =
          reason === "rate-limited"
            ? new SurfaceRateLimited({
                platform,
                operation: "send-message",
                retryAfterMs: 5_000,
                message: "surface rate limited",
              })
            : new SurfaceUnavailable({
                platform,
                operation: "send-message",
                message: "surface unavailable",
              });
        await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
          "initial progress card could not be created",
        );
        const expectedAttemptAt = reason === "rate-limited" ? 5_100 : 1_100;
        expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
          retryCount: 1,
          nextAttemptAt: expectedAttemptAt,
          permanentFailure: null,
        });
        expect(scheduler.scheduledTimes()).toContain(expectedAttemptAt);
        adapter.sendFailure = null;
        clock.now = expectedAttemptAt - 1;
        await expect(projector.ensureInitialCard("run-1")).rejects.toThrow("retry is deferred");
        expect(adapter.sends).toBe(0);
        expect(send).toHaveBeenCalledTimes(1);
        clock.now = expectedAttemptAt;
        await expect(projector.ensureInitialCard("run-1")).resolves.toMatchObject({ platform });
        expect(send).toHaveBeenCalledTimes(2);
      } finally {
        send.mockRestore();
        await projector.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    },
  );

  it("caps a huge provider retry deadline and schedules one safe host timer", async () => {
    const dbPath = tempDbPath(`workflow-port-huge-retry-${platform}`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const bus = createLilacBus(new CapturingRawBus());
    const clock = { now: 100 };
    const scheduler = new FakeProjectionScheduler(clock);
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-huge-retry-${platform}`,
      now: () => clock.now,
      scheduleTimeout: scheduler.scheduleTimeout,
    });
    try {
      createInvocation(store, { platform });
      adapter.sendFailure = new SurfaceRateLimited({
        platform,
        operation: "send-message",
        retryAfterMs: Number.MAX_SAFE_INTEGER,
        message: "surface rate limited",
      });

      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "initial progress card could not be created",
      );

      const expectedAttemptAt = clock.now + 24 * 60 * 60 * 1_000;
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.nextAttemptAt).toBe(
        expectedAttemptAt,
      );
      expect(Number.isInteger(expectedAttemptAt)).toBe(true);
      expect(scheduler.scheduledTimes()).toEqual([expectedAttemptAt]);
      expect(expectedAttemptAt - clock.now).toBeLessThan(2_147_483_647);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("honors a persisted retry deadline across startup, outbox, and event projection", async () => {
    const dbPath = tempDbPath(`workflow-port-deadline-${platform}`);
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const bus = createLilacBus(new CapturingRawBus());
    const initial = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-deadline-initial-${platform}`,
      now: () => 100,
    });
    let projector = initial;
    try {
      createInvocation(store, { platform });
      const messageRef = await initial.ensureInitialCard("run-1");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(actionToken(adapter, "Pause")),
            platform,
            userId: "user-1",
            messageRef,
            now: 101,
          }),
        ),
      ).toBe("applied");
      const binding = workflowStoreValue(store.getSurfaceBinding("run-1"));
      if (!binding) throw new Error("Missing deadline binding");
      store.upsertSurfaceBinding({
        ...binding,
        lastError: "retry later",
        retryCount: 2,
        nextAttemptAt: 5_000,
        updatedAt: 102,
      });
      await initial.stop();
      store.close();

      store = new DurableWorkflowStore(dbPath);
      const clock = { now: 200 };
      const scheduler = new FakeProjectionScheduler(clock);
      const editStarted = Promise.withResolvers<void>();
      const originalEdit = adapter.editMsg.bind(adapter);
      const edit = spyOn(adapter, "editMsg").mockImplementation(async (ref, content) => {
        const result = await originalEdit(ref, content);
        editStarted.resolve();
        return result;
      });
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: `workflow-port-deadline-restart-${platform}`,
        now: () => clock.now,
        scheduleTimeout: scheduler.scheduleTimeout,
        retryIntervalMs: 1_000_000,
      });
      await projector.start();
      expect(adapter.reads).toBe(0);
      expect(adapter.edits).toBe(0);
      expect(adapter.sends).toBe(1);
      expect(scheduler.scheduledTimes()).toEqual([5_000]);
      expect(workflowStoreValue(store.listPendingActionOutboxProjections())).toEqual([]);

      await bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: "run-1",
        revisionId: "revision-1",
        reason: "reconcile",
        ts: 300,
      });
      expect(adapter.reads).toBe(0);
      expect(adapter.edits).toBe(0);
      expect(scheduler.scheduledTimes()).toEqual([5_000]);

      scheduler.advanceTo(4_999);
      expect(adapter.edits).toBe(0);
      scheduler.advanceTo(5_000);
      await editStarted.promise;
      expect(edit).toHaveBeenCalledTimes(1);
      edit.mockRestore();
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("durably gates unsupported failures across events, terminal restart, and unblocks on configuration change", async () => {
    const dbPath = tempDbPath(`workflow-port-permanent-${platform}`);
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const send = spyOn(adapter, "sendMsg");
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    let projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-permanent-${platform}`,
      now: () => now,
      coalesceMs: 0,
      minEditIntervalMs: 0,
    });
    try {
      createInvocation(store, { platform });
      adapter.sendFailure = new SurfaceOperationUnsupported({
        platform,
        operation: "send-message",
        message: "declared workflow send is unsupported",
      });
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "declared workflow send is unsupported",
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        nextAttemptAt: null,
        permanentFailure: {
          operation: "send",
          reason: "unsupported",
        },
      });
      expect(send).toHaveBeenCalledTimes(1);
      projector.requestProjection("run-1");
      // test-wait-justification: crosses the real zero-delay event projection to verify the durable gate
      await Bun.sleep(10);
      await projector.reconcile();
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        store.transitionRun({ runId: "run-1", from: "queued", to: "cancelled", now: 30 }),
      ).toBe(true);

      await projector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      now = 40;
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: `workflow-port-permanent-restart-${platform}`,
        now: () => now,
      });
      await projector.start();
      expect(send).toHaveBeenCalledTimes(1);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.permanentFailure).not.toBeNull();

      await projector.stop();
      adapter.sendFailure = null;
      const revisedPorts = projectionPorts(adapter);
      const currentPort = revisedPorts.get(platform);
      if (!currentPort) throw new Error("Missing workflow progress port");
      revisedPorts.set(platform, {
        ...currentPort,
        port: {
          ...currentPort.port,
          configurationRevision: `${currentPort.port.configurationRevision}-reconfigured`,
        },
      } as RegisteredSurfaceWorkflowProgressRegistration);
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: revisedPorts,
        subscriptionId: `workflow-port-permanent-reconfigured-${platform}`,
        now: () => ++now,
      });
      await projector.start();
      expect(send).toHaveBeenCalledTimes(2);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        permanentFailure: null,
        nextAttemptAt: null,
      });
    } finally {
      send.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("reconciles a permanent gate recorded after terminalization when configuration changes", async () => {
    const dbPath = tempDbPath(`workflow-port-terminal-gate-${platform}`);
    let store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const edit = spyOn(adapter, "editMsg");
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    let projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-terminal-gate-${platform}`,
      now: () => now,
    });
    try {
      createInvocation(store, { platform });
      await projector.ensureInitialCard("run-1");
      expect(
        store.transitionRun({ runId: "run-1", from: "queued", to: "cancelled", now: 30 }),
      ).toBe(true);
      now = 40;
      adapter.editOperationFailure = new SurfaceOperationUnsupported({
        platform,
        operation: "edit-message",
        message: "terminal edit unsupported",
      });
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "terminal edit unsupported",
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        updatedAt: 40,
        permanentFailure: { failedAt: 40, reason: "unsupported" },
      });
      expect(edit).toHaveBeenCalledTimes(1);

      await projector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      now = 50;
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: `workflow-port-terminal-gate-restart-${platform}`,
        now: () => now,
      });
      await projector.start();
      expect(edit).toHaveBeenCalledTimes(1);
      await projector.stop();

      adapter.editOperationFailure = null;
      const revisedPorts = projectionPorts(adapter);
      const currentPort = revisedPorts.get(platform);
      if (!currentPort) throw new Error("Missing terminal workflow port");
      revisedPorts.set(platform, {
        ...currentPort,
        port: {
          ...currentPort.port,
          configurationRevision: `${currentPort.port.configurationRevision}-terminal-fix`,
        },
      } as RegisteredSurfaceWorkflowProgressRegistration);
      projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: revisedPorts,
        subscriptionId: `workflow-port-terminal-gate-fixed-${platform}`,
        now: () => ++now,
      });
      await projector.start();
      expect(edit).toHaveBeenCalledTimes(2);
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.permanentFailure).toBeNull();
    } finally {
      edit.mockRestore();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("issues fresh usable actions when a configuration revision clears a permanent gate", async () => {
    const dbPath = tempDbPath(`workflow-port-config-actions-${platform}`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const basePorts = projectionPorts(adapter);
    const basePort = basePorts.get(platform);
    if (!basePort) throw new Error("Missing configurable workflow port");
    const configurablePort = {
      ...basePort,
      port: { ...basePort.port },
    } as RegisteredSurfaceWorkflowProgressRegistration;
    const ports = new Map<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressRegistration>(
      [[platform, configurablePort]],
    );
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports,
      subscriptionId: `workflow-port-config-actions-${platform}`,
      now: () => now,
    });
    try {
      createInvocation(store, { platform });
      const messageRef = await projector.ensureInitialCard("run-1");
      const initialToken = actionToken(adapter, "Pause");
      const initialAction = workflowStoreValue(
        store.getSurfaceActionByTokenSha256(sha256(initialToken)),
      );
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: ++now })).not.toBeNull();
      adapter.editOperationFailure = new SurfaceOperationUnsupported({
        platform,
        operation: "edit-message",
        message: "edit contract unavailable",
      });
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "edit contract unavailable",
      );

      adapter.editOperationFailure = null;
      ports.set(platform, {
        ...configurablePort,
        port: {
          ...configurablePort.port,
          configurationRevision: `${configurablePort.port.configurationRevision}-fixed`,
        },
      } as RegisteredSurfaceWorkflowProgressRegistration);
      now += 1;
      await projector.ensureInitialCard("run-1");
      const revisedToken = actionToken(adapter, "Pause");
      expect(revisedToken).not.toBe(initialToken);
      const revisedAction = workflowStoreValue(
        store.getSurfaceActionByTokenSha256(sha256(revisedToken)),
      );
      expect(revisedAction?.expectedMessageRef).toEqual(messageRef);
      expect(revisedAction?.expiresAt).toBeGreaterThan(initialAction?.expiresAt ?? 0);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(revisedToken),
            platform,
            userId: "user-1",
            messageRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("unblocks a permanent gate when the persisted target snapshot changes and repairs it to the run target", async () => {
    const dbPath = tempDbPath(`workflow-port-target-change-${platform}`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-target-change-${platform}`,
      now: () => now,
    });
    try {
      createInvocation(store, { platform });
      const firstRef = await projector.ensureInitialCard("run-1");
      const firstToken = actionToken(adapter, "Pause");
      const firstAction = workflowStoreValue(
        store.getSurfaceActionByTokenSha256(sha256(firstToken)),
      );
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: ++now })).not.toBeNull();
      adapter.editOperationFailure = new SurfaceOperationUnsupported({
        platform,
        operation: "edit-message",
        message: "unsupported before target repair",
      });
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow();
      const blocked = workflowStoreValue(store.getSurfaceBinding("run-1"));
      if (!blocked) throw new Error("Missing blocked binding");
      const injectedToken = `injected-action-${platform}`;
      expect(
        store.createSurfaceAction({
          actionId: `injected-${platform}`,
          tokenSha256: sha256(injectedToken),
          runId: "run-1",
          kind: "pause",
          expectedPlatform: platform,
          expectedUserId: "user-1",
          expectedMessageRef: firstRef,
          expiresAt: now + 10_000,
          consumedAt: null,
          consumedByPlatform: null,
          consumedByUserId: null,
          createdAt: now,
        }),
      ).toBe(true);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(injectedToken),
            platform,
            userId: "user-1",
            messageRef: firstRef,
            now: ++now,
          }),
        ),
      ).toBe("unauthorized");
      store.upsertSurfaceBinding({
        ...blocked,
        target: { ...blocked.target, channelId: "stale-channel" },
      });
      adapter.editOperationFailure = null;
      now += 1;
      await expect(projector.ensureInitialCard("run-1")).resolves.toMatchObject({
        platform,
        channelId: "channel-1",
      });
      const repairedRef = workflowStoreValue(store.getSurfaceBinding("run-1"))?.messageRef;
      if (!repairedRef) throw new Error("Missing repaired binding ref");
      const repairedToken = actionToken(adapter, "Pause");
      expect(repairedToken).not.toBe(firstToken);
      const repairedAction = workflowStoreValue(
        store.getSurfaceActionByTokenSha256(sha256(repairedToken)),
      );
      expect(repairedAction?.expectedMessageRef).toEqual(repairedRef);
      expect(repairedAction?.expiresAt).toBeGreaterThan(firstAction?.expiresAt ?? 0);
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(firstToken),
            platform,
            userId: "user-1",
            messageRef: firstRef,
            now: ++now,
          }),
        ),
      ).toBe("expired");
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256: sha256(repairedToken),
            platform,
            userId: "user-1",
            messageRef: repairedRef,
            now: ++now,
          }),
        ),
      ).toBe("applied");
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))).toMatchObject({
        target: { platform, channelId: "channel-1" },
        permanentFailure: null,
      });
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("authorizes actions only for the correlated identity, platform, channel, and message and commits outbox atomically", async () => {
    const dbPath = tempDbPath(`workflow-port-actions-${platform}`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const bus = createLilacBus(new CapturingRawBus());
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-actions-${platform}`,
      now: () => 20,
    });
    try {
      createInvocation(store, { platform });
      const messageRef = await projector.ensureInitialCard("run-1");
      const tokenSha256 = sha256(actionToken(adapter, "Pause"));
      const otherPlatform = platform === "discord" ? "github" : "discord";
      const wrongPlatformRef: MsgRef =
        otherPlatform === "discord"
          ? { platform: "discord", channelId: "channel-1", messageId: messageRef.messageId }
          : { platform: "github", channelId: "channel-1", messageId: messageRef.messageId };
      const attempts = [
        { platform, userId: "wrong-user", messageRef },
        { platform: otherPlatform, userId: "user-1", messageRef: wrongPlatformRef },
        { platform, userId: "user-1", messageRef: { ...messageRef, channelId: "wrong-channel" } },
        { platform, userId: "user-1", messageRef: { ...messageRef, messageId: "wrong-message" } },
      ] as const;
      for (const attempt of attempts) {
        expect(
          appliedSurfaceActionStatus(
            store.applySurfaceAction({ ...attempt, tokenSha256, now: 21 }),
          ),
        ).toBe("unauthorized");
      }
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256))?.consumedAt,
      ).toBeNull();
      expect(
        appliedSurfaceActionStatus(
          store.applySurfaceAction({
            tokenSha256,
            platform,
            userId: "user-1",
            messageRef,
            now: 22,
          }),
        ),
      ).toBe("applied");
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("paused");
      expect(workflowStoreValue(store.listPendingActionOutboxEvents(22))).toHaveLength(2);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it.each(["cross-session", "cross-platform"] as const)(
    "preserves an independently selected %s progress target",
    async (targetKind) => {
      const dbPath = tempDbPath(`workflow-port-independent-${platform}-${targetKind}`);
      const store = new DurableWorkflowStore(dbPath);
      const adapter = new ProjectionAdapter(platform);
      const bus = createLilacBus(new CapturingRawBus());
      let originPlatform: "discord" | "github" = platform;
      if (targetKind === "cross-platform") {
        originPlatform = platform === "discord" ? "github" : "discord";
      }
      const projector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: projectionPorts(adapter),
        subscriptionId: `workflow-port-independent-${platform}-${targetKind}`,
        now: () => 20,
      });
      try {
        createInvocation(store, {
          platform,
          targetChannelId: "target-channel",
          origin: {
            platform: originPlatform,
            sessionId: "origin-channel",
          },
        });
        const messageRef = await projector.ensureInitialCard("run-1");
        expect(messageRef).toMatchObject({ platform, channelId: "target-channel" });
        expect(workflowStoreValue(store.getRun("run-1"))).toMatchObject({
          origin: { client: originPlatform, sessionId: "origin-channel" },
          progressTarget: { platform, channelId: "target-channel" },
        });
        if (targetKind === "cross-platform") {
          expect(adapter.contents.at(-1)?.actions).toEqual([]);
        } else {
          const token = actionToken(adapter, "Pause");
          expect(
            appliedSurfaceActionStatus(
              store.applySurfaceAction({
                tokenSha256: sha256(token),
                platform,
                userId: "user-1",
                messageRef,
                now: 21,
              }),
            ),
          ).toBe("applied");
        }
      } finally {
        await projector.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    },
  );

  it("rolls back a permanent gate when atomic action revocation fails", async () => {
    const dbPath = tempDbPath(`workflow-port-gate-atomicity-${platform}`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter(platform);
    const bus = createLilacBus(new CapturingRawBus());
    const inspection = new Database(dbPath);
    let now = 20;
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: projectionPorts(adapter),
      subscriptionId: `workflow-port-gate-atomicity-${platform}`,
      now: () => now,
    });
    try {
      createInvocation(store, { platform });
      await projector.ensureInitialCard("run-1");
      const tokenSha256 = sha256(actionToken(adapter, "Pause"));
      const actionBefore = workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256));
      expect(store.tryClaimRun({ runId: "run-1", claimerId: "engine", now: ++now })).not.toBeNull();
      adapter.editOperationFailure = new SurfaceOperationUnsupported({
        platform,
        operation: "edit-message",
        message: "unsupported edit",
      });
      inspection.run(`CREATE TRIGGER reject_workflow_action_revocation
        BEFORE UPDATE ON workflow_surface_actions
        BEGIN
          SELECT RAISE(ABORT, 'reject atomic workflow action revocation');
        END`);

      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
        "reject atomic workflow action revocation",
      );
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.permanentFailure).toBeNull();
      expect(workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256))?.expiresAt).toBe(
        actionBefore?.expiresAt,
      );

      inspection.run("DROP TRIGGER reject_workflow_action_revocation");
      now += 1;
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow("unsupported edit");
      expect(workflowStoreValue(store.getSurfaceBinding("run-1"))?.permanentFailure).toMatchObject({
        reason: "unsupported",
      });
      expect(workflowStoreValue(store.getSurfaceActionByTokenSha256(tokenSha256))?.expiresAt).toBe(
        now,
      );
    } finally {
      inspection.close();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});

it("consumes real Redis actions and projects authorized pause, resume, and cancellation", async () => {
  const f = await createRealCoreBusFixture();
  const store = new DurableWorkflowStore(join(f.directory, "actions.sqlite"));
  const adapter = new ProjectionAdapter();
  let rendered = Promise.withResolvers<void>();
  const edit = adapter.editMsg.bind(adapter);
  adapter.editMsg = async (ref, content) => {
    const result = await edit(ref, content);
    rendered.resolve();
    return result;
  };
  const projector = createWorkflowProgressProjectorForTest({
    bus: f.bus,
    store,
    ports: projectionPorts(adapter),
    subscriptionId: "real-action-projector",
    now: () => 20,
    coalesceMs: 1,
    minEditIntervalMs: 0,
  });
  let resolver: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
  try {
    createInvocation(store);
    const messageRef = await projector.ensureInitialCard("run-1");
    await projector.start();
    resolver = await startWorkflowActionResolver({
      bus: f.bus,
      store,
      subscriptionId: "real-action-resolver",
      now: () => 21,
    });
    const publish = async (actionId: string, userId = "user-1") => {
      const receipt = requireBusOk(
        await f.bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
          actionId,
          platform: "discord",
          userId,
          messageRef,
          ts: 21,
        }),
      );
      await f.waitForCommit(receipt.cursor, "evt.adapter");
    };
    const initialPause = actionToken(adapter, "Pause");
    await publish(initialPause, "other-user");
    expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("queued");
    expect(
      workflowStoreValue(store.getSurfaceActionByTokenSha256(sha256(initialPause)))?.consumedAt,
    ).toBeNull();
    for (const [label, state] of [
      ["Pause", "paused"],
      ["Resume", "queued"],
      ["Cancel", "cancelled"],
    ] as const) {
      rendered = Promise.withResolvers<void>();
      const token = actionToken(adapter, label);
      await publish(token);
      await withBusDeadline(rendered.promise, `${label} progress projection`);
      expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe(state);
      expect(
        workflowStoreValue(store.getSurfaceActionByTokenSha256(sha256(token)))?.consumedAt,
      ).toBe(21);
    }
    expect(adapter.contents.at(-1)?.actions).toEqual([]);
    expect(workflowStoreValue(store.listPendingActionOutboxEvents(100))).toEqual([]);
    const watermark = await f.raw.watermark!("evt.workflow");
    await publish(initialPause);
    expect(workflowStoreValue(store.getRun("run-1"))?.state).toBe("cancelled");
    expect(await f.raw.watermark!("evt.workflow")).toBe(watermark);
  } finally {
    await resolver?.stop();
    await projector.stop();
    store.close();
    await f.close();
  }
}, 15_000);
