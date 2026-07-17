import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLilacBus,
  type FetchOptions,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import { SurfaceMessageNotFoundError } from "../../src/surface/adapter";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../../src/workflow/workflow-action-resolver";
import { sha256 } from "../../src/workflow/workflow-definition";
import { normalizeWorkflowResourcePolicy } from "../../src/workflow/workflow-domain";
import { WorkflowProgressProjector } from "../../src/workflow/workflow-progress-projector";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

class CapturingRawBus implements RawBus {
  readonly publishedOutboxIds: string[] = [];

  async publish<TData>(_message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
    const outboxId = options.headers?.["workflow_outbox_id"];
    if (outboxId) this.publishedOutboxIds.push(outboxId);
    return { id: "1-0", cursor: "1-0" };
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

class ProjectionAdapter implements SurfaceAdapter {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;
  edits = 0;
  reads = 0;
  failNextSend = false;
  failNextRead = false;
  failNextEditNotFound = false;

  constructor(readonly platform: "discord" | "github" = "discord") {}

  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: this.platform, userId: "bot", userName: "bot" };
  }
  async getCapabilities() {
    return {
      platform: this.platform,
      send: true,
      edit: true,
      delete: true,
      reactions: false,
      readHistory: true,
      threads: false,
      markRead: false,
    };
  }
  async listSessions() {
    return [];
  }
  async startOutput(): Promise<SurfaceOutputStream> {
    throw new Error("not used");
  }
  async sendMsg(session: SessionRef, content: ContentOpts, _opts?: SendOpts): Promise<MsgRef> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("transient surface failure");
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
    return ref;
  }
  async readMsg(ref: MsgRef) {
    this.reads += 1;
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("transient lookup failure");
    }
    return this.messages.get(ref.messageId) ?? null;
  }
  async listMsg(_session: SessionRef, _opts?: LimitOpts) {
    return [...this.messages.values()];
  }
  async editMsg(ref: MsgRef, content: ContentOpts) {
    if (this.failNextEditNotFound) {
      this.failNextEditNotFound = false;
      this.messages.delete(ref.messageId);
      throw new SurfaceMessageNotFoundError(this.platform, 10_008, "missing");
    }
    const current = this.messages.get(ref.messageId);
    if (!current) throw new SurfaceMessageNotFoundError(this.platform, 10_008, "missing");
    this.edits += 1;
    this.contents.push(content);
    this.messages.set(ref.messageId, { ...current, text: content.text ?? "" });
  }
  async deleteMsg(ref: MsgRef) {
    this.messages.delete(ref.messageId);
  }
  async getReplyContext() {
    return [];
  }
  async addReaction() {}
  async removeReaction() {}
  async listReactions() {
    return [];
  }
  async subscribe(_handler: AdapterEventHandler) {
    return { stop: async () => {} };
  }
  async getUnRead() {
    return [];
  }
  async markRead() {}
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

  override async sendMsg(
    session: SessionRef,
    content: ContentOpts,
    options?: SendOpts,
  ): Promise<MsgRef> {
    this.resolveSendStarted();
    await new Promise<void>((resolve) => {
      this.releaseSend = resolve;
    });
    return await super.sendMsg(session, content, options);
  }
}

function createInvocation(store: DurableWorkflowStore, hasProgressTarget = true): void {
  store.createInvocation({
    revision: {
      revisionId: "revision-1",
      canonicalProjectId: "project-1",
      canonicalWorkspaceRoot: "/workspace",
      scope: "project",
      normalizedPath: "audit.js",
      name: "audit",
      snapshotArtifactId: `workflow-source:${HASH_A}`,
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
        maxWallTimeMs: 60_000,
        operationIdleTimeoutMs: 10_000,
        waits: [],
      }),
      limits: {
        maxSourceBytes: 100_000,
        maxInputBytes: 10_000,
        maxOperationOutputBytes: 10_000,
        maxResultBytes: 10_000,
      },
      runtimeVersion: "lilac-workflow-js-v3",
      createdAt: 10,
    },
    run: {
      runId: "run-1",
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
        requestId: "discord:channel-1:origin-1",
        sessionId: "channel-1",
        client: "discord",
        userId: "user-1",
        projectCwd: "/workspace",
      },
      completionTarget: { kind: "durable_surface" },
      progressTarget: hasProgressTarget
        ? { platform: "discord", channelId: "channel-1", replyToMessageId: "origin-1" }
        : null,
      terminalDetail: null,
      result: null,
      resultArtifactId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 10,
      startedAt: null,
      updatedAt: 10,
      terminalAt: null,
    },
  });
}

function actionToken(adapter: ProjectionAdapter, label: string): string {
  const token = adapter.contents
    .at(-1)
    ?.actions?.find((action) => action.label === label)?.actionId;
  if (!token) throw new Error(`Missing ${label} action`);
  return token;
}

function tempDbPath(label: string): string {
  return join(tmpdir(), `${label}-${crypto.randomUUID()}.sqlite`);
}

describe("WorkflowProgressProjector", () => {
  it("ignores event projection for a null target and rejects explicit card creation", async () => {
    const dbPath = tempDbPath("workflow-null-target");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "null-target",
      coalesceMs: 0,
      minEditIntervalMs: 0,
    });
    try {
      createInvocation(store, false);
      projector.requestProjection("run-1");
      await Bun.sleep(20);
      expect(store.getSurfaceBinding("run-1")).toBeNull();
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
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "one-binding",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const first = await projector.ensureInitialCard("run-1");
      const binding = store.getSurfaceBinding("run-1");
      expect(binding?.messageRef).toEqual(first);
      expect(binding?.lastRenderedSha256).toHaveLength(64);
      expect(adapter.contents[0]?.text).not.toContain("lilac-workflow-card");
      await projector.ensureInitialCard("run-1");
      expect(adapter.sends).toBe(1);
      expect(adapter.edits).toBe(0);
      expect(store.listSurfaceBindings()).toHaveLength(1);
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
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "coalescing",
      now: () => 100,
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
      await Bun.sleep(30);
      expect(adapter.edits).toBe(1);
      expect(adapter.contents.at(-1)?.text).toContain("State: **running**");
    } finally {
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
    let projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "startup-first",
      now: () => 20,
    });
    try {
      createInvocation(store);
      await projector.start();
      expect(adapter.sends).toBe(1);
      const firstRef = store.getSurfaceBinding("run-1")?.messageRef;
      if (!firstRef) throw new Error("Missing startup binding");
      await projector.stop();
      store.close();

      adapter.messages.delete(firstRef.messageId);
      store = new DurableWorkflowStore(dbPath);
      projector = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "startup-second",
        now: () => 30,
      });
      await projector.start();
      expect(adapter.reads).toBe(1);
      expect(adapter.sends).toBe(2);
      expect(store.getSurfaceBinding("run-1")?.messageRef?.messageId).toBe("card-2");
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("repairs stale terminal cards, skips clean history, and retries failed bindings", async () => {
    const dbPath = tempDbPath("workflow-terminal-reconcile");
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new CapturingRawBus());
    let now = 20;
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
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
      expect(adapter.contents.at(-1)?.text).toContain("State: **cancelled**");
      await projector.reconcile();
      expect(adapter.reads).toBe(1);

      const binding = store.getSurfaceBinding("run-1");
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
        attempt < 100 && store.getSurfaceBinding("run-1")?.lastError !== null;
        attempt += 1
      ) {
        await Bun.sleep(5);
      }
      expect(adapter.reads).toBe(2);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
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
    let now = 100;
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "retry",
      now: () => now,
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
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: null,
        retryCount: 1,
        nextAttemptAt: 1_100,
        lastError: "transient surface failure",
      });
      await projector.start();
      now = 1_100;
      for (let attempt = 0; attempt < 100 && adapter.sends === 0; attempt += 1) {
        await Bun.sleep(5);
      }
      expect(adapter.sends).toBe(1);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        retryCount: 0,
        nextAttemptAt: null,
        lastError: null,
      });
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
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
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
        store.applySurfaceAction({
          tokenSha256: sha256(actionToken(adapter, "Pause")),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: ++now,
        }).status,
      ).toBe("applied");
      await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Resume",
        "Cancel",
      ]);
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(actionToken(adapter, "Resume")),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: ++now,
        }).status,
      ).toBe("applied");
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(actionToken(adapter, "Cancel")),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: ++now,
        }).status,
      ).toBe("applied");
      await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions).toEqual([]);
      expect(adapter.contents.at(-1)?.text).toContain("State: **cancelled**");
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
    const initialProjector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "outbox-initial",
      now: () => 20,
    });
    let resolver: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    try {
      createInvocation(store);
      const messageRef = await initialProjector.ensureInitialCard("run-1");
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(actionToken(adapter, "Pause")),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 21,
        }).status,
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
      const projecting = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "outbox-projector-first",
        now: () => 30,
      });
      await projecting.start();
      expect(store.listPendingActionOutboxEvents(30)).toEqual([]);
      expect(store.listPendingActionOutboxProjections()).toEqual([]);
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
      const restartedProjector = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "outbox-projector-second",
        now: () => 40,
      });
      await restartedProjector.start();
      expect(raw.publishedOutboxIds).toHaveLength(2);
      expect(new Set(raw.publishedOutboxIds).size).toBe(2);
      expect(store.listPendingActionOutboxProjections()).toEqual([]);
      await restartedProjector.stop();
    } finally {
      await resolver?.stop();
      await initialProjector.stop();
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
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
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
