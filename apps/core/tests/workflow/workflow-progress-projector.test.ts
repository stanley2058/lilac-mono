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

import type {
  AdapterEventHandler,
  SurfaceAdapter,
  SurfaceOutputStream,
} from "../../src/surface/adapter";
import { SurfaceMessageNotFoundError } from "../../src/surface/adapter";
import {
  GithubAdapter,
  isGithubCommentAuthoredByActor,
} from "../../src/surface/github/github-adapter";
import type { GithubAuthoritativeActor } from "../../src/github/github-api";
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
import { normalizeWorkflowCapabilityProfile } from "../../src/workflow/workflow-domain";
import { WorkflowProgressProjector } from "../../src/workflow/workflow-progress-projector";
import {
  buildWorkflowProgressView,
  renderWorkflowProgressView,
} from "../../src/workflow/workflow-progress-view";
import {
  isMarkedGithubAgentComment,
  markGithubAgentComment,
} from "../../src/github/github-comment-marker";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const GITHUB_APP_RAW = { performed_via_github_app: { id: 42 } };
const GITHUB_PAT_RAW = { user: { login: "lilac-owner", id: 84 } };

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for projection state");
    await Bun.sleep(5);
  }
}

class IdleRawBus implements RawBus {
  async publish<TData>(_message: Omit<Message<TData>, "id" | "ts">, _options: PublishOptions) {
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

class FailingPublishRawBus extends IdleRawBus {
  override async publish<TData>(
    _message: Omit<Message<TData>, "id" | "ts">,
    _options: PublishOptions,
  ): Promise<never> {
    throw new Error("simulated Redis publication failure");
  }
}

class DelayedCapturingRawBus extends IdleRawBus {
  readonly outboxIds: string[] = [];

  constructor(private readonly delayMs = 5) {
    super();
  }

  override async publish<TData>(
    message: Omit<Message<TData>, "id" | "ts">,
    options: PublishOptions,
  ) {
    const outboxId = options.headers?.["workflow_outbox_id"];
    if (outboxId) this.outboxIds.push(outboxId);
    await Bun.sleep(this.delayMs);
    return await super.publish(message, options);
  }
}

class ProjectionAdapter implements SurfaceAdapter {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  readonly messageContents = new Map<string, ContentOpts>();
  sends = 0;
  edits = 0;
  editStarts = 0;
  editDelayMs = 0;
  reads = 0;
  listCalls = 0;
  failNextSend = false;
  failNextRead = false;
  failNextEditNotFound = false;
  failNextEdit = false;
  authoritativeRaw: unknown = GITHUB_APP_RAW;
  authoritativeActor: GithubAuthoritativeActor = { source: "app", appId: 42 };
  authoritativeLookupFailures = 0;
  authoritativeVerifier: ((message: SurfaceMessage) => Promise<boolean>) | null = null;

  constructor(readonly platform: "discord" | "github" = "discord") {}

  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: this.platform, userId: "bot", userName: "bot" };
  }
  async isAuthoritativelySelfAuthored(message: SurfaceMessage) {
    if (this.authoritativeVerifier) return await this.authoritativeVerifier(message);
    if (this.authoritativeLookupFailures > 0) {
      this.authoritativeLookupFailures -= 1;
      throw new Error("simulated authoritative identity lookup failure");
    }
    return isGithubCommentAuthoredByActor(message.raw, this.authoritativeActor);
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
        ? {
            platform: "discord",
            channelId: session.channelId,
            messageId: `card-${this.sends}`,
          }
        : {
            platform: "github",
            channelId: session.channelId,
            messageId: `card-${this.sends}`,
          };
    this.messages.set(ref.messageId, {
      ref,
      session:
        this.platform === "discord"
          ? { platform: "discord", channelId: session.channelId }
          : { platform: "github", channelId: session.channelId },
      userId: this.platform === "github" ? "lilac-workflow[bot]" : "bot",
      text:
        this.platform === "github"
          ? markGithubAgentComment(content.text ?? "")
          : (content.text ?? ""),
      ts: Date.now(),
      raw: this.platform === "github" ? this.authoritativeRaw : undefined,
    });
    this.messageContents.set(ref.messageId, content);
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
  async listMsg(_session: SessionRef, opts?: LimitOpts) {
    this.listCalls += 1;
    const limit = opts?.limit ?? 50;
    const messages = [...this.messages.values()];
    if (this.platform === "github") {
      const start = ((opts?.page ?? 1) - 1) * limit;
      return messages.slice(start, start + limit);
    }
    const newestFirst = messages.reverse();
    const start = opts?.beforeMessageId
      ? newestFirst.findIndex((message) => message.ref.messageId === opts.beforeMessageId) + 1
      : 0;
    return newestFirst.slice(Math.max(0, start), Math.max(0, start) + limit);
  }
  async editMsg(ref: MsgRef, content: ContentOpts) {
    this.editStarts += 1;
    if (this.editDelayMs > 0) await Bun.sleep(this.editDelayMs);
    if (this.failNextEditNotFound) {
      this.failNextEditNotFound = false;
      this.messages.delete(ref.messageId);
      this.messageContents.delete(ref.messageId);
      throw new SurfaceMessageNotFoundError("discord", 10_008, "missing");
    }
    if (this.failNextEdit) {
      this.failNextEdit = false;
      throw new Error("transient edit failure");
    }
    this.edits += 1;
    this.contents.push(content);
    const current = this.messages.get(ref.messageId);
    if (!current) throw new Error("message missing");
    this.messages.set(ref.messageId, {
      ...current,
      text:
        this.platform === "github"
          ? markGithubAgentComment(content.text ?? "")
          : (content.text ?? ""),
    });
    this.messageContents.set(ref.messageId, content);
  }
  async deleteMsg(ref: MsgRef) {
    if (this.platform === "github") throw new Error("GitHub comments cannot be deleted");
    this.messages.delete(ref.messageId);
    this.messageContents.delete(ref.messageId);
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

class FirstSendBlockingProjectionAdapter extends ProjectionAdapter {
  private first = true;
  private releaseFirst: (() => void) | null = null;
  private resolveFirstStarted: () => void = () => {};
  readonly firstStarted = new Promise<void>((resolve) => {
    this.resolveFirstStarted = resolve;
  });

  release(): void {
    this.releaseFirst?.();
  }

  override async sendMsg(
    session: SessionRef,
    content: ContentOpts,
    options?: SendOpts,
  ): Promise<MsgRef> {
    if (this.first) {
      this.first = false;
      this.resolveFirstStarted();
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    }
    return await super.sendMsg(session, content, options);
  }
}

class FirstEditBlockingProjectionAdapter extends ProjectionAdapter {
  private first = true;
  private releaseFirst: (() => void) | null = null;
  private resolveFirstStarted: () => void = () => {};
  readonly firstStarted = new Promise<void>((resolve) => {
    this.resolveFirstStarted = resolve;
  });

  release(): void {
    this.releaseFirst?.();
  }

  override async editMsg(ref: MsgRef, content: ContentOpts): Promise<void> {
    if (this.first) {
      this.first = false;
      this.resolveFirstStarted();
      await new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
    }
    await super.editMsg(ref, content);
  }
}

class TwoEditBlockingProjectionAdapter extends ProjectionAdapter {
  private editCall = 0;
  private releaseFirstEdit: (() => void) | null = null;
  private releaseSecondEdit: (() => void) | null = null;
  private resolveFirstStarted: () => void = () => {};
  private resolveSecondStarted: () => void = () => {};
  readonly firstStarted = new Promise<void>((resolve) => {
    this.resolveFirstStarted = resolve;
  });
  readonly secondStarted = new Promise<void>((resolve) => {
    this.resolveSecondStarted = resolve;
  });

  releaseFirst(): void {
    this.releaseFirstEdit?.();
  }

  releaseSecond(): void {
    this.releaseSecondEdit?.();
  }

  override async editMsg(ref: MsgRef, content: ContentOpts): Promise<void> {
    this.editCall += 1;
    if (this.editCall === 1) {
      this.resolveFirstStarted();
      await new Promise<void>((resolve) => {
        this.releaseFirstEdit = resolve;
      });
    } else if (this.editCall === 2) {
      this.resolveSecondStarted();
      await new Promise<void>((resolve) => {
        this.releaseSecondEdit = resolve;
      });
    }
    await super.editMsg(ref, content);
  }
}

function createInvocation(store: DurableWorkflowStore, platform: "discord" | "github" = "discord") {
  return store.createInvocation({
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
      capabilitySha256: "c".repeat(64),
      metadata: { name: "audit", description: "Audit routes" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string" },
          token: { type: "string", sensitive: true },
        },
      },
      capabilities: normalizeWorkflowCapabilityProfile({
        agents: {
          profiles: ["explore"],
          models: ["inherit"],
          editing: false,
          isolation: "shared",
          maxConcurrent: 2,
          maxTotal: 8,
        },
        maxNestingDepth: 4,
        maxWallTimeMs: 60_000,
        operationIdleTimeoutMs: 10_000,
        waits: [],
        surfaceSends: false,
        externalTools: false,
        safety: { originatingMode: "trusted", escalation: "none" },
      }),
      limits: {
        maxSourceBytes: 100_000,
        maxInputBytes: 10_000,
        maxOperationOutputBytes: 10_000,
        maxResultBytes: 10_000,
        maxRuntimeMemoryBytes: 256 * 1024 * 1024,
      },
      runtimeVersion: "runtime-v1",
      createdAt: 10,
    },
    run: {
      runId: "run-1",
      revisionId: "revision-1",
      approvalId: null,
      state: "awaiting_review",
      inputSchemaSnapshot: {
        type: "object",
        additionalProperties: false,
        properties: {
          directory: { type: "string" },
          token: { type: "string", sensitive: true },
        },
      },
      args: { directory: "src", token: "secret" },
      argsSha256: "d".repeat(64),
      origin: {
        requestId: "discord:channel-1:origin-1",
        sessionId: "channel-1",
        client: platform,
        userId: "user-1",
        safetyMode: "trusted",
        projectCwd: "/workspace",
      },
      completionTarget: { kind: "durable_surface" },
      progressTarget: {
        platform,
        channelId: "channel-1",
        replyToMessageId: "origin-1",
      },
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
    pendingApproval: {
      approvalId: "approval-1",
      revisionId: "revision-1",
      state: "pending",
      expectedReviewerPlatform: platform,
      expectedReviewerUserId: "user-1",
      firstRunId: "run-1",
      decisionActorPlatform: null,
      decisionActorUserId: null,
      decisionSource: null,
      expiresAt: null,
      decidedAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: 10,
      updatedAt: 10,
    },
  });
}

function createUncertainBinding(store: DurableWorkflowStore, platform: "discord" | "github"): void {
  store.upsertSurfaceBinding({
    runId: "run-1",
    target: { platform, channelId: "channel-1", replyToMessageId: "origin-1" },
    messageRef: null,
    lastRenderedSha256: null,
    lastError: "send completion was not persisted",
    retryCount: 0,
    nextAttemptAt: null,
    repairGeneration: 0,
    renderedRepairGeneration: 0,
    sendMayHaveSucceeded: true,
    discoveryCursor: { page: 1, beforeMessageId: null, scannedEntries: 0 },
    createdAt: 10,
    updatedAt: 10,
  });
}

describe("WorkflowProgressProjector", () => {
  it("heartbeats delayed outbox publication claims to prevent takeover", async () => {
    const dbPath = join(tmpdir(), `workflow-outbox-heartbeat-${crypto.randomUUID()}.sqlite`);
    const storeA = new DurableWorkflowStore(dbPath);
    const storeB = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new DelayedCapturingRawBus(80);
    const bus = createLilacBus(raw);
    let resolverA: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    let resolverB: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    const initial = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "outbox-heartbeat-initial",
    });
    try {
      createInvocation(storeA);
      const messageRef = await initial.ensureInitialCard("run-1");
      const approveToken = adapter.contents
        .at(-1)
        ?.actions?.find((action) => action.label === "Approve")?.actionId;
      if (!approveToken) throw new Error("Missing approval token");
      expect(
        storeA.applySurfaceAction({
          tokenSha256: sha256(approveToken),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: Date.now(),
        }).status,
      ).toBe("applied");

      const startingA = startWorkflowActionResolver({
        bus,
        store: storeA,
        subscriptionId: "outbox-heartbeat-a",
        claimStaleMs: 30,
        claimHeartbeatMs: 10,
      });
      await Bun.sleep(45);
      resolverB = await startWorkflowActionResolver({
        bus,
        store: storeB,
        subscriptionId: "outbox-heartbeat-b",
        claimStaleMs: 30,
        claimHeartbeatMs: 10,
      });
      resolverA = await startingA;
      expect(raw.outboxIds).toHaveLength(3);
      expect(new Set(raw.outboxIds).size).toBe(3);
    } finally {
      await initial.stop();
      await resolverA?.stop();
      await resolverB?.stop();
      await bus.close();
      storeA.close();
      storeB.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("heartbeats a delayed card edit so another runtime cannot take over", async () => {
    const dbPath = join(tmpdir(), `workflow-projection-heartbeat-${crypto.randomUUID()}.sqlite`);
    const storeA = new DurableWorkflowStore(dbPath);
    const storeB = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const initial = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "projection-heartbeat-initial",
    });
    const projectorA = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "projection-heartbeat-a",
      claimStaleMs: 30,
      claimHeartbeatMs: 10,
    });
    const projectorB = new WorkflowProgressProjector({
      bus,
      store: storeB,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "projection-heartbeat-b",
      claimStaleMs: 30,
      claimHeartbeatMs: 10,
    });
    try {
      createInvocation(storeA);
      await initial.ensureInitialCard("run-1");
      await initial.stop();
      storeA.transitionApproval({
        approvalId: "approval-1",
        from: "pending",
        to: "approved",
        now: Date.now(),
      });
      adapter.editDelayMs = 80;
      const editing = projectorA.ensureInitialCard("run-1");
      while (adapter.editStarts === 0) await Bun.sleep(1);
      await Bun.sleep(45);
      await expect(projectorB.ensureInitialCard("run-1")).rejects.toThrow("already claimed");
      await editing;
      expect(adapter.edits).toBe(1);
      expect(storeA.getSurfaceBinding("run-1")?.messageRef?.messageId).toBe("card-1");
    } finally {
      await initial.stop();
      await projectorA.stop();
      await projectorB.stop();
      await bus.close();
      storeA.close();
      storeB.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("serializes two-runtime missing-card reconciliation to one durable card", async () => {
    const dbPath = join(tmpdir(), `workflow-missing-card-race-${crypto.randomUUID()}.sqlite`);
    const storeA = new DurableWorkflowStore(dbPath);
    const storeB = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const projectorA = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "missing-card-a",
      now: () => 100,
    });
    const projectorB = new WorkflowProgressProjector({
      bus,
      store: storeB,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "missing-card-b",
      now: () => 100,
    });
    try {
      createInvocation(storeA);
      const results = await Promise.allSettled([
        projectorA.ensureInitialCard("run-1"),
        projectorB.ensureInitialCard("run-1"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(adapter.sends).toBe(1);
      expect(storeA.getSurfaceBinding("run-1")?.messageRef?.messageId).toBe("card-1");
    } finally {
      await projectorA.stop();
      await projectorB.stop();
      await bus.close();
      storeA.close();
      storeB.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("sends a fresh run card immediately without scanning history", async () => {
    const dbPath = join(tmpdir(), `workflow-fresh-card-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "fresh-card",
      now: () => 10,
    });
    try {
      createInvocation(store);
      const ref = await projector.ensureInitialCard("run-1");
      expect(ref.messageId).toBe("card-1");
      expect(adapter.sends).toBe(1);
      expect(adapter.listCalls).toBe(0);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("discovers a marked card after send succeeds before binding persistence", async () => {
    const dbPath = join(tmpdir(), `workflow-send-crash-discovery-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    let crash = true;
    const crashed = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "send-crash",
      now: () => 10,
      afterExternalIo: async ({ kind }) => {
        if (kind === "send" && crash) {
          crash = false;
          throw new Error("simulated process crash after send");
        }
      },
    });
    const replacement = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "send-crash-replacement",
      now: () => 20,
    });
    try {
      createInvocation(store);
      await expect(crashed.ensureInitialCard("run-1")).rejects.toThrow("simulated process crash");
      expect(adapter.sends).toBe(1);
      expect(adapter.messages.size).toBe(1);
      expect(store.getSurfaceBinding("run-1")?.messageRef).toBeNull();
      await crashed.stop();

      const recoveredRef = await replacement.ensureInitialCard("run-1");
      expect(recoveredRef.messageId).toBe("card-1");
      expect(adapter.sends).toBe(1);
      expect(adapter.messages.size).toBe(1);
      expect(adapter.edits).toBe(1);
      expect(store.getSurfaceBinding("run-1")?.messageRef).toEqual(recoveredRef);
      expect(adapter.messageContents.get(recoveredRef.messageId)?.actions?.length).toBe(2);
    } finally {
      await crashed.stop();
      await replacement.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("recovers a PAT-authored crash card while rejecting a user-spoofed marker", async () => {
    const dbPath = join(tmpdir(), `workflow-pat-send-crash-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter("github");
    adapter.authoritativeRaw = GITHUB_PAT_RAW;
    adapter.authoritativeActor = { source: "user", login: "lilac-owner" };
    const bus = createLilacBus(new IdleRawBus());
    const crashed = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["github", adapter]]),
      subscriptionId: "pat-send-crash",
      now: () => 10,
      afterExternalIo: async ({ kind }) => {
        if (kind === "send") throw new Error("simulated PAT card process crash");
      },
    });
    const replacement = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["github", adapter]]),
      subscriptionId: "pat-send-crash-replacement",
      now: () => 20,
    });
    try {
      createInvocation(store, "github");
      await expect(crashed.ensureInitialCard("run-1")).rejects.toThrow(
        "simulated PAT card process crash",
      );
      const genuine = adapter.messages.get("card-1");
      if (!genuine) throw new Error("Missing genuine PAT-authored card");
      adapter.messages.set("spoofed-card", {
        ...genuine,
        ref: { platform: "github", channelId: "channel-1", messageId: "spoofed-card" },
        userId: "attacker",
        ts: genuine.ts + 1,
        raw: { user: { login: "attacker", id: 999 } },
      });
      adapter.messageContents.set("spoofed-card", {
        text: genuine.text,
        actions: [{ label: "Spoofed", actionId: "spoofed", style: "danger" }],
      });
      await crashed.stop();

      const recovered = await replacement.ensureInitialCard("run-1");
      expect(recovered.messageId).toBe("card-1");
      expect(adapter.sends).toBe(1);
      expect(adapter.messageContents.get("spoofed-card")?.actions?.[0]?.label).toBe("Spoofed");
      expect(adapter.messageContents.get("spoofed-card")?.text).not.toContain("superseded");
    } finally {
      await crashed.stop();
      await replacement.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("tracks PAT, App, account, and transient authoritative identity changes without duplicates", async () => {
    const recoverAfterIdentityChange = async (input: {
      label: string;
      initialActor: GithubAuthoritativeActor;
      currentActor: GithubAuthoritativeActor;
      currentRaw: unknown;
      failFirstLookup?: boolean;
    }) => {
      const dbPath = join(
        tmpdir(),
        `workflow-github-identity-${input.label}-${crypto.randomUUID()}.sqlite`,
      );
      const store = new DurableWorkflowStore(dbPath);
      const adapter = new ProjectionAdapter("github");
      const bus = createLilacBus(new IdleRawBus());
      let actor = input.initialActor;
      let failLookup = input.failFirstLookup ?? false;
      const identityAdapter = new GithubAdapter(async () => {
        if (failLookup) {
          failLookup = false;
          throw new Error("transient identity lookup failure");
        }
        return actor;
      });
      adapter.authoritativeVerifier = async (message) =>
        await identityAdapter.isAuthoritativelySelfAuthored(message);
      const projector = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["github", adapter]]),
        subscriptionId: `identity-${input.label}`,
        now: () => 20,
      });
      const session = { platform: "github" as const, channelId: "channel-1" };
      const messageId = `identity-card-${input.label}`;
      try {
        createInvocation(store, "github");
        createUncertainBinding(store, "github");
        if (!input.failFirstLookup) {
          const initialRaw =
            input.initialActor.source === "app"
              ? { performed_via_github_app: { id: input.initialActor.appId } }
              : { user: { login: input.initialActor.login, id: 1 } };
          expect(
            await identityAdapter.isAuthoritativelySelfAuthored({
              ref: { ...session, messageId: "identity-probe" },
              session,
              userId: "identity-probe",
              text: "probe",
              ts: 1,
              raw: initialRaw,
            }),
          ).toBe(true);
        }
        actor = input.currentActor;
        const marker = `<!-- lilac-workflow-card:${sha256(
          "workflow-progress-card:run-1",
        )}:generation:0 -->`;
        adapter.messages.set(messageId, {
          ref: { ...session, messageId },
          session,
          userId: "authenticated-actor",
          text: markGithubAgentComment(`Workflow card\n${marker}`),
          ts: 10,
          raw: input.currentRaw,
        });

        if (input.failFirstLookup) {
          await expect(projector.ensureInitialCard("run-1")).rejects.toThrow(
            "transient identity lookup failure",
          );
        }
        const recovered = await projector.ensureInitialCard("run-1");
        expect(recovered.messageId).toBe(messageId);
        expect(adapter.sends).toBe(0);
      } finally {
        await projector.stop();
        await bus.close();
        store.close();
        rmSync(dbPath, { force: true });
      }
    };

    await recoverAfterIdentityChange({
      label: "pat-to-app",
      initialActor: { source: "user", login: "old-user" },
      currentActor: { source: "app", appId: 42 },
      currentRaw: GITHUB_APP_RAW,
    });
    await recoverAfterIdentityChange({
      label: "app-to-pat-account",
      initialActor: { source: "app", appId: 42 },
      currentActor: { source: "user", login: "new-owner" },
      currentRaw: { user: { login: "new-owner", id: 85 } },
    });
    await recoverAfterIdentityChange({
      label: "transient",
      initialActor: { source: "app", appId: 42 },
      currentActor: { source: "app", appId: 42 },
      currentRaw: GITHUB_APP_RAW,
      failFirstLookup: true,
    });
  });

  it("resumes GitHub discovery beyond 1000 comments without trusting copied markers", async () => {
    const dbPath = join(tmpdir(), `workflow-github-deep-discovery-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter("github");
    const bus = createLilacBus(new IdleRawBus());
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["github", adapter]]),
      subscriptionId: "github-deep-discovery",
      now: () => 20,
    });
    const session = { platform: "github" as const, channelId: "channel-1" };
    const workflowMarker = `<!-- lilac-workflow-card:${sha256(
      "workflow-progress-card:run-1",
    )}:generation:0 -->`;
    try {
      createInvocation(store, "github");
      createUncertainBinding(store, "github");
      for (let index = 0; index < 1_120; index += 1) {
        const messageId = `noise-${index}`;
        adapter.messages.set(messageId, {
          ref: { ...session, messageId },
          session,
          userId: "lilac-workflow[bot]",
          text: markGithubAgentComment(`unrelated comment ${index}`),
          ts: index,
        });
      }
      for (const [messageId, ts] of [
        ["deep-card-1", 1_120],
        ["deep-card-2", 1_121],
      ] as const) {
        adapter.messages.set(messageId, {
          ref: { ...session, messageId },
          session,
          userId: "lilac-workflow[bot]",
          text: markGithubAgentComment(`Workflow card\n${workflowMarker}`),
          ts,
          raw: GITHUB_APP_RAW,
        });
        adapter.messageContents.set(messageId, {
          text: `Workflow card\n${workflowMarker}`,
          actions: [{ label: "Stale", actionId: `stale-${messageId}`, style: "danger" }],
        });
      }
      adapter.messages.set("copied-card", {
        ref: { ...session, messageId: "copied-card" },
        session,
        userId: "untrusted-user",
        text: markGithubAgentComment(`Workflow card\n${workflowMarker}`),
        ts: 999,
      });
      adapter.messageContents.set("copied-card", {
        text: `Workflow card\n${workflowMarker}`,
        actions: [{ label: "Copied", actionId: "copied", style: "danger" }],
      });

      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow("discovery is incomplete");
      expect(adapter.sends).toBe(0);
      expect(store.getSurfaceBinding("run-1")?.discoveryCursor).toMatchObject({
        page: 11,
        scannedEntries: 1_000,
      });

      const recovered = await projector.ensureInitialCard("run-1");
      expect(recovered.messageId).toBe("deep-card-2");
      expect(adapter.sends).toBe(0);
      expect(store.getSurfaceBinding("run-1")?.messageRef).toEqual(recovered);
      expect(adapter.messageContents.get("deep-card-1")?.text).toContain("superseded");
      expect(adapter.messageContents.get("deep-card-1")?.actions).toEqual([]);
      expect(adapter.messageContents.get("deep-card-2")?.actions?.length).toBe(2);
      expect(adapter.messageContents.get("copied-card")?.actions?.[0]?.label).toBe("Copied");
      expect(adapter.messageContents.get("copied-card")?.text).not.toContain("superseded");
      expect(store.listPendingSurfaceProjectionOrphans({ runId: "run-1" })).toEqual([]);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("persists retry and does not send when bounded GitHub discovery is incomplete", async () => {
    const dbPath = join(
      tmpdir(),
      `workflow-github-incomplete-discovery-${crypto.randomUUID()}.sqlite`,
    );
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter("github");
    const bus = createLilacBus(new IdleRawBus());
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["github", adapter]]),
      subscriptionId: "github-incomplete-discovery",
      now: () => 20,
    });
    const session = { platform: "github" as const, channelId: "channel-1" };
    try {
      createInvocation(store, "github");
      createUncertainBinding(store, "github");
      for (let index = 0; index < 1_000; index += 1) {
        const messageId = `noise-${index}`;
        adapter.messages.set(messageId, {
          ref: { ...session, messageId },
          session,
          userId: "user",
          text: `unrelated ${index}`,
          ts: index,
        });
      }

      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow("discovery is incomplete");
      expect(adapter.sends).toBe(0);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: null,
        retryCount: 1,
        nextAttemptAt: 1_020,
      });
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("resumes Discord discovery beyond 1000 messages without sending a duplicate", async () => {
    const dbPath = join(
      tmpdir(),
      `workflow-discord-incomplete-discovery-${crypto.randomUUID()}.sqlite`,
    );
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter("discord");
    const bus = createLilacBus(new IdleRawBus());
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "discord-incomplete-discovery",
      now: () => 20,
    });
    const session = { platform: "discord" as const, channelId: "channel-1" };
    try {
      createInvocation(store);
      createUncertainBinding(store, "discord");
      const existingMessageId = "deep-discord-card";
      adapter.messages.set(existingMessageId, {
        ref: { ...session, messageId: existingMessageId },
        session,
        userId: "bot",
        text: `Workflow card\n[\u200B](https://lilac.invalid/.well-known/workflow-card/${sha256(
          "workflow-progress-card:run-1",
        )}?generation=0)`,
        ts: 0,
      });
      for (let index = 0; index < 1_120; index += 1) {
        const messageId = `noise-${index}`;
        adapter.messages.set(messageId, {
          ref: { ...session, messageId },
          session,
          userId: "user",
          text: `unrelated ${index}`,
          ts: index,
        });
      }

      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow("discovery is incomplete");
      expect(adapter.sends).toBe(0);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: null,
        retryCount: 1,
        discoveryCursor: { beforeMessageId: "noise-120", scannedEntries: 1_000 },
      });
      const recovered = await projector.ensureInitialCard("run-1");
      expect(recovered.messageId).toBe(existingMessageId);
      expect(adapter.sends).toBe(0);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("repairs a stale send and deletes its visible orphan card", async () => {
    const dbPath = join(tmpdir(), `workflow-stale-projector-${crypto.randomUUID()}.sqlite`);
    const storeA = new DurableWorkflowStore(dbPath);
    const storeB = new DurableWorkflowStore(dbPath);
    const adapter = new FirstSendBlockingProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const projectorA = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-projector-a",
      now: () => 0,
    });
    const projectorB = new WorkflowProgressProjector({
      bus,
      store: storeB,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-projector-b",
      now: () => 40_000,
    });
    try {
      createInvocation(storeA);
      const staleProjection = projectorA.ensureInitialCard("run-1");
      await adapter.firstStarted;
      const currentRef = await projectorB.ensureInitialCard("run-1");
      expect(currentRef.messageId).toBe("card-1");
      adapter.release();
      await expect(staleProjection).rejects.toThrow("claim was lost");
      expect(storeA.getSurfaceBinding("run-1")).toMatchObject({
        repairGeneration: 2,
        renderedRepairGeneration: 1,
      });
      const repairedRef = await projectorB.ensureInitialCard("run-1");
      expect(repairedRef).toEqual(currentRef);
      expect(adapter.sends).toBe(2);
      expect(adapter.messages.size).toBe(1);
      expect([...adapter.messages.keys()]).toEqual([currentRef.messageId]);
      expect(storeA.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: currentRef,
        repairGeneration: 2,
        renderedRepairGeneration: 2,
      });
      expect(
        storeA
          .listSurfaceActions("run-1", { activeAt: 40_000 })
          .every((action) => action.expectedMessageRef?.messageId === currentRef.messageId),
      ).toBe(true);
      const approveToken = adapter.contents
        .at(-1)
        ?.actions?.find((action) => action.label === "Approve")?.actionId;
      if (!approveToken) throw new Error("Missing repaired approval action");
      expect(
        storeB.applySurfaceAction({
          tokenSha256: sha256(approveToken),
          platform: "discord",
          userId: "user-1",
          messageRef: currentRef,
          now: 40_001,
        }).status,
      ).toBe("applied");
    } finally {
      adapter.release();
      await projectorA.stop();
      await projectorB.stop();
      await bus.close();
      storeA.close();
      storeB.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("durably retries GitHub stale-card neutralization without leaving usable controls", async () => {
    const dbPath = join(tmpdir(), `workflow-github-orphan-${crypto.randomUUID()}.sqlite`);
    const storeA = new DurableWorkflowStore(dbPath);
    const storeB = new DurableWorkflowStore(dbPath);
    const adapter = new FirstSendBlockingProjectionAdapter("github");
    const bus = createLilacBus(new IdleRawBus());
    const projectorA = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["github", adapter]]),
      subscriptionId: "github-orphan-a",
      now: () => 0,
    });
    let currentNow = 40_000;
    const projectorB = new WorkflowProgressProjector({
      bus,
      store: storeB,
      adapters: new Map([["github", adapter]]),
      subscriptionId: "github-orphan-b",
      now: () => currentNow,
    });
    try {
      createInvocation(storeA, "github");
      const staleProjection = projectorA.ensureInitialCard("run-1");
      await adapter.firstStarted;
      const currentRef = await projectorB.ensureInitialCard("run-1");
      adapter.release();
      await expect(staleProjection).rejects.toThrow("claim was lost");
      expect(storeA.listPendingSurfaceProjectionOrphans({ runId: "run-1" })).toHaveLength(1);
      expect(adapter.messageContents.get("card-2")?.actions?.length).toBe(2);

      adapter.failNextEdit = true;
      await expect(projectorB.ensureInitialCard("run-1")).rejects.toThrow("transient edit failure");
      expect(storeA.listPendingSurfaceProjectionOrphans({ runId: "run-1" })).toHaveLength(1);
      currentNow = 41_000;
      await projectorB.ensureInitialCard("run-1");
      expect(adapter.sends).toBe(2);
      expect(adapter.messages.size).toBe(2);
      expect(adapter.messageContents.get("card-2")?.text).toContain("superseded");
      expect(adapter.messageContents.get("card-2")?.actions).toEqual([]);
      expect(adapter.messageContents.get(currentRef.messageId)?.actions?.length).toBe(2);
      expect(storeA.listPendingSurfaceProjectionOrphans({ runId: "run-1" })).toEqual([]);
      const approveToken = adapter.messageContents
        .get(currentRef.messageId)
        ?.actions?.find((action) => action.label === "Approve")?.actionId;
      if (!approveToken) throw new Error("Missing current GitHub approval action");
      expect(
        storeB.applySurfaceAction({
          tokenSha256: sha256(approveToken),
          platform: "github",
          userId: "user-1",
          messageRef: currentRef,
          now: 40_001,
        }).status,
      ).toBe("applied");
    } finally {
      adapter.release();
      await projectorA.stop();
      await projectorB.stop();
      await bus.close();
      storeA.close();
      storeB.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("repairs stale edit content on the one visible current card", async () => {
    const dbPath = join(tmpdir(), `workflow-stale-edit-repair-${crypto.randomUUID()}.sqlite`);
    const storeA = new DurableWorkflowStore(dbPath);
    const storeB = new DurableWorkflowStore(dbPath);
    const adapter = new TwoEditBlockingProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const initial = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-edit-initial",
      now: () => 10,
    });
    const projectorA = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-edit-a",
      now: () => 20,
    });
    const projectorB = new WorkflowProgressProjector({
      bus,
      store: storeB,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-edit-b",
      now: () => 40_000,
    });
    try {
      createInvocation(storeA);
      const cardRef = await initial.ensureInitialCard("run-1");
      await initial.stop();
      storeA.transitionApproval({
        approvalId: "approval-1",
        from: "pending",
        to: "approved",
        now: 11,
      });

      const staleEdit = projectorA.ensureInitialCard("run-1");
      await adapter.firstStarted;
      expect(
        storeB.tryClaimApprovedRun({
          runId: "run-1",
          claimerId: "engine",
          now: 40_000,
        })?.state,
      ).toBe("running");
      const currentEdit = projectorB.ensureInitialCard("run-1");
      await adapter.secondStarted;
      adapter.releaseFirst();
      await expect(staleEdit).rejects.toThrow("claim was lost");
      expect(storeA.getSurfaceBinding("run-1")).toMatchObject({
        repairGeneration: 2,
        renderedRepairGeneration: 0,
      });
      adapter.releaseSecond();
      await expect(currentEdit).rejects.toThrow("repair generation changed");

      await projectorB.ensureInitialCard("run-1");
      expect(adapter.sends).toBe(1);
      expect(adapter.edits).toBe(3);
      expect(adapter.messages.size).toBe(1);
      expect(adapter.messages.get(cardRef.messageId)?.text).toContain("State: **running**");
      expect(
        adapter.messageContents.get(cardRef.messageId)?.actions?.map((action) => action.label),
      ).toEqual(["Pause", "Cancel"]);
      expect(storeA.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: cardRef,
        repairGeneration: 2,
        renderedRepairGeneration: 2,
      });
      const cancelToken = adapter.messageContents
        .get(cardRef.messageId)
        ?.actions?.find((action) => action.label === "Cancel")?.actionId;
      if (!cancelToken) throw new Error("Missing current cancel action");
      expect(
        storeB.applySurfaceAction({
          tokenSha256: sha256(cancelToken),
          platform: "discord",
          userId: "user-1",
          messageRef: cardRef,
          now: 40_001,
        }).status,
      ).toBe("applied");
    } finally {
      adapter.releaseFirst();
      adapter.releaseSecond();
      await initial.stop();
      await projectorA.stop();
      await projectorB.stop();
      await bus.close();
      storeA.close();
      storeB.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("periodically repairs a late stale edit without a restart or workflow event", async () => {
    const dbPath = join(tmpdir(), `workflow-stale-edit-crash-${crypto.randomUUID()}.sqlite`);
    const storeA = new DurableWorkflowStore(dbPath);
    const storeB = new DurableWorkflowStore(dbPath);
    const adapter = new FirstEditBlockingProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const initial = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-edit-crash-initial",
      now: () => 10,
    });
    const stale = new WorkflowProgressProjector({
      bus,
      store: storeA,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-edit-crash-stale",
      now: () => 20,
      afterExternalIo: async () => await new Promise<void>(() => {}),
    });
    const current = new WorkflowProgressProjector({
      bus,
      store: storeB,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "stale-edit-crash-current",
      now: Date.now,
      coalesceMs: 0,
      minEditIntervalMs: 0,
      remoteVerificationIntervalMs: 20,
    });
    try {
      createInvocation(storeA);
      const cardRef = await initial.ensureInitialCard("run-1");
      await initial.stop();
      storeA.transitionApproval({
        approvalId: "approval-1",
        from: "pending",
        to: "approved",
        now: 11,
      });

      void stale.ensureInitialCard("run-1");
      await adapter.firstStarted;
      expect(
        storeB.tryClaimApprovedRun({
          runId: "run-1",
          claimerId: "engine",
          now: Date.now(),
        })?.state,
      ).toBe("running");
      await current.start();
      expect(storeB.getSurfaceBinding("run-1")).toMatchObject({
        repairGeneration: 1,
        renderedRepairGeneration: 1,
      });

      adapter.release();
      await waitFor(() => adapter.edits === 2);
      expect(adapter.messages.get(cardRef.messageId)?.text).toContain("State: **queued**");

      await waitFor(
        () => adapter.messages.get(cardRef.messageId)?.text.includes("State: **running**") ?? false,
      );
      expect(storeB.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: cardRef,
        repairGeneration: 2,
        renderedRepairGeneration: 2,
      });
      expect(
        adapter.messageContents.get(cardRef.messageId)?.actions?.map((action) => action.label),
      ).toEqual(["Pause", "Cancel"]);
    } finally {
      adapter.release();
      await initial.stop();
      await current.stop();
      await bus.close();
      storeA.close();
      storeB.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("consumes a durable repair marker during startup reconciliation", async () => {
    const dbPath = join(tmpdir(), `workflow-startup-repair-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const initial = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "startup-repair-initial",
      now: () => 10,
    });
    const restarted = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "startup-repair-restarted",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const cardRef = await initial.ensureInitialCard("run-1");
      await initial.stop();
      expect(store.requestSurfaceBindingRepair("run-1", 15)).toBe(1);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        repairGeneration: 1,
        renderedRepairGeneration: 0,
      });

      await restarted.start();
      expect(adapter.messages.size).toBe(1);
      expect(adapter.messages.has(cardRef.messageId)).toBe(true);
      expect(adapter.reads).toBe(1);
      expect(adapter.edits).toBe(1);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        repairGeneration: 1,
        renderedRepairGeneration: 1,
      });
    } finally {
      await initial.stop();
      await restarted.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("waits for an in-flight projection before releasing claims on shutdown", async () => {
    const dbPath = join(tmpdir(), `workflow-projector-shutdown-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new FirstSendBlockingProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "projector-shutdown",
    });
    try {
      createInvocation(store);
      const projection = projector.ensureInitialCard("run-1");
      await adapter.firstStarted;
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
      expect(
        store.claimSurfaceProjection({
          runId: "run-1",
          ownerId: "replacement",
          claimToken: "replacement-token",
          now: Date.now(),
          staleBefore: Number.MIN_SAFE_INTEGER,
        }),
      ).toBe(true);
    } finally {
      adapter.release();
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("fences two runtimes from duplicate outbox publication or action rotation", async () => {
    const dbPath = join(tmpdir(), `workflow-action-race-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const adapter = new ProjectionAdapter();
    const raw = new DelayedCapturingRawBus();
    const bus = createLilacBus(raw);
    let resolverA: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    let resolverB: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    const projectorA = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "projector-race",
      now: () => 100,
      loadSource: async () => "export default 'immutable';",
    });
    const projectorB = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "projector-race",
      now: () => 100,
      loadSource: async () => "export default 'immutable';",
    });
    try {
      createInvocation(store);
      const initial = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "projector-race-initial",
        now: () => 90,
        loadSource: async () => "export default 'immutable';",
      });
      const messageRef = await initial.ensureInitialCard("run-1");
      const approveToken = adapter.contents
        .at(-1)
        ?.actions?.find((action) => action.label === "Approve")?.actionId;
      if (!approveToken) throw new Error("Missing approval token");
      await initial.stop();
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(approveToken),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 91,
        }).status,
      ).toBe("applied");

      [resolverA, resolverB] = await Promise.all([
        startWorkflowActionResolver({ bus, store, subscriptionId: "action-race", now: () => 100 }),
        startWorkflowActionResolver({ bus, store, subscriptionId: "action-race", now: () => 100 }),
      ]);
      expect(raw.outboxIds).toHaveLength(3);
      expect(new Set(raw.outboxIds).size).toBe(3);

      await Promise.all([projectorA.start(), projectorB.start()]);
      expect(adapter.sends).toBe(1);
      expect(adapter.edits).toBe(1);
      expect(store.listPendingActionOutboxProjections()).toHaveLength(0);
    } finally {
      await projectorA.stop();
      await projectorB.stop();
      await resolverA?.stop();
      await resolverB?.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("recovers action publication and card projection from the durable outbox after restart", async () => {
    const dbPath = join(tmpdir(), `workflow-action-outbox-${crypto.randomUUID()}.sqlite`);
    const adapter = new ProjectionAdapter();
    let store = new DurableWorkflowStore(dbPath);
    const failedBus = createLilacBus(new FailingPublishRawBus());
    let failedResolver: Awaited<ReturnType<typeof startWorkflowActionResolver>> | null = null;
    try {
      createInvocation(store);
      const initialProjector = new WorkflowProgressProjector({
        bus: failedBus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "action-outbox-initial",
        now: () => 20,
        loadSource: async () => "export default 'immutable';",
      });
      const messageRef = await initialProjector.ensureInitialCard("run-1");
      const approveToken = adapter.contents
        .at(-1)
        ?.actions?.find((action) => action.label === "Approve")?.actionId;
      if (!approveToken) throw new Error("Missing approval token");
      expect(
        store.applySurfaceAction({
          tokenSha256: sha256(approveToken),
          platform: "discord",
          userId: "user-1",
          messageRef,
          now: 21,
        }).status,
      ).toBe("applied");
      expect(store.getRun("run-1")?.state).toBe("queued");
      expect(store.listPendingActionOutboxEvents(21)).toHaveLength(3);
      expect(store.listPendingActionOutboxProjections()).toHaveLength(1);

      failedResolver = await startWorkflowActionResolver({
        bus: failedBus,
        store,
        subscriptionId: "action-outbox-failing-resolver",
        now: () => 21,
      });
      expect(store.listPendingActionOutboxEvents(2_000)).toHaveLength(3);
      await failedResolver.stop();
      failedResolver = null;
      await initialProjector.stop();
      store.close();

      store = new DurableWorkflowStore(dbPath);
      const recoveredBus = createLilacBus(new IdleRawBus());
      const recoveredResolver = await startWorkflowActionResolver({
        bus: recoveredBus,
        store,
        subscriptionId: "action-outbox-recovered-resolver",
        now: () => 2_000,
      });
      const recoveredProjector = new WorkflowProgressProjector({
        bus: recoveredBus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "action-outbox-recovered-projector",
        now: () => 2_000,
        loadSource: async () => "export default 'immutable';",
      });
      await recoveredProjector.start();
      expect(store.listPendingActionOutboxEvents(2_000)).toHaveLength(0);
      expect(store.listPendingActionOutboxProjections()).toHaveLength(0);
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);
      expect(adapter.sends).toBe(1);
      expect(adapter.edits).toBe(1);
      await recoveredProjector.stop();
      await recoveredResolver.stop();
      await recoveredBus.close();
    } finally {
      await failedResolver?.stop();
      await failedBus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("redacts review data, persists bindings, survives restart, and retains terminal cards", async () => {
    const dbPath = join(tmpdir(), `workflow-projector-${crypto.randomUUID()}.sqlite`);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    let store = new DurableWorkflowStore(dbPath);
    try {
      createInvocation(store);
      const view = await buildWorkflowProgressView({
        store,
        runId: "run-1",
        now: 20,
        loadSource: async () => "export default 'immutable';",
      });
      expect(view.review.firstArgs).toEqual({ directory: "src", token: "<redacted>" });
      const githubReview = renderWorkflowProgressView({
        view,
        platform: "github",
        actions: [],
      });
      expect(githubReview.text).toContain("Exact immutable source");
      expect(githubReview.text).toContain("export default 'immutable';");
      expect(githubReview.text).toContain("project:audit.js");
      expect(githubReview.text).toContain(HASH_A);
      expect(githubReview.text).not.toContain("secret");
      expect(githubReview.text).not.toContain("d".repeat(64));

      let projector = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "test-projector-1",
        now: () => 20,
        loadSource: async () => "export default 'immutable';",
      });
      const firstRef = await projector.ensureInitialCard("run-1");
      expect(firstRef.messageId).toBe("card-1");
      expect(adapter.contents[0]?.actions?.map((action) => action.label)).toEqual([
        "Approve",
        "Reject",
      ]);
      expect(adapter.contents[0]?.text).not.toContain("secret");
      expect(adapter.contents[0]?.text).not.toContain("d".repeat(64));
      expect(
        adapter.contents[0]?.attachments?.every(
          (attachment) =>
            attachment.kind !== "file" ||
            !new TextDecoder().decode(attachment.bytes).includes("d".repeat(64)),
        ),
      ).toBe(true);
      expect(adapter.contents[0]?.attachments?.map((item) => item.filename)).toEqual([
        "audit-review.json",
        `audit-${HASH_A.slice(0, 12)}.js`,
      ]);
      expect(store.getSurfaceBinding("run-1")?.messageRef).toEqual(firstRef);
      expect(
        store.transitionApproval({
          approvalId: "approval-1",
          from: "pending",
          to: "approved",
          now: 21,
          actorPlatform: "discord",
          actorUserId: "user-1",
        }),
      ).toBe(true);
      await projector.ensureInitialCard("run-1");
      expect(adapter.contents.at(-1)?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);

      await projector.stop();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      projector = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "test-projector-2",
        now: () => 30,
        loadSource: async () => "export default 'immutable';",
      });
      await projector.start();
      expect(store.getSurfaceBinding("run-1")?.messageRef).toEqual(firstRef);
      expect(adapter.edits).toBeGreaterThan(0);
      await projector.stop();

      adapter.failNextRead = true;
      const transientLookup = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "test-projector-transient-read",
        now: () => 35,
        loadSource: async () => "export default 'immutable';",
      });
      const sendsBeforeTransientLookup = adapter.sends;
      await transientLookup.start();
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: firstRef,
        lastError: "transient lookup failure",
      });
      expect(adapter.sends).toBe(sendsBeforeTransientLookup);
      await transientLookup.stop();

      adapter.messages.delete(firstRef.messageId);
      const restarted = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "test-projector-3",
        now: () => 40,
        loadSource: async () => "export default 'immutable';",
      });
      await restarted.start();
      expect(store.getSurfaceBinding("run-1")?.messageRef?.messageId).toBe("card-2");

      expect(
        store.tryClaimApprovedRun({ runId: "run-1", claimerId: "engine", now: 50 })?.state,
      ).toBe("running");
      expect(
        store.createOperation(
          {
            runId: "run-1",
            operationId: "operation-sensitive",
            callSiteId: "site-sensitive",
            parentOperationId: null,
            phase: "secret phase value",
            label: "secret wait prompt value",
            kind: "wait",
            input: {},
            inputSha256: HASH_A,
            state: "succeeded",
            attempt: 0,
            requestId: null,
            output: null,
            resultArtifactId: null,
            error: null,
            usage: null,
            claimedBy: null,
            claimedAt: null,
            createdAt: 50,
            startedAt: 50,
            updatedAt: 50,
            terminalAt: 50,
          },
          "engine",
        ),
      ).toBe(true);
      expect(
        store.transitionRun({
          runId: "run-1",
          from: "running",
          to: "succeeded",
          now: 51,
          detail: "Origin request ended; workflow card remains",
          result: { directory: "src", token: "secret" },
        }),
      ).toBe(true);
      const terminalRef = await restarted.ensureInitialCard("run-1");
      expect(terminalRef.messageId).toBe("card-2");
      expect(adapter.messages.has("card-2")).toBe(true);
      expect(adapter.contents.at(-1)?.actions).toEqual([]);
      expect(adapter.contents.at(-1)?.text).toContain("State: **succeeded**");
      expect(adapter.contents.at(-1)?.text).not.toContain('"token": "secret"');
      expect(adapter.contents.at(-1)?.text).not.toContain("Origin request ended");
      expect(adapter.contents.at(-1)?.text).not.toContain("secret phase value");
      expect(adapter.contents.at(-1)?.text).not.toContain("secret wait prompt value");
      expect(adapter.contents.at(-1)?.text?.length).toBeLessThanOrEqual(4_000);

      const terminalView = await buildWorkflowProgressView({ store, runId: "run-1", now: 52 });
      const githubTerminal = renderWorkflowProgressView({
        view: terminalView,
        platform: "github",
        actions: [],
      });
      const markedGithubTerminal = markGithubAgentComment(githubTerminal.text);
      expect(markedGithubTerminal).toContain("State: **succeeded**");
      expect(markedGithubTerminal).toContain('"token": "<redacted>"');
      expect(markedGithubTerminal).not.toContain('"token": "secret"');
      expect(isMarkedGithubAgentComment(markedGithubTerminal)).toBe(true);
      await restarted.stop();
    } finally {
      store.close();
      await bus.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("clears an authoritative edit-time 404 and recreates the card on retry", async () => {
    const dbPath = join(tmpdir(), `workflow-projector-edit-404-${crypto.randomUUID()}.sqlite`);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const store = new DurableWorkflowStore(dbPath);
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "test-projector-edit-404",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const first = await projector.ensureInitialCard("run-1");
      expect(
        store.transitionApproval({
          approvalId: "approval-1",
          from: "pending",
          to: "approved",
          now: 21,
          actorPlatform: "discord",
          actorUserId: "user-1",
        }),
      ).toBe(true);
      adapter.failNextEditNotFound = true;
      await expect(projector.ensureInitialCard("run-1")).rejects.toThrow("could not be created");
      expect(store.getSurfaceBinding("run-1")?.messageRef).toBeNull();
      const recreated = await projector.ensureInitialCard("run-1");
      expect(recreated.messageId).not.toBe(first.messageId);
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("rechecks retry bindings before unchanged-hash short-circuiting", async () => {
    const dbPath = join(tmpdir(), `workflow-projector-retry-lookup-${crypto.randomUUID()}.sqlite`);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const store = new DurableWorkflowStore(dbPath);
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "test-projector-retry-lookup",
      now: () => 20,
    });
    try {
      createInvocation(store);
      const first = await projector.ensureInitialCard("run-1");
      const binding = store.getSurfaceBinding("run-1");
      if (!binding) throw new Error("surface binding missing");
      store.upsertSurfaceBinding({
        ...binding,
        lastError: "transient lookup failure",
        retryCount: 1,
        nextAttemptAt: 20,
        updatedAt: 20,
      });
      const editsBefore = adapter.edits;
      const readsBefore = adapter.reads;
      expect((await projector.ensureInitialCard("run-1")).messageId).toBe(first.messageId);
      expect(adapter.reads).toBe(readsBefore + 1);
      expect(adapter.edits).toBe(editsBefore);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        retryCount: 0,
        lastError: null,
        nextAttemptAt: null,
      });

      const foundBinding = store.getSurfaceBinding("run-1");
      if (!foundBinding) throw new Error("surface binding missing after retry");
      store.upsertSurfaceBinding({
        ...foundBinding,
        lastError: "retry authoritative lookup",
        retryCount: 1,
        nextAttemptAt: 20,
        updatedAt: 20,
      });
      adapter.messages.delete(first.messageId);
      const recreated = await projector.ensureInitialCard("run-1");
      expect(recreated.messageId).not.toBe(first.messageId);
      expect(store.getSurfaceBinding("run-1")).toMatchObject({
        messageRef: recreated,
        retryCount: 0,
        lastError: null,
      });
    } finally {
      await projector.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("persists projection failures, retries, and coalesces repeated wakeups", async () => {
    const dbPath = join(tmpdir(), `workflow-projector-retry-${crypto.randomUUID()}.sqlite`);
    const adapter = new ProjectionAdapter();
    const bus = createLilacBus(new IdleRawBus());
    const store = new DurableWorkflowStore(dbPath);
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "test-projector-retry",
      now: () => 100,
      coalesceMs: 5,
      minEditIntervalMs: 0,
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
        lastError: "transient surface failure",
      });
      await projector.ensureInitialCard("run-1");
      expect(store.getSurfaceBinding("run-1")).toMatchObject({ retryCount: 0, lastError: null });

      store.transitionApproval({
        approvalId: "approval-1",
        from: "pending",
        to: "approved",
        now: 101,
      });
      const before = adapter.edits;
      projector.requestProjection("run-1");
      projector.requestProjection("run-1");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(adapter.edits - before).toBe(1);
    } finally {
      await projector.stop();
      store.close();
      await bus.close();
      rmSync(dbPath, { force: true });
    }
  });
});
