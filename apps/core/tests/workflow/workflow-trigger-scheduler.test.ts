import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  type FetchOptions,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import {
  normalizeWorkflowCapabilityProfile,
  type WorkflowTrigger,
} from "../../src/workflow/workflow-domain";
import { WorkflowTriggerScheduler } from "../../src/workflow/workflow-trigger-scheduler";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

class CapturingRawBus implements RawBus {
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];

  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
    this.messages.push(message);
    return { id: `${this.messages.length}-0`, cursor: `${this.messages.length}-0` };
  }
  async subscribe<TData>(
    _topic: string,
    _options: SubscriptionOptions,
    _handler: (message: Message<TData>, context: HandleContext) => Promise<void>,
  ) {
    return { stop: async () => {} };
  }
  async fetch<TData>(_topic: string, _options: FetchOptions) {
    return { messages: [] as Array<{ msg: Message<TData>; cursor: string }> };
  }
  async close() {}
}

function createRevision(store: DurableWorkflowStore): void {
  store.createRevision({
    revisionId: "revision-1",
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project",
    normalizedPath: "scheduled.js",
    name: "scheduled",
    snapshotArtifactId: `workflow-source:${HASH_A}`,
    sourceSha256: HASH_A,
    inputSchemaSha256: HASH_B,
    capabilitySha256: "c".repeat(64),
    metadata: { name: "scheduled", description: "Scheduled workflow" },
    inputSchema: { type: "object", additionalProperties: false },
    capabilities: normalizeWorkflowCapabilityProfile({
      agents: {
        profiles: ["explore"],
        models: ["inherit"],
        reasoning: ["provider-default"],
        allowedRoots: ["project"],
        tools: ["read_file"],
        executables: "none",
        editing: [],
        delegation: false,
        maxConcurrent: 1,
        maxTotal: 1,
      },
      level2: { callables: [] },
      surfaces: { origin: [] },
      maxNestingDepth: 2,
      maxWallTimeMs: 60_000,
      operationIdleTimeoutMs: 10_000,
      waits: [],
      safety: { originatingMode: "trusted", escalation: "none" },
    }),
    limits: {
      maxSourceBytes: 10_000,
      maxInputBytes: 10_000,
      maxOperationOutputBytes: 10_000,
      maxResultBytes: 10_000,
      maxRuntimeMemoryBytes: 256 * 1024 * 1024,
    },
    runtimeVersion: "lilac-workflow-js-v2",
    createdAt: 1,
  });
}

function trigger(input: {
  triggerId: string;
  definition: WorkflowTrigger["definition"];
  nextFireAt: number;
  skipMissed?: boolean;
  overlap?: "coalesce" | "parallel";
}): WorkflowTrigger {
  return {
    triggerId: input.triggerId,
    revisionId: "revision-1",
    state: "active",
    definition: input.definition,
    args: {},
    argsSha256: "d".repeat(64),
    schedulingPolicy: {
      skipMissed: input.skipMissed ?? true,
      overlap: input.overlap ?? "coalesce",
    },
    origin: {
      requestId: "origin-1",
      sessionId: "channel-1",
      client: "discord",
      userId: "user-1",
      safetyMode: "trusted",
      projectCwd: "/workspace",
    },
    completionTarget: { kind: "durable_surface" },
    progressTarget: null,
    nextFireAt: input.nextFireAt,
    lastFireAt: null,
    lastRunId: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("WorkflowTriggerScheduler", () => {
  it("creates one timestamp run and completes the trigger only after actual run failure", async () => {
    const dbPath = join(tmpdir(), `workflow-timestamp-${crypto.randomUUID()}.sqlite`);
    let store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 100;
    try {
      createRevision(store);
      store.createTrigger(
        trigger({
          triggerId: "timestamp-1",
          definition: { kind: "timestamp", at: 100 },
          nextFireAt: 100,
        }),
      );
      let scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => now, pollMs: 0 });
      await scheduler.start();
      await scheduler.stop();

      const fired = store.getTrigger("timestamp-1");
      expect(fired).toMatchObject({ state: "active", nextFireAt: null, lastFireAt: 100 });
      const run = fired?.lastRunId ? store.getRun(fired.lastRunId) : null;
      expect(run?.state).toBe("awaiting_review");
      const approval = run?.approvalId ? store.getApproval(run.approvalId) : null;
      expect(approval?.state).toBe("pending");
      expect(
        store.transitionApproval({
          approvalId: approval!.approvalId,
          from: "pending",
          to: "approved",
          now: 101,
        }),
      ).toBe(true);
      expect(
        store.tryClaimApprovedRun({ runId: run!.runId, claimerId: "engine", now: 102 }),
      ).not.toBeNull();
      store.transitionRun({
        runId: run!.runId,
        from: "running",
        to: "failed",
        now: 103,
        detail: "actual execution failed",
      });

      now = 104;
      scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => now, pollMs: 0 });
      await scheduler.start();
      await scheduler.stop();
      expect(store.getTrigger("timestamp-1")?.state).toBe("completed");
      expect(store.getRun(run!.runId)?.terminalDetail).toBe("actual execution failed");
    } finally {
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("survives scheduler restart, creates distinct cron runs, and rechecks approval drift", async () => {
    const dbPath = join(tmpdir(), `workflow-cron-${crypto.randomUUID()}.sqlite`);
    let store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 60_000;
    try {
      createRevision(store);
      store.createTrigger(
        trigger({
          triggerId: "cron-1",
          definition: { kind: "cron", expression: "* * * * *", timezone: "UTC" },
          nextFireAt: 60_000,
        }),
      );
      let scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => now, pollMs: 0 });
      await scheduler.start();
      await scheduler.stop();
      const first = store.getTrigger("cron-1")!;
      const firstRun = store.getRun(first.lastRunId!)!;
      store.transitionApproval({
        approvalId: firstRun.approvalId!,
        from: "pending",
        to: "approved",
        now: 60_001,
      });
      store.transitionRun({
        runId: firstRun.runId,
        from: "queued",
        to: "running",
        now: 60_002,
      });
      store.transitionRun({
        runId: firstRun.runId,
        from: "running",
        to: "succeeded",
        now: 60_003,
      });

      store.close();
      store = new DurableWorkflowStore(dbPath);

      now = first.nextFireAt!;
      scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => now, pollMs: 0 });
      await scheduler.start();
      await scheduler.stop();
      const second = store.getTrigger("cron-1")!;
      const secondRun = store.getRun(second.lastRunId!)!;
      expect(secondRun.runId).not.toBe(firstRun.runId);
      expect(secondRun.state).toBe("queued");

      store.transitionApproval({
        approvalId: secondRun.approvalId!,
        from: "approved",
        to: "revoked",
        now: now + 1,
        reason: "approval drift",
      });
      store.cancelRunAndChildren({
        runId: secondRun.runId,
        now: now + 2,
        detail: "cancel paused run after revocation",
      });
      now = second.nextFireAt!;
      scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => now, pollMs: 0 });
      await scheduler.start();
      await scheduler.stop();
      const third = store.getTrigger("cron-1")!;
      const thirdRun = store.getRun(third.lastRunId!)!;
      expect(new Set([firstRun.runId, secondRun.runId, thirdRun.runId]).size).toBe(3);
      expect(thirdRun.state).toBe("awaiting_review");
      expect(thirdRun.approvalId).not.toBe(secondRun.approvalId);
    } finally {
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("tracks all runs created by a trigger instead of only its latest run", async () => {
    const dbPath = join(tmpdir(), `workflow-trigger-runs-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    let now = 60_000;
    try {
      createRevision(store);
      store.createTrigger(
        trigger({
          triggerId: "parallel-1",
          definition: { kind: "cron", expression: "* * * * *", timezone: "UTC" },
          nextFireAt: now,
          overlap: "parallel",
        }),
      );
      const scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => now, pollMs: 0 });
      await scheduler.start();
      now = store.getTrigger("parallel-1")!.nextFireAt!;
      await scheduler.tick();
      await scheduler.stop();

      expect(store.countActiveScheduledRuns("parallel-1")).toBe(2);
      expect(store.countActiveScheduledRuns()).toBe(2);
    } finally {
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("atomically caps process-wide active scheduled runs", async () => {
    const dbPath = join(tmpdir(), `workflow-trigger-cap-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    const now = 60_000;
    try {
      createRevision(store);
      for (let index = 0; index < 65; index += 1) {
        store.createTrigger(
          trigger({
            triggerId: `capped-${index}`,
            definition:
              index === 64
                ? { kind: "timestamp", at: now }
                : { kind: "cron", expression: "* * * * *", timezone: "UTC" },
            nextFireAt: now,
            overlap: "parallel",
          }),
        );
      }
      const scheduler = new WorkflowTriggerScheduler({ bus, store, now: () => now, pollMs: 0 });
      await scheduler.start();
      await scheduler.stop();

      expect(store.countActiveScheduledRuns()).toBe(64);
      const triggers = store.listTriggers({ state: "active", limit: 100 });
      expect(triggers.filter((candidate) => candidate.lastRunId !== null)).toHaveLength(64);
      expect(
        triggers.filter(
          (candidate) =>
            candidate.lastRunId === null &&
            candidate.lastFireAt === now &&
            candidate.nextFireAt === now,
        ),
      ).toHaveLength(1);
    } finally {
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
