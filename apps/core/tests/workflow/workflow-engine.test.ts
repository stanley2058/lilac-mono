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
import { WorkflowEngine } from "../../src/workflow/workflow-engine";
import { canonicalJsonSha256, sha256 } from "../../src/workflow/workflow-definition";
import { normalizeWorkflowCapabilityProfile } from "../../src/workflow/workflow-domain";
import { WorkflowWaitResolver } from "../../src/workflow/workflow-wait-resolver";
import { readWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-store";

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

function createApprovedRun(
  store: DurableWorkflowStore,
  runId = "run-1",
  args: Record<string, boolean> = {},
  outputLimits: { operation: number; result: number } = { operation: 10_000, result: 10_000 },
) {
  const revision = {
    revisionId: "revision-1",
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot: "/workspace",
    scope: "project" as const,
    normalizedPath: "audit.js",
    name: "audit",
    snapshotArtifactId: `workflow-source:${HASH_A}`,
    sourceSha256: HASH_A,
    inputSchemaSha256: HASH_B,
    capabilitySha256: "c".repeat(64),
    metadata: { name: "audit", description: "Audit" },
    inputSchema: { type: "object", additionalProperties: false },
    capabilities: normalizeWorkflowCapabilityProfile({
      agents: {
        profiles: ["explore"],
        models: ["inherit"],
        editing: false,
        isolation: "shared",
        maxConcurrent: 2,
        maxTotal: 4,
      },
      maxNestingDepth: 4,
      maxWallTimeMs: 10_000,
      operationIdleTimeoutMs: 2_000,
      waits: ["reply", "sleep"],
      surfaceSends: false,
      externalTools: false,
      safety: { originatingMode: "trusted", escalation: "none" },
    }),
    limits: {
      maxSourceBytes: 100_000,
      maxInputBytes: 10_000,
      maxOperationOutputBytes: outputLimits.operation,
      maxResultBytes: outputLimits.result,
      maxRuntimeMemoryBytes: 256 * 1024 * 1024,
    },
    runtimeVersion: "lilac-workflow-js-v1",
    createdAt: 1,
  };
  const invocation = store.createInvocation({
    revision,
    run: {
      runId,
      revisionId: revision.revisionId,
      approvalId: null,
      state: "awaiting_review",
      inputSchemaSnapshot: revision.inputSchema,
      args,
      argsSha256: canonicalJsonSha256(args),
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
      approvalId: "approval-1",
      revisionId: revision.revisionId,
      state: "pending",
      expectedReviewerPlatform: "discord",
      expectedReviewerUserId: "user-1",
      firstRunId: runId,
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
  store.transitionApproval({
    approvalId: invocation.approval.approvalId,
    from: "pending",
    to: "approved",
    now: 2,
  });
  return invocation;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for workflow state");
    await Bun.sleep(10);
  }
}

describe("WorkflowEngine", () => {
  it("journals deterministic operations, captures usage/output, and caches replayed calls", async () => {
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
      dataDir: "/unused",
      subscriptionId: "test-workflow-engine",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: (async () => {
          await input.onCall({
            type: "call",
            id: 1,
            kind: "phase",
            callSiteId: "site-phase",
            occurrence: 0,
            path: "root:site-phase:0",
            parentPath: null,
            phase: null,
            depth: 0,
            input: { name: "audit" },
          });
          const call = {
            type: "call" as const,
            id: 2,
            kind: "agent" as const,
            callSiteId: "site-agent",
            occurrence: 0,
            path: "root:site-agent:0",
            parentPath: null,
            phase: "audit",
            depth: 1,
            input: { prompt: "inspect", options: { label: "Inspect" } },
          };
          const first = await input.onCall(call);
          const cached = await input.onCall(call);
          return { first, cached };
        })(),
      }),
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
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");
      await waitFor(() => store.getRun("run-2")?.state === "succeeded");
      expect(dispatches).toBe(2);
      expect(store.getRun("run-1")?.result).toEqual({
        first: "agent output",
        cached: "agent output",
      });
      const operations = store.listOperations("run-1", { limit: 100 });
      const secondOperations = store.listOperations("run-2", { limit: 100 });
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

  it("fails closed when approval is revoked immediately before claim", () => {
    const dbPath = join(tmpdir(), `workflow-engine-approval-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    try {
      createApprovedRun(store);
      store.transitionApproval({
        approvalId: "approval-1",
        from: "approved",
        to: "revoked",
        now: 3,
        reason: "race",
      });
      expect(store.tryClaimApprovedRun({ runId: "run-1", claimerId: "worker", now: 4 })).toBeNull();
      expect(store.getRun("run-1")?.state).toBe("paused");
    } finally {
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("reclaims a crashed running run and replays completed operations without dispatch", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-restart-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    const claimed = store.tryClaimApprovedRun({ runId: "run-1", claimerId: "dead", now: 3 });
    expect(claimed?.state).toBe("running");
    store.createOperation({
      runId: "run-1",
      operationId: `wfop:${sha256("root:site-agent:0").slice(0, 40)}`,
      callSiteId: "site-agent",
      parentOperationId: null,
      phase: null,
      label: null,
      kind: "agent",
      input: { prompt: "inspect", options: {} },
      inputSha256: canonicalJsonSha256({ prompt: "inspect", options: {} }),
      state: "succeeded",
      attempt: 0,
      requestId: "wfr:completed",
      output: "cached",
      resultArtifactId: null,
      error: null,
      usage: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: 3,
      startedAt: 3,
      updatedAt: 3,
      terminalAt: 3,
    });
    let dispatches = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: "/unused",
      subscriptionId: "test-workflow-restart",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call",
          id: 1,
          kind: "agent",
          callSiteId: "site-agent",
          occurrence: 0,
          path: "root:site-agent:0",
          parentPath: null,
          phase: null,
          depth: 0,
          input: { prompt: "inspect", options: {} },
        }),
      }),
      dispatchAgentRequest: async () => {
        dispatches += 1;
        return { state: "resolved", output: "duplicate", detail: null, usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");
      expect(store.getRun("run-1")?.result).toBe("cached");
      expect(dispatches).toBe(0);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("fails operations that exceed approved output limits", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-limits-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    createApprovedRun(store, "run-failure");
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: "/unused",
      subscriptionId: "test-workflow-limits",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call",
          id: 1,
          kind: "agent",
          callSiteId: "site-agent",
          occurrence: 0,
          path: "root:site-agent:0",
          parentPath: null,
          phase: null,
          depth: 1,
          input: { prompt: "inspect", options: {} },
        }),
      }),
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
              output: "x".repeat(10_001),
              detail: null,
              usage: null,
            },
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "failed");
      await waitFor(() => store.getRun("run-failure")?.state === "failed");
      expect(store.getRun("run-1")?.terminalDetail).toContain("output exceeds 10000 bytes");
      expect(store.listOperations("run-1")[0]).toMatchObject({ state: "failed" });
      expect(store.listOperations("run-failure")[0]).toMatchObject({
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
    const largeOutput = "x".repeat(70_000);
    createApprovedRun(store, "run-artifact", {}, { operation: 100_000, result: 100_000 });
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: root,
      subscriptionId: "test-workflow-artifacts",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call",
          id: 1,
          kind: "agent",
          callSiteId: "site-agent",
          occurrence: 0,
          path: "root:site-agent:0",
          parentPath: null,
          phase: null,
          depth: 0,
          input: { prompt: "large", options: {} },
        }),
      }),
      dispatchAgentRequest: async () => ({
        state: "resolved",
        output: largeOutput,
        detail: null,
        usage: null,
      }),
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-artifact")?.state === "succeeded");
      const operation = store.listOperations("run-artifact")[0];
      const run = store.getRun("run-artifact");
      expect(operation).toMatchObject({ output: null, resultArtifactId: expect.any(String) });
      expect(run).toMatchObject({ result: null, resultArtifactId: expect.any(String) });
      await engine.stop();
      store.close();

      const reopened = new DurableWorkflowStore(dbPath);
      const persistedOperation = reopened.listOperations("run-artifact")[0]!;
      const persistedRun = reopened.getRun("run-artifact")!;
      await expect(
        readWorkflowValueArtifact({
          dataDir: root,
          artifactId: persistedOperation.resultArtifactId!,
          maxBytes: 100_000,
        }),
      ).resolves.toBe(largeOutput);
      await expect(
        readWorkflowValueArtifact({
          dataDir: root,
          artifactId: persistedRun.resultArtifactId!,
          maxBytes: 100_000,
        }),
      ).resolves.toBe(largeOutput);
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
      dataDir: "/unused",
      subscriptionId: "test-workflow-controls",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => {
        launches += 1;
        return {
          cancel: async () => {},
          result: input.onCall({
            type: "call",
            id: 1,
            kind: "agent",
            callSiteId: "site-agent",
            occurrence: 0,
            path: "root:site-agent:0",
            parentPath: null,
            phase: null,
            depth: 0,
            input: { prompt: "inspect", options: {} },
          }),
        };
      },
      dispatchAgentRequest: async ({ run, signal }) => {
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
      await waitFor(() => store.listOperations("run-1", { state: "dispatched" }).length === 1);
      expect(store.transitionRun({ runId: "run-1", from: "running", to: "paused", now: 10 })).toBe(
        true,
      );
      await waitFor(() => store.listOperations("run-1", { state: "queued" }).length === 1);
      expect(store.listOperations("run-1")[0]?.attempt).toBe(1);
      expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now: 11 })).toBe(
        true,
      );
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");
      expect(store.getRun("run-1")?.result).toBe("resumed");
      expect(launches).toBe(2);

      createApprovedRun(store, "run-cancel");
      await waitFor(() => store.listOperations("run-cancel", { state: "dispatched" }).length === 1);
      expect(
        store.transitionRun({
          runId: "run-cancel",
          from: "running",
          to: "cancelled",
          now: 12,
          detail: "test cancellation",
        }),
      ).toBe(true);
      await waitFor(() => store.listOperations("run-cancel", { state: "cancelled" }).length === 1);
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
      dataDir: "/unused",
      subscriptionId: "test-engine-waits",
      now: () => now,
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call",
          id: 1,
          kind: input.args["timeout"] === true ? "waitForReply" : "sleep",
          callSiteId: input.args["timeout"] === true ? "site-reply" : "site-sleep",
          occurrence: 0,
          path: input.args["timeout"] === true ? "root:site-reply:0" : "root:site-sleep:0",
          parentPath: null,
          phase: null,
          depth: 0,
          input: input.args["timeout"] === true ? { timeoutMs: 10 } : 10,
        }),
      }),
    });
    try {
      await resolver.start();
      await engine.start();
      await waitFor(() => store.getRun("run-sleep")?.state === "blocked");
      await waitFor(() => store.getRun("run-timeout")?.state === "blocked");
      now = 110;
      await resolver.reconcileTimers();
      await waitFor(() => store.getRun("run-sleep")?.state === "succeeded");
      await waitFor(() => store.getRun("run-timeout")?.state === "failed");
      expect(store.listOperations("run-sleep")[0]).toMatchObject({
        kind: "wait",
        state: "succeeded",
      });
      expect(store.listOperations("run-timeout")[0]).toMatchObject({
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
    const makeEngine = () =>
      new WorkflowEngine({
        bus,
        store,
        dataDir: "/unused",
        subscriptionId: `test-reply-restart-${crypto.randomUUID()}`,
        pollMs: 5,
        assertSandbox: async () => {},
        loadSnapshot: async () => "immutable",
        compileSource: (source) => source,
        startSandbox: (input) => ({
          cancel: async () => {},
          result: input.onCall({
            type: "call",
            id: 1,
            kind: "waitForReply",
            callSiteId: "site-reply",
            occurrence: 0,
            path: "root:site-reply:0",
            parentPath: null,
            phase: null,
            depth: 0,
            input: { messageId: "anchor-1", timeoutMs: 1_000 },
          }),
        }),
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
      await waitFor(() => store.getRun("run-reply")?.state === "blocked");
      await engine.stop();
      expect(
        store.getWait("run-reply", store.listOperations("run-reply")[0]!.operationId)?.state,
      ).toBe("pending");
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
      engine = makeEngine();
      await engine.start();
      await waitFor(() => store.getRun("run-reply")?.state === "succeeded");
      expect(store.getRun("run-reply")?.result).toMatchObject({ text: "continue" });
      expect(store.listOperations("run-reply")).toHaveLength(1);
    } finally {
      await engine.stop();
      await resolver.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
