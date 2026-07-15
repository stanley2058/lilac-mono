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
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
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
import { GithubApiError } from "../../src/github/github-api";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

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

class ProjectionAdapter implements SurfaceAdapter {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;
  edits = 0;
  failNextSend = false;
  failNextRead = false;
  failNextEditNotFound = false;

  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: "discord" as const, userId: "bot", userName: "bot" };
  }
  async getCapabilities() {
    return {
      platform: "discord" as const,
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
    const ref: MsgRef = {
      platform: "discord",
      channelId: session.channelId,
      messageId: `card-${this.sends}`,
    };
    this.messages.set(ref.messageId, {
      ref,
      session: { platform: "discord", channelId: session.channelId },
      userId: "bot",
      text: content.text ?? "",
      ts: Date.now(),
    });
    return ref;
  }
  async readMsg(ref: MsgRef) {
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
      throw new GithubApiError(404, "/issues/comments/missing", "missing");
    }
    this.edits += 1;
    this.contents.push(content);
    const current = this.messages.get(ref.messageId);
    if (!current) throw new Error("message missing");
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

function createInvocation(store: DurableWorkflowStore) {
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
        client: "discord",
        userId: "user-1",
        safetyMode: "trusted",
        projectCwd: "/workspace",
      },
      completionTarget: { kind: "durable_surface" },
      progressTarget: {
        platform: "discord",
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
      expectedReviewerPlatform: "discord",
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

describe("WorkflowProgressProjector", () => {
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
