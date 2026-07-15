import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { canonicalJsonSha256, sha256 } from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowCapabilityProfile,
  type WorkflowWait,
} from "../../src/workflow/workflow-domain";
import { shouldSuppressRouterForWorkflowReply } from "../../src/workflow/workflow-router-suppression";
import { WorkflowWaitResolver } from "../../src/workflow/workflow-wait-resolver";

class IdleRawBus implements RawBus {
  private sequence = 0;
  private readonly watermarks = new Map<string, string>();

  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
    const id = `${++this.sequence}-0`;
    this.watermarks.set(message.topic, id);
    return { id, cursor: id };
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
  async watermark(topic: string) {
    return this.watermarks.get(topic) ?? null;
  }
  setWatermark(topic: string, cursor: string): void {
    this.watermarks.set(topic, cursor);
  }
  async close() {}
}

class HistoricalReplyRawBus extends IdleRawBus {
  constructor(private readonly historical: Message<unknown>) {
    super();
  }

  override async fetch<TData>(topic: string, _options: FetchOptions) {
    return {
      messages:
        topic === this.historical.topic
          ? [{ msg: this.historical as Message<TData>, cursor: this.historical.id }]
          : [],
    };
  }
  override async watermark(topic: string) {
    return topic === this.historical.topic ? this.historical.id : await super.watermark(topic);
  }
}

function createRunAndWait(
  store: DurableWorkflowStore,
  input: { runId: string; operationId: string; wait: Omit<WorkflowWait, "runId" | "operationId"> },
): void {
  const revisionId = `revision-${input.runId}`;
  const approvalId = `approval-${input.runId}`;
  store.createInvocation({
    revision: {
      revisionId,
      canonicalProjectId: "project-1",
      canonicalWorkspaceRoot: "/workspace",
      scope: "project",
      normalizedPath: `${input.runId}.js`,
      name: input.runId,
      snapshotArtifactId: `workflow-source:${sha256(input.runId)}`,
      sourceSha256: sha256(input.runId),
      inputSchemaSha256: "a".repeat(64),
      capabilitySha256: "b".repeat(64),
      metadata: { name: input.runId, description: "Wait test" },
      inputSchema: { type: "object", additionalProperties: false },
      capabilities: normalizeWorkflowCapabilityProfile({
        agents: {
          profiles: ["explore"],
          models: ["inherit"],
          editing: false,
          isolation: "shared",
          maxConcurrent: 1,
          maxTotal: 1,
        },
        maxNestingDepth: 2,
        maxWallTimeMs: 60_000,
        operationIdleTimeoutMs: 10_000,
        waits: ["reply", "sleep"],
        surfaceSends: false,
        externalTools: false,
        safety: { originatingMode: "trusted", escalation: "none" },
      }),
      limits: {
        maxSourceBytes: 10_000,
        maxInputBytes: 10_000,
        maxOperationOutputBytes: 10_000,
        maxResultBytes: 10_000,
        maxRuntimeMemoryBytes: 256 * 1024 * 1024,
      },
      runtimeVersion: "lilac-workflow-js-v1",
      createdAt: 1,
    },
    run: {
      runId: input.runId,
      revisionId,
      approvalId: null,
      state: "awaiting_review",
      inputSchemaSnapshot: { type: "object", additionalProperties: false },
      args: {},
      argsSha256: canonicalJsonSha256({}),
      origin: {
        requestId: "origin-1",
        sessionId: "channel-1",
        client: "discord",
        userId: "user-1",
        safetyMode: "trusted",
        projectCwd: "/workspace",
      },
      completionTarget: { kind: "detached" },
      progressTarget: null,
      terminalDetail: null,
      result: null,
      resultArtifactId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 1,
      startedAt: null,
      updatedAt: 1,
      terminalAt: null,
    },
    pendingApproval: {
      approvalId,
      revisionId,
      state: "pending",
      expectedReviewerPlatform: "discord",
      expectedReviewerUserId: "user-1",
      firstRunId: input.runId,
      decisionActorPlatform: null,
      decisionActorUserId: null,
      decisionSource: null,
      expiresAt: null,
      decidedAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  store.transitionApproval({ approvalId, from: "pending", to: "approved", now: 2 });
  store.tryClaimApprovedRun({ runId: input.runId, claimerId: "engine", now: 3 });
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
      resultArtifactId: null,
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
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for resolver");
    await Bun.sleep(5);
  }
}

describe("WorkflowWaitResolver", () => {
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
      expect(store.getWait("reply-catchup", "wait-catchup")).toMatchObject({
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
          deadlineAt: 1_000,
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
      await resolver.resolveAdapterEvent({ ...event, messageId: "late", ts: 1_001 }, "0-2");
      expect(store.getWait("reply-wait", "wait-1")?.state).toBe("pending");
      expect(
        shouldSuppressRouterForWorkflowReply({
          store,
          event: { ...event, messageId: "exact", ts: 1_000 },
          now: 20,
        }).suppress,
      ).toBe(false);
      await resolver.resolveAdapterEvent(event, "1-0");
      await waitFor(() => store.getWait("reply-wait", "wait-1")?.state === "resolved");
      const resolved = store.getWait("reply-wait", "wait-1");
      expect(resolved).toMatchObject({
        resolverCursor: "1-0",
        result: { text: "continue", messageId: "reply-1" },
      });
      expect(shouldSuppressRouterForWorkflowReply({ store, event, now: 21 }).suppress).toBe(true);
      expect(shouldSuppressRouterForWorkflowReply({ store, event, now: 22 }).suppress).toBe(true);
      expect(
        shouldSuppressRouterForWorkflowReply({ store, event, now: 20 + 5 * 60_000 }).suppress,
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
      await resolver.resolveAdapterEvent(event, "1-0");
      expect(store.getWait("exact-deadline", "wait-1")?.state).toBe("pending");
      await resolver.reconcileTimers();
      expect(store.getWait("exact-deadline", "wait-1")?.state).toBe("expired");
      await resolver.resolveAdapterEvent(event, "1-1");
      expect(store.getWait("exact-deadline", "wait-1")?.state).toBe("expired");
    } finally {
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("waits for the durable adapter watermark before expiring a reply", async () => {
    const dbPath = join(tmpdir(), `workflow-wait-watermark-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new IdleRawBus();
    raw.setWatermark("evt.adapter", "5-0");
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
      await resolver.reconcileTimers();
      expect(store.getWait("watermark-wait", "wait-1")?.state).toBe("pending");

      store.advanceAdapterStreamWatermark({ topic: "evt.adapter", cursor: "5-0", now: 101 });
      await resolver.reconcileTimers();
      expect(store.getWait("watermark-wait", "wait-1")?.state).toBe("expired");
    } finally {
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
      expect(store.getWait("sleep-wait", "sleep-1")?.state).toBe("pending");
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
      await waitFor(() => store.getWait("sleep-wait", "sleep-1")?.state === "resolved");
      await waitFor(() => store.getWait("timeout-wait", "reply-2")?.state === "expired");
      expect(store.getWait("sleep-wait", "sleep-1")?.result).toMatchObject({ dueAt: 100 });
      await restarted.stop();
    } finally {
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
