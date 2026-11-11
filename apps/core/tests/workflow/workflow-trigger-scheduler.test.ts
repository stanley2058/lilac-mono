import { normalizeWorkflowResourcePolicy, workflowStoreValue } from "./workflow-store-test-helpers";
import { describe, expect, it, spyOn } from "bun:test";
import { Logger } from "@stanley2058/simple-module-logger";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Panic, Result, TaggedError } from "better-result";
import {
  createLilacBus,
  lilacEventTypes,
  type LilacMessageForTopic,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type RawDeliveryHandler,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { computeNextCronAtMs, computeNextCronAtMsResult } from "../../src/workflow/cron";
import {
  canonicalJsonSha256,
  WORKFLOW_RUNTIME_VERSION,
} from "../../src/workflow/workflow-definition";
import type { WorkflowTrigger } from "../../src/workflow/workflow-domain";
import type { WorkflowProgressCardService } from "../../src/workflow/workflow-progress-projector";
import { formatWorkflowErrorForLog } from "../../src/workflow/workflow-error-log";
import { WorkflowTriggerScheduler } from "../../src/workflow/workflow-trigger-scheduler";
import { workflowArtifactReferenceForTest } from "./workflow-test-blob-store";

import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "../helpers/real-core-bus";

class SchedulerLogFailure extends TaggedError("SchedulerLogFailure")<{
  readonly cause: unknown;
  readonly message: string;
}> {}
class CapturingRawBus implements RawBus {
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
    this.messages.push(message);
    return { id: `${this.messages.length}-0`, cursor: `${this.messages.length}-0` };
  }
  async subscribe(_topic: string, _options: SubscriptionOptions, _handler: RawDeliveryHandler) {
    return Result.ok({
      done: Promise.resolve(Result.ok(undefined)),
      stop: async () => Result.ok(undefined),
    });
  }
  async fetch(_topic: string, _options: FetchOptions) {
    return { messages: [] };
  }
  async close() {}
}
function createRevision(store: DurableWorkflowStore): void {
  const resources = normalizeWorkflowResourcePolicy({
    agents: { maxConcurrent: 1, maxTotal: 1 },
    maxNestingDepth: 2,
    operationIdleTimeoutMs: 10000,
    waits: [],
  });
  const limits = {
    maxSourceBytes: 10000,
    maxInputBytes: 10000,
    maxOperationOutputBytes: 10000,
    maxResultBytes: 10000,
  };
  store.createRevision({
    revisionId: "revision-1",
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: "scheduled.js",
    name: "scheduled",
    snapshotArtifact: workflowArtifactReferenceForTest(`workflow-source:${"a".repeat(64)}`),
    sourceSha256: "a".repeat(64),
    inputSchemaSha256: "b".repeat(64),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "scheduled", description: "Scheduled workflow" },
    inputSchema: { type: "object", additionalProperties: false },
    resources,
    limits,
    runtimeVersion: WORKFLOW_RUNTIME_VERSION,
    createdAt: 1,
  });
}
function trigger(): WorkflowTrigger {
  return {
    triggerId: "trigger-1",
    revisionId: "revision-1",
    state: "active",
    definition: { kind: "timestamp", at: 100 },
    args: {},
    argsSha256: canonicalJsonSha256({}),
    schedulingPolicy: { skipMissed: true, overlap: "coalesce" },
    origin: {
      requestId: "request-owner",
      sessionId: "channel-1",
      client: "discord",
      userId: "owner-1",
      projectCwd: "/workspace",
    },
    completionTarget: { kind: "detached" },
    progressTarget: null,
    nextFireAt: 100,
    lastFireAt: null,
    lastRunId: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
describe("workflow trigger scheduler", () => {
  it("redacts TaggedError catch-all logging without exposing cause", () => {
    const projected = formatWorkflowErrorForLog(
      new SchedulerLogFailure({
        cause: new Error("private cause"),
        message: "token=secret-scheduler-token",
      }),
    );
    expect(projected).toEqual({
      errorTag: "SchedulerLogFailure",
      errorMessage: "token=<redacted>",
    });
    expect(JSON.stringify(projected)).not.toContain("private cause");
    expect(JSON.stringify(projected)).not.toContain("secret-scheduler-token");
  });

  it("keeps workflow error logging total for hostile Error values", () => {
    const hostileMessage = new Error("unused");
    Object.defineProperty(hostileMessage, "message", {
      get() {
        throw new Panic({ message: "message getter must stay contained" });
      },
    });
    expect(formatWorkflowErrorForLog(hostileMessage)).toEqual({
      errorMessage: "Unknown workflow failure",
    });

    const hostileTagged = new Proxy(
      new SchedulerLogFailure({ cause: undefined, message: "unused" }),
      {
        get() {
          throw new Error("tagged property trap must stay contained");
        },
        getPrototypeOf() {
          throw new Error("tagged prototype trap must stay contained");
        },
      },
    );
    expect(formatWorkflowErrorForLog(hostileTagged)).toEqual({
      errorMessage: "Unknown workflow failure",
    });

    const revoked = Proxy.revocable(new Error("unused"), {});
    revoked.revoke();
    expect(formatWorkflowErrorForLog(revoked.proxy)).toEqual({
      errorMessage: "Unknown workflow failure",
    });
  });

  it("keeps cron compatibility output and returns invalid schedules as values", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const computed = computeNextCronAtMsResult({ expr: "*/5 * * * *" }, now);
    expect(computed.status).toBe("ok");
    if (computed.status === "ok") {
      expect(computed.value).toBe(computeNextCronAtMs({ expr: "*/5 * * * *" }, now));
    }
    const invalid = computeNextCronAtMsResult({ expr: "* * *" }, now);
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") expect(invalid.error._tag).toBe("WorkflowCronInvalid");
  });

  it("fires the immutable trusted owner snapshot directly into the queue", async () => {
    const file = join(tmpdir(), `workflow-scheduler-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(file);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    try {
      createRevision(store);
      store.createTrigger(trigger());
      const scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => 100 });
      await scheduler.tick();
      const storedTrigger = workflowStoreValue(store.getTrigger("trigger-1"));
      const fired = storedTrigger?.lastRunId
        ? workflowStoreValue(store.getRun(storedTrigger.lastRunId))
        : null;
      expect(fired).toMatchObject({
        state: "queued",
        revisionId: "revision-1",
        origin: { client: "discord", userId: "owner-1" },
      });
      expect(raw.messages.some((message) => message.type === "evt.workflow.run.changed")).toBe(
        true,
      );
    } finally {
      await bus.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("delivers scheduled run and progress events through Redis exactly once across repeated ticks", async () => {
    const f = await createRealCoreBusFixture();
    const store = new DurableWorkflowStore(join(f.directory, "workflow.sqlite"));
    const received: LilacMessageForTopic<"evt.workflow">[] = [];
    const delivered = Promise.withResolvers<void>();
    const subscription = requireBusOk(
      await f.bus.subscribeTopic(
        "evt.workflow",
        { mode: "fanout", subscriptionId: "scheduler-contract", startFrom: "beginning" },
        async (message) => {
          received.push(message);
          if (received.length === 2) delivered.resolve();
          return Result.ok(undefined);
        },
        () => "stop",
      ),
    );
    const scheduler = new WorkflowTriggerScheduler({ bus: f.bus, store, now: () => 100 });
    try {
      createRevision(store);
      store.createTrigger(trigger());
      await scheduler.tick();
      await withBusDeadline(delivered.promise, "scheduled workflow events");
      const storedTrigger = workflowStoreValue(store.getTrigger("trigger-1"));
      expect(received.map((message) => message.type)).toEqual([
        lilacEventTypes.EvtWorkflowRunChanged,
        lilacEventTypes.EvtWorkflowProgressRequested,
      ]);
      expect(received[0]?.data).toMatchObject({
        runId: storedTrigger?.lastRunId,
        revisionId: "revision-1",
        state: "queued",
        ts: 100,
      });
      expect(received[1]?.data).toMatchObject({
        runId: storedTrigger?.lastRunId,
        reason: "created",
      });
      const watermark = requireBusOk(await f.bus.getTopicWatermark("evt.workflow"));
      await scheduler.tick();
      expect(requireBusOk(await f.bus.getTopicWatermark("evt.workflow"))).toBe(watermark);
      expect(workflowStoreValue(store.listRuns())).toHaveLength(1);
    } finally {
      await scheduler.stop();
      requireBusOk(await subscription.stop());
      store.close();
      await f.close();
    }
  });
  it("preserves scheduler Panic instead of logging and swallowing it", async () => {
    const file = join(tmpdir(), `workflow-scheduler-panic-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(file);
    const bus = createLilacBus(new CapturingRawBus());
    const panic = new Panic({ message: "scheduler capacity defect" });
    try {
      createRevision(store);
      store.createTrigger(trigger());
      const scheduler = new WorkflowTriggerScheduler({
        bus,
        store,
        now: () => 100,
        getMaxActiveRuns: () => {
          throw panic;
        },
      });
      await expect(scheduler.tick()).rejects.toBe(panic);
      expect(workflowStoreValue(store.getTrigger("trigger-1"))).toMatchObject({
        state: "active",
        nextFireAt: 100,
        lastRunId: null,
      });
    } finally {
      await bus.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("preserves progress-card Panic after atomically firing the trigger", async () => {
    const file = join(tmpdir(), `workflow-scheduler-card-panic-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(file);
    const bus = createLilacBus(new CapturingRawBus());
    const panic = new Panic({ message: "progress card defect" });
    const progressCards: WorkflowProgressCardService = {
      resolveTarget: () => "discord",
      ensureInitialCard: async () => {
        throw panic;
      },
      requestProjection: () => {},
    };
    try {
      createRevision(store);
      store.createTrigger({
        ...trigger(),
        progressTarget: {
          platform: "discord",
          channelId: "scheduled-channel",
          replyToMessageId: null,
        },
      });
      const scheduler = new WorkflowTriggerScheduler({
        bus,
        store,
        progressCards,
        now: () => 100,
      });
      await expect(scheduler.tick()).rejects.toBe(panic);
      const storedTrigger = workflowStoreValue(store.getTrigger("trigger-1"));
      expect(storedTrigger).toMatchObject({ state: "active", nextFireAt: null });
      expect(
        storedTrigger?.lastRunId ? workflowStoreValue(store.getRun(storedTrigger.lastRunId)) : null,
      ).toMatchObject({ state: "queued", terminalAt: null });
    } finally {
      await bus.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("logs scheduled progress-card failures with run context and redaction", async () => {
    const file = join(tmpdir(), `workflow-scheduler-card-log-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(file);
    const bus = createLilacBus(new CapturingRawBus());
    const warning = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const progressCards: WorkflowProgressCardService = {
      resolveTarget: () => "discord",
      ensureInitialCard: async () => {
        throw new Error("token=secret-scheduled-card");
      },
      requestProjection: () => {},
    };
    try {
      createRevision(store);
      store.createTrigger({
        ...trigger(),
        progressTarget: {
          platform: "discord",
          channelId: "scheduled-channel",
          replyToMessageId: null,
        },
      });
      const scheduler = new WorkflowTriggerScheduler({
        bus,
        store,
        progressCards,
        now: () => 100,
      });

      await scheduler.tick();

      const runId = workflowStoreValue(store.getTrigger("trigger-1"))?.lastRunId;
      const logged = JSON.stringify(warning.mock.calls);
      expect(runId).toBeTruthy();
      expect(logged).toContain(runId ?? "missing-run-id");
      expect(logged).toContain("token=<redacted>");
      expect(logged).not.toContain("secret-scheduled-card");
    } finally {
      warning.mockRestore();
      await bus.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("reports detached timer Panic to the fatal supervisor", async () => {
    const file = join(tmpdir(), `workflow-scheduler-detached-panic-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(file);
    const bus = createLilacBus(new CapturingRawBus());
    const panic = new Panic({ message: "detached scheduler defect" });
    const reported = Promise.withResolvers<Panic>();
    let failClock = false;
    const scheduler = new WorkflowTriggerScheduler({
      bus,
      store,
      pollMs: 1,
      now: () => {
        if (failClock) throw panic;
        return 0;
      },
      reportFatalPanic: reported.resolve,
    });
    try {
      await scheduler.start();
      failClock = true;
      await expect(reported.promise).resolves.toBe(panic);
    } finally {
      await scheduler.stop();
      await bus.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
  it("defers a timestamp trigger at global capacity and fires after capacity is released", async () => {
    const file = join(tmpdir(), `workflow-scheduler-cap-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(file);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    try {
      createRevision(store);
      store.createRun({
        runId: "ordinary-active-run",
        revisionId: "revision-1",
        state: "queued",
        inputSchemaSnapshot: { type: "object", additionalProperties: false },
        args: {},
        argsSha256: canonicalJsonSha256({}),
        origin: trigger().origin,
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
      });
      store.createTrigger(trigger());
      const scheduler = new WorkflowTriggerScheduler({
        bus,
        store,
        now: () => 100,
        getMaxActiveRuns: () => 1,
      });
      await scheduler.tick();
      expect(workflowStoreValue(store.getTrigger("trigger-1"))).toMatchObject({
        state: "active",
        nextFireAt: 100,
        lastFireAt: null,
        lastRunId: null,
      });
      expect(workflowStoreValue(store.listRuns())).toHaveLength(1);
      expect(
        store.transitionRun({
          runId: "ordinary-active-run",
          from: "queued",
          to: "cancelled",
          now: 101,
        }),
      ).toBe(true);
      await scheduler.tick();
      const storedTrigger = workflowStoreValue(store.getTrigger("trigger-1"));
      expect(storedTrigger).toMatchObject({ state: "active", nextFireAt: null });
      expect(storedTrigger?.lastRunId).toBeTruthy();
      expect(store.countActiveRuns()).toBe(1);
    } finally {
      await bus.close();
      store.close();
      rmSync(file, { force: true });
    }
  });
});

it("awaits an active trigger tick during stop", async () => {
  const store = new DurableWorkflowStore(":memory:");
  const bus = createLilacBus(new CapturingRawBus());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number>();
  createRevision(store);
  store.createTrigger(trigger());
  const scheduler = new WorkflowTriggerScheduler({
    bus,
    store,
    now: () => 100,
    getMaxActiveRuns: () => {
      entered.resolve();
      return release.promise;
    },
  });
  const tick = scheduler.tick();
  await entered.promise;
  let stopped = false;
  const stop = scheduler.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release.resolve(100);
  await tick;
  await stop;
  expect(stopped).toBe(true);
  store.close();
  await bus.close();
});

it("lists only timestamp triggers awaiting completion", async () => {
  const store = new DurableWorkflowStore(":memory:");
  createRevision(store);
  const bus = createLilacBus(new CapturingRawBus());
  try {
    store.createTrigger(trigger());
    await new WorkflowTriggerScheduler({ bus, store, now: () => 100 }).tick();
    const fired = workflowStoreValue(store.getTrigger("trigger-1"));
    if (!fired?.lastRunId) throw new Error("Missing scheduled run");
    store.transitionTrigger({ triggerId: "trigger-1", from: "active", to: "completed", now: 101 });
    const base = { ...trigger(), nextFireAt: null, lastRunId: fired.lastRunId };
    store.createTrigger({ ...base, triggerId: "awaiting" });
    store.createTrigger({ ...base, triggerId: "scheduled", nextFireAt: 200 });
    store.createTrigger({ ...base, triggerId: "unfired", lastRunId: null });
    store.createTrigger({
      ...base,
      triggerId: "recurring",
      definition: { kind: "cron", expression: "* * * * *", timezone: null },
    });
    expect(
      workflowStoreValue(
        store.listTriggers({ state: "active", awaitingTimestampCompletion: true }),
      ).map((item) => item.triggerId),
    ).toEqual(["awaiting"]);
  } finally {
    await bus.close();
    store.close();
  }
});
