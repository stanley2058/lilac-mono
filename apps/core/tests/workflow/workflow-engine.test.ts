import { describe, expect, it } from "bun:test";
import { rmSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  createLilacBus,
  lilacEventTypes,
  outReqTopic,
  type FetchOptions,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { WorkflowEngine, workflowAgentRequestId } from "../../src/workflow/workflow-engine";
import { ensureWorkflowRunScratch } from "../../src/workflow/workflow-scratch";
import type { WorkflowRequestPolicy } from "../../src/workflow/workflow-request-authority";
import { canonicalJsonSha256, sha256 } from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowResourcePolicy,
  WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
  type WorkflowCompletionTarget,
} from "../../src/workflow/workflow-domain";
import { WorkflowWaitResolver } from "../../src/workflow/workflow-wait-resolver";
import { readWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-store";
import { readWorkflowWorktreePatch } from "../../src/workflow/workflow-worktree-artifact";

const HASH_A = "a".repeat(64);

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

class TerminalReceiptReadStore extends DurableWorkflowStore {
  onMissingTerminalReceipt: (() => void) | null = null;

  override getWorkflowRequestTerminalReceipt(requestId: string) {
    const receipt = super.getWorkflowRequestTerminalReceipt(requestId);
    if (!receipt) {
      const observer = this.onMissingTerminalReceipt;
      this.onMissingTerminalReceipt = null;
      observer?.();
    }
    return receipt;
  }
}

class CapturingRawBus implements RawBus {
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];
  readonly history: Message<unknown>[] = [];

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
  async fetch<TData>(topic: string, _options: FetchOptions) {
    return {
      messages: this.history
        .filter((message) => message.topic === topic)
        .map((msg) => ({ msg: msg as Message<TData>, cursor: msg.id })),
    };
  }
  async watermark(topic: string) {
    return this.history.filter((message) => message.topic === topic).at(-1)?.id ?? null;
  }
  async close() {}
}

class FailingInterruptRawBus extends CapturingRawBus {
  readonly interruptAttempts: string[] = [];
  private failNextInterrupt = true;

  override async publish<TData>(
    message: Omit<Message<TData>, "id" | "ts">,
    options: PublishOptions,
  ) {
    const data = z.object({ queue: z.string() }).safeParse(message.data);
    if (
      message.type === lilacEventTypes.CmdRequestMessage &&
      data.success &&
      data.data.queue === "interrupt"
    ) {
      this.interruptAttempts.push(message.headers?.request_id ?? "missing");
      if (this.failNextInterrupt) {
        this.failNextInterrupt = false;
        throw new Error("injected interrupt failure");
      }
    }
    return await super.publish(message, options);
  }
}

class LiveCapturingRawBus implements RawBus {
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];
  private sequence = 0;
  private readonly subscriptions = new Set<{
    topic: string;
    handler: (message: Message<unknown>, context: HandleContext) => Promise<void>;
  }>();

  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
    this.messages.push(message);
    const id = `${++this.sequence}-0`;
    const stored: Message<TData> = { ...message, id, ts: Date.now(), topic: options.topic };
    for (const subscription of this.subscriptions) {
      if (subscription.topic === options.topic) {
        await subscription.handler(stored, { cursor: id, commit: async () => {} });
      }
    }
    return { id, cursor: id };
  }

  async subscribe<TData>(
    topic: string,
    _options: SubscriptionOptions,
    handler: (message: Message<TData>, context: HandleContext) => Promise<void>,
  ) {
    const subscription = {
      topic,
      handler: (message: Message<unknown>, context: HandleContext) =>
        handler(message as Message<TData>, context),
    };
    this.subscriptions.add(subscription);
    return { stop: async () => void this.subscriptions.delete(subscription) };
  }

  async fetch<TData>(_topic: string, _options: FetchOptions) {
    return { messages: [] as Array<{ msg: Message<TData>; cursor: string }> };
  }

  async close() {
    this.subscriptions.clear();
  }
}

function createTrustedRun(
  store: DurableWorkflowStore,
  runId = "run-1",
  args: Record<string, boolean> = {},
  outputLimits: { operation: number; result: number } = { operation: 10_000, result: 10_000 },
  completionTarget: WorkflowCompletionTarget = { kind: "detached" },
  maxWallTimeMs = 10_000,
  editing = false,
  canonicalWorkspaceRoot = process.cwd(),
  mixedEditing = false,
  operationIdleTimeoutMs = 2_000,
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
    maxWallTimeMs,
    operationIdleTimeoutMs,
    waits: ["reply", "sleep"],
    safety: { originatingMode: "trusted", escalation: "none" },
  });
  const limits = {
    maxSourceBytes: 100_000,
    maxInputBytes: 10_000,
    maxOperationOutputBytes: outputLimits.operation,
    maxResultBytes: outputLimits.result,
    maxRuntimeMemoryBytes: 256 * 1024 * 1024,
  };
  const revision = {
    revisionId: "revision-1",
    canonicalProjectId: "project-1",
    canonicalWorkspaceRoot,
    scope: "project" as const,
    normalizedPath: "audit.js",
    name: "audit",
    snapshotArtifactId: `workflow-source:${HASH_A}`,
    sourceSha256: HASH_A,
    inputSchemaSha256: canonicalJsonSha256(inputSchema),
    resourcePolicySha256: canonicalJsonSha256({ resources, limits }),
    metadata: { name: "audit", description: "Audit" },
    inputSchema,
    resources,
    limits,
    runtimeVersion: "lilac-workflow-js-v3",
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
        userId: "user-1",
        safetyMode: "trusted",
        projectCwd: canonicalWorkspaceRoot,
      },
      completionTarget,
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
  });
  return invocation;
}

const createApprovedRun = createTrustedRun;

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for workflow state");
    await Bun.sleep(10);
  }
}

function persistedAgentInput(prompt: string, editing = false, cwd = process.cwd()) {
  const stats = statSync(cwd, { bigint: true });
  const identity = { dev: stats.dev.toString(10), ino: stats.ino.toString(10) };
  return {
    prompt,
    options: {
      profile: editing ? "general" : "explore",
      cwd,
      cwdIdentity: identity,
      authorityRoot: cwd,
      authorityRootIdentity: identity,
      isolation: editing ? "worktree" : "shared",
    },
  };
}

describe("WorkflowEngine", () => {
  it("cleans only retained terminal run scratch after the bounded retention window", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "workflow-scratch-cleanup-"));
    const dbPath = join(root, "workflow.sqlite");
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store, "run-cleanup");
    expect(
      store.cancelRunAndChildren({ runId: "run-cleanup", now: 10, detail: "complete" })?.state,
    ).toBe("cancelled");
    const scratch = await ensureWorkflowRunScratch({ dataDir: root, runId: "run-cleanup" });
    await fs.utimes(scratch, new Date(0), new Date(0));
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: root,
      subscriptionId: "scratch-cleanup",
      now: () => 8 * 24 * 60 * 60 * 1_000,
      assertSandbox: async () => {},
    });
    try {
      await engine.start();
      await expect(fs.lstat(scratch)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retains old family scratch while a generated family run is active", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "workflow-family-scratch-cleanup-"));
    const dbPath = join(root, "workflow.sqlite");
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store, "run-parent");
    expect(
      store.cancelRunAndChildren({ runId: "run-parent", now: 10, detail: "complete" })?.state,
    ).toBe("cancelled");
    const scratch = await ensureWorkflowRunScratch({ dataDir: root, runId: "run-parent" });
    createApprovedRun(
      store,
      "run-child",
      {},
      { operation: 10_000, result: 10_000 },
      {
        kind: "live_parent",
        parentRequestId: "wfr:parent",
        parentSessionId: "workflow:parent",
        parentRequestClient: "discord",
        parentToolCallId: "tool:delegate",
        childRequestId: "sub:child",
        childSessionId: "sub:session",
        profile: "explore",
        sessionName: "child",
        depth: 1,
        reasoning: null,
        fallbackToSurface: false,
        fallbackProgressTarget: null,
        deferredDelivery: true,
        familyScratchRoot: scratch,
      },
    );
    await fs.utimes(scratch, new Date(0), new Date(0));
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: root,
      subscriptionId: "family-scratch-cleanup",
      now: () => 8 * 24 * 60 * 60 * 1_000,
      assertSandbox: async () => {},
    });
    try {
      await engine.start();
      expect((await fs.lstat(scratch)).isDirectory()).toBe(true);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
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
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
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
      dataDir: dirname(dbPath),
      subscriptionId: "mixed-operation-authority",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => {
        const calls = [
          { path: "root:edit-a:0", callSiteId: "edit-a", profile: "general", editing: true },
          { path: "root:edit-b:0", callSiteId: "edit-b", profile: "general", editing: true },
          { path: "root:read-a:0", callSiteId: "read-a", profile: "explore", editing: false },
          { path: "root:read-b:0", callSiteId: "read-b", profile: "explore", editing: false },
        ] as const;
        return {
          cancel: async () => {},
          result: Promise.all(
            calls.map((call, index) =>
              input.onCall({
                type: "call",
                id: index + 1,
                kind: "agent",
                callSiteId: call.callSiteId,
                occurrence: 0,
                path: call.path,
                parentPath: null,
                phase: null,
                depth: 0,
                input: {
                  prompt: call.callSiteId,
                  options: call.editing
                    ? { profile: call.profile, isolation: "shared" }
                    : { profile: call.profile },
                },
              }),
            ),
          ),
        };
      },
      dispatchAgentRequest: async ({ policy }) => {
        active += 1;
        if (policy.profile !== "explore") activeEditors += 1;
        maxActive = Math.max(maxActive, active);
        maxEditors = Math.max(maxEditors, activeEditors);
        if (activeEditors === 2) releaseEditors();
        if (policy.profile !== "explore") {
          await Promise.race([
            editorsOverlapped,
            Bun.sleep(1_000).then(() => {
              throw new Error("shared writers did not overlap");
            }),
          ]);
        } else {
          await Bun.sleep(30);
        }
        if (policy.profile !== "explore") activeEditors -= 1;
        active -= 1;
        return { state: "resolved", output: policy.operationId, detail: null, usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");
      expect(
        store.listOperations("run-1").filter((operation) => operation.kind === "agent"),
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

  it("rejects worktree isolation before preparation or dispatch", async () => {
    const dbPath = join(tmpdir(), `workflow-parallel-worktrees-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
      process.cwd(),
      true,
    );
    let prepareCalls = 0;
    let dispatchCalls = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "parallel-worktree-authority",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      prepareWorktree: async () => {
        prepareCalls += 1;
        return { path: "/must-not-exist", baseCommit: "a".repeat(40) };
      },
      startSandbox: (input) => ({
        cancel: async () => {},
        result: Promise.all(
          ["editor-a", "editor-b"].map((callSiteId, index) =>
            input.onCall({
              type: "call",
              id: index + 1,
              kind: "agent",
              callSiteId,
              occurrence: 0,
              path: `root:${callSiteId}:0`,
              parentPath: null,
              phase: null,
              depth: 0,
              input: {
                prompt: callSiteId,
                options: { profile: "general", isolation: "worktree" },
              },
            }),
          ),
        ),
      }),
      dispatchAgentRequest: async () => {
        dispatchCalls += 1;
        return { state: "failed", output: "", detail: "test stop", usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "failed");
      expect(prepareCalls).toBe(0);
      expect(dispatchCalls).toBe(0);
      expect(store.getRun("run-1")?.terminalDetail).toContain(
        "worktree isolation is temporarily unavailable",
      );
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
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
      workspace,
    );
    const dispatchedCwds: string[] = [];
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "actual-data-dir-cwd",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call" as const,
          id: 1,
          kind: "agent" as const,
          callSiteId: "site-agent",
          occurrence: 0,
          path: "root:site-agent:0",
          parentPath: null,
          phase: null,
          depth: 0,
          input: {
            prompt: "work in nested cwd",
            options: { profile: "general", cwd: requestedCwd },
          },
        }),
      }),
      dispatchAgentRequest: async (request) => {
        dispatchedCwds.push(request.agentCwd);
        return { state: "failed", output: "", detail: "test complete", usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "failed");
      expect(dispatchedCwds).toEqual([requestedCwd]);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the complete durable model request for stale redispatch", async () => {
    const dbPath = join(tmpdir(), `workflow-stale-policy-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
    );
    let now = 10;
    let firstDispatched = false;
    let replacementResolutions = 0;
    const recoveredPolicies: WorkflowRequestPolicy[] = [];
    const startSandbox = (
      input: Parameters<
        NonNullable<ConstructorParameters<typeof WorkflowEngine>[0]["startSandbox"]>
      >[0],
    ) => ({
      cancel: async () => {},
      result: input.onCall({
        type: "call" as const,
        id: 1,
        kind: "agent" as const,
        callSiteId: "site-agent",
        occurrence: 0,
        path: "root:site-agent:0",
        parentPath: null,
        phase: null,
        depth: 0,
        input: { prompt: "durable request", options: { profile: "general" } },
      }),
    });
    const first = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "stale-policy-first",
      pollMs: 5,
      now: () => now,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox,
      validateAgentSelection: () => ({
        model: "provider/model-a",
        reasoning: "high",
        request: {
          alias: "durable-alias",
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          reasoningDisplay: "detailed",
          providerOptions: { provider: { route: "pinned" } },
          reasoning: "high",
          responseCommentary: true,
          anthropicPromptCache: true,
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
      dataDir: dirname(dbPath),
      subscriptionId: "stale-policy-replacement",
      pollMs: 5,
      now: () => now,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox,
      validateAgentSelection: () => {
        replacementResolutions += 1;
        return {
          model: "provider/model-b",
          reasoning: "low",
          request: {
            spec: "provider/model-b",
            provider: "provider",
            modelId: "model-b",
            reasoningDisplay: "none",
          },
        };
      },
      dispatchAgentRequest: async (request) => {
        recoveredPolicies.push(request.policy);
        return { state: "failed", output: "", detail: "test complete", usage: null };
      },
    });
    try {
      await first.start();
      await waitFor(() => firstDispatched);
      expect(store.pauseRunAndChildren({ runId: "run-1", now: 11, detail: "pause" })?.state).toBe(
        "paused",
      );
      await first.stop();
      now = 40_100;
      expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now })).toBe(true);
      await replacement.start();
      await waitFor(() => recoveredPolicies.length > 0);
      expect(replacementResolutions).toBe(0);
      expect(recoveredPolicies[0]?.resolvedModelRequest).toEqual({
        alias: "durable-alias",
        spec: "provider/model-a",
        provider: "provider",
        modelId: "model-a",
        providerOptions: { provider: { route: "pinned" } },
        reasoning: "high",
        responseCommentary: true,
        anthropicPromptCache: true,
        reasoningDisplay: "detailed",
      });
    } finally {
      await replacement.stop();
      await first.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
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
      const operationId = `wfop:${sha256("root:site-agent:0").slice(0, 40)}`;
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
          headers,
          data: { finalText: "historical result" },
        },
        {
          topic: "evt.request",
          id: "2-0",
          ts: 11,
          type: lilacEventTypes.EvtRequestLifecycleChanged,
          headers,
          data: { state: terminalState, ts: 11 },
        },
      );
      const engine = new WorkflowEngine({
        bus,
        store,
        dataDir: dirname(dbPath),
        subscriptionId: `terminal-${terminalState}`,
        pollMs: 5,
        assertSandbox: async () => {},
        loadSnapshot: async () => "immutable",
        compileSource: (source) => source,
        createDispatchEpoch: () => dispatchEpoch,
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
            input: { prompt: "inspect", options: { profile: "explore" } },
          }),
        }),
      });
      try {
        await engine.start();
        await waitFor(() => store.getRun("run-1")?.state === "paused");
        expect(store.getRun("run-1")?.terminalDetail).toBe(WORKFLOW_MANUAL_RECONCILIATION_DETAIL);
        expect(store.listOperations("run-1")[0]).toMatchObject({
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
      const responder = await bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: `mismatch-${lifecycleState}`, offset: { type: "now" } },
        async (message, context) => {
          if (
            message.type === lilacEventTypes.CmdRequestMessage &&
            message.data.queue === "prompt"
          ) {
            const requestId = message.headers?.request_id;
            if (!requestId) throw new Error("Missing workflow request ID");
            const workflow = z
              .object({
                workflow: z.object({
                  runId: z.string(),
                  operationId: z.string(),
                  dispatchEpoch: z.string(),
                  controlToken: z.string(),
                }),
              })
              .parse(message.data.raw).workflow;
            expect(
              store.claimWorkflowRequest({
                requestId,
                token: workflow.controlToken,
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
          await context.commit();
        },
      );
      const engine = new WorkflowEngine({
        bus,
        store,
        dataDir: dirname(dbPath),
        subscriptionId: `mismatched-${lifecycleState}`,
        pollMs: 5,
        receiptPollMs: 10_000,
        now: () => 10,
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
            input: { prompt: "inspect", options: { profile: "explore" } },
          }),
        }),
      });
      try {
        await engine.start();
        await waitFor(() => store.getRun("run-1")?.state === "paused");
        expect(store.getRun("run-1")?.terminalDetail).toBe(WORKFLOW_MANUAL_RECONCILIATION_DETAIL);
        expect(store.listOperations("run-1")[0]).toMatchObject({
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
        await responder.stop();
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
      dataDir: dirname(dbPath),
      subscriptionId: "manual-block",
      pollMs: 5,
      assertSandbox: async () => {},
    });
    try {
      await engine.start();
      await Bun.sleep(25);
      expect(store.getRun("run-1")).toMatchObject({
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
      dataDir: dirname(dbPath),
      subscriptionId: "terminal-race",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      beforePromptPublication: async ({
        requestId,
        runId,
        operationId,
        dispatchEpoch,
        controlToken,
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
            token: controlToken,
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
          input: { prompt: "inspect", options: { profile: "explore" } },
        }),
      }),
    });
    try {
      await engine.start();
      await waitFor(() => receiptRecorded && store.getRun("run-1")?.state === "succeeded");
      expect(store.getRun("run-1")?.result).toBe("receipt result");
      expect(store.listOperations("run-1")[0]).toMatchObject({
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

  it("adopts a post-publication receipt when the runner crashes before terminal streams", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-live-receipt-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
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
      dataDir: dirname(dbPath),
      subscriptionId: "live-terminal-receipt",
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
          input: { prompt: "inspect", options: { profile: "explore" } },
        }),
      }),
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
      const command = raw.messages.find(
        (message) => message.type === lilacEventTypes.CmdRequestMessage,
      );
      if (!command?.headers) throw new Error("Missing workflow prompt command");
      const commandData = z
        .object({
          raw: z.object({
            workflow: z.object({ controlToken: z.string(), dispatchEpoch: z.string() }),
          }),
        })
        .parse(command.data);
      const requestId = command.headers["request_id"];
      const sessionId = command.headers["session_id"];
      if (!requestId || !sessionId) throw new Error("Missing workflow command identity");
      const authorized = store.authorizeWorkflowRequest({
        requestId,
        token: commandData.raw.workflow.controlToken,
        sessionId,
        platform: "unknown",
        now: Date.now(),
      });
      if (!authorized) throw new Error("Workflow command was not authorized");
      expect(
        store.claimWorkflowRequest({
          requestId,
          token: commandData.raw.workflow.controlToken,
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
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");
      expect(store.getRun("run-1")?.result).toBe("durable crash result");
      expect(store.listOperations("run-1")[0]).toMatchObject({
        state: "succeeded",
        output: "durable crash result",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      });
      expect(store.listPendingLiveParentCompletions("parent-crash", 100, true)).toMatchObject([
        { runId: "run-1", result: "durable crash result" },
      ]);
      expect(store.markLiveParentCompletionDelivered("run-1", Date.now())).toBe(true);
      expect(store.listPendingLiveParentCompletions("parent-crash", 100, true)).toEqual([]);
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
      { operation: 10_000, result: 10_000 },
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
      dataDir: dirname(dbPath),
      subscriptionId: "replacement-receipt-first",
      pollMs: 5,
      now: () => firstNow,
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
          input: { prompt: "inspect", options: { profile: "explore" } },
        }),
      }),
      dispatchAgentRequest: async (request) => {
        const controlToken = request.controlToken;
        if (!controlToken) throw new Error("Missing initial dispatch control token");
        const runOwnerId = store.getRun(request.run.runId)?.claimedBy;
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
            token: controlToken,
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
      dataDir: dirname(dbPath),
      subscriptionId: "replacement-receipt-second",
      pollMs: 5,
      now: () => 100_000,
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
          input: { prompt: "inspect", options: { profile: "explore" } },
        }),
      }),
      dispatchAgentRequest: async () => {
        replacementDispatches += 1;
        throw new Error("Replacement engine must adopt the receipt before dispatch");
      },
    });
    try {
      await first.start();
      await waitFor(() => receiptCommitted);
      await first.stop();
      expect(store.getRun("run-1")?.state).toBe("running");
      expect(store.listOperations("run-1")[0]?.state).toBe("dispatched");

      await replacement.start();
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");
      expect(replacementDispatches).toBe(0);
      expect(store.getRun("run-1")?.result).toBe("replacement receipt result");
      expect(store.listOperations("run-1")[0]).toMatchObject({
        state: "succeeded",
        output: "replacement receipt result",
        usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
      });
      expect(store.listPendingLiveParentCompletions("parent-replacement", 100, true)).toMatchObject(
        [{ runId: "run-1", result: "replacement receipt result" }],
      );
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
        { operation: 10_000, result: 10_000 },
        { kind: "detached" },
        120_000,
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
        dataDir: dirname(dbPath),
        subscriptionId: `${raceWindow}-receipt-first`,
        pollMs: 5,
        now: () => 10,
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
            input: { prompt: "inspect", options: { profile: "explore" } },
          }),
        }),
        dispatchAgentRequest: async (request) => {
          if (!request.controlToken) throw new Error("Missing initial control token");
          const runOwnerId = store.getRun(request.run.runId)?.claimedBy;
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
              token: request.controlToken,
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
            now: 70_000,
          }),
        ).toBe(true);
      };
      const replacement = new WorkflowEngine({
        bus,
        store,
        dataDir: dirname(dbPath),
        subscriptionId: `${raceWindow}-receipt-second`,
        pollMs: 5,
        now: () => 70_000,
        assertSandbox: async () => {},
        loadSnapshot: async () => "immutable",
        compileSource: (source) => source,
        createDispatchEpoch:
          raceWindow === "authorization"
            ? () => {
                commitReceipt();
                return "replacement-dispatch-epoch";
              }
            : undefined,
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
            input: { prompt: "inspect", options: { profile: "explore" } },
          }),
        }),
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
        await waitFor(() => ["succeeded", "failed"].includes(store.getRun("run-1")?.state ?? ""));
        expect(store.getRun("run-1")?.state).toBe("succeeded");
        expect(replacementDispatches).toBe(0);
        expect(store.getRun("run-1")?.result).toBe(`${raceWindow} receipt result`);
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
      { requestId: string; runId: string; operationId: string; dispatchEpoch: string }
    >();
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "pause-receipt",
      pollMs: 5,
      now: () => now,
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
          input: { prompt: "inspect", options: { profile: "explore" } },
        }),
      }),
      dispatchAgentRequest: async (request) => {
        dispatches += 1;
        if (!request.controlToken) throw new Error("Missing dispatch control token");
        const runOwnerId = store.getRun(request.run.runId)?.claimedBy;
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
            token: request.controlToken,
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
      await waitFor(() => store.listOperations("run-1")[0]?.state === "dispatched");
      expect(store.listOperations("run-1")[0]).toMatchObject({
        attempt: 0,
        requestId: captured.requestId,
      });
      now += 1;
      expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now })).toBe(true);
      await waitFor(() => ["succeeded", "failed"].includes(store.getRun("run-1")?.state ?? ""));
      expect(store.getRun("run-1")?.state).toBe("succeeded");
      expect(dispatches).toBe(1);
      expect(store.getRun("run-1")?.result).toBe("receipt survived pause");
      expect(store.listOperations("run-1")[0]).toMatchObject({
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
      expect(store.getRun("run-cancelled-receipt")).toMatchObject({
        state: "paused",
        terminalDetail: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      expect(store.listOperations("run-cancelled-receipt")[0]).toMatchObject({
        state: "blocked",
        attempt: 0,
        requestId: cancelledCapture.requestId,
        error: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      await Bun.sleep(25);
      expect(dispatches).toBe(2);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it.skip("recovers a pre-dispatch worktree and captures committed and untracked edits before cleanup", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "workflow-durable-worktree-"));
    const repo = join(root, "repo");
    const dataDir = join(root, "data");
    const dbPath = join(root, "workflow.sqlite");
    await Promise.all([fs.mkdir(repo), fs.mkdir(dataDir)]);
    await runGit(repo, ["init"]);
    await runGit(repo, ["config", "user.name", "Workflow Test"]);
    await runGit(repo, ["config", "user.email", "workflow@example.test"]);
    await fs.writeFile(join(repo, "tracked.txt"), "before\n");
    await runGit(repo, ["add", "tracked.txt"]);
    await runGit(repo, ["commit", "-m", "base"]);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
      repo,
    );
    const expectedOperationId = `wfop:${sha256("root:site-agent:0").slice(0, 40)}`;
    const preDispatchWorktree = join(
      dataDir,
      "workflow-worktrees",
      sha256("run-1").slice(0, 20),
      sha256(expectedOperationId).slice(0, 20),
    );
    await fs.mkdir(dirname(preDispatchWorktree), { recursive: true });
    const expectedBaseCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    await runGit(repo, ["worktree", "add", "--detach", preDispatchWorktree, expectedBaseCommit]);
    let cleanupAttempts = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "durable-worktree-success",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      removeWorktree: async (_revision, worktree) => {
        cleanupAttempts += 1;
        const operation = store.listOperations("run-1")[0];
        const output = operation ? store.getWorktreeOutput("run-1", operation.operationId) : null;
        if (!operation || !output) throw new Error("Missing captured worktree output");
        expect(operation?.state).toBe("succeeded");
        expect(output?.state).toBe("captured");
        expect(worktree).toBe(output.worktreePath);
        throw new Error("simulated cleanup interruption");
      },
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
          input: { prompt: "edit files", options: { profile: "general", isolation: "worktree" } },
        }),
      }),
      dispatchAgentRequest: async (request) => {
        await fs.writeFile(join(request.agentCwd, "tracked.txt"), "after\n");
        await fs.writeFile(join(request.agentCwd, "untracked.txt"), "new file\n");
        await runGit(request.agentCwd, ["add", "tracked.txt"]);
        await runGit(request.agentCwd, ["commit", "-m", "agent commit"]);
        return {
          state: "resolved",
          output: "editing complete",
          detail: null,
          usage: null,
        };
      },
    });
    let replacement: WorkflowEngine | null = null;
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");

      const operation = store.listOperations("run-1")[0];
      if (!operation) throw new Error("Missing successful editing operation");
      const capturedOutput = store.getWorktreeOutput("run-1", operation.operationId);
      expect(operation).toMatchObject({ state: "succeeded", output: "editing complete" });
      expect(capturedOutput).toMatchObject({
        state: "captured",
        baseCommit: expectedBaseCommit,
        cleanupError: "simulated cleanup interruption",
      });
      if (
        !capturedOutput ||
        typeof capturedOutput.artifactId !== "string" ||
        capturedOutput.bytes === null
      ) {
        throw new Error("Missing durable worktree patch metadata");
      }
      expect(capturedOutput.artifactId).toMatch(/^workflow-worktree-patch:/u);
      expect(store.getRun("run-1")?.terminalDetail).toContain(capturedOutput.artifactId);
      const patch = Buffer.from(
        await readWorkflowWorktreePatch({
          dataDir,
          artifactId: capturedOutput.artifactId,
          expectedBytes: capturedOutput.bytes,
        }),
      ).toString("utf8");
      expect(patch).toContain("+after");
      expect(patch).toContain("untracked.txt");
      expect(patch).toContain("+new file");
      expect((await fs.lstat(capturedOutput.worktreePath)).isDirectory()).toBe(true);
      expect(await fs.readFile(join(repo, "tracked.txt"), "utf8")).toBe("before\n");

      await engine.stop();
      replacement = new WorkflowEngine({
        bus,
        store,
        dataDir,
        subscriptionId: "durable-worktree-replacement",
        pollMs: 5,
        assertSandbox: async () => {},
        loadSnapshot: async () => "immutable",
        compileSource: (source) => source,
      });
      await replacement.start();
      await waitFor(
        () =>
          operation !== undefined &&
          store.getWorktreeOutput("run-1", operation.operationId)?.state === "cleaned",
      );
      expect(cleanupAttempts).toBe(1);
      expect(store.getWorktreeOutput("run-1", operation.operationId)).toMatchObject({
        state: "cleaned",
        cleanupError: null,
      });
      await expect(fs.lstat(capturedOutput.worktreePath)).rejects.toThrow();
    } finally {
      await replacement?.stop();
      await engine.stop();
      await bus.close();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skip("preserves an ordinary failed editing worktree as a fenced prepared output", async () => {
    const dbPath = join(tmpdir(), `workflow-failed-worktree-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new CapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
    );
    let removeCalls = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "failed-worktree-preservation",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      prepareWorktree: async () => ({
        path: "/preserved/failed-worktree",
        baseCommit: "a".repeat(40),
      }),
      removeWorktree: async () => {
        removeCalls += 1;
      },
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
          input: {
            prompt: "edit then fail",
            options: { profile: "general", isolation: "worktree" },
          },
        }),
      }),
      dispatchAgentRequest: async () => ({
        state: "failed",
        output: "",
        detail: "agent failed after editing",
        usage: null,
      }),
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "failed");
      const operation = store.listOperations("run-1")[0];
      expect(operation).toMatchObject({ state: "failed", error: "agent failed after editing" });
      expect(operation && store.getWorktreeOutput("run-1", operation.operationId)).toMatchObject({
        state: "prepared",
        worktreePath: "/preserved/failed-worktree",
        artifactId: null,
      });
      expect(removeCalls).toBe(0);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it.skip("fails and preserves a successful edit when ignored bytes are not patch-captured", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "workflow-ignored-worktree-"));
    const repo = join(root, "repo");
    const dataDir = join(root, "data");
    const dbPath = join(root, "workflow.sqlite");
    await Promise.all([fs.mkdir(repo), fs.mkdir(dataDir)]);
    await runGit(repo, ["init"]);
    await runGit(repo, ["config", "user.name", "Workflow Test"]);
    await runGit(repo, ["config", "user.email", "workflow@example.test"]);
    await fs.writeFile(join(repo, ".gitignore"), "*.cache\n");
    await fs.writeFile(join(repo, "tracked.txt"), "before\n");
    await runGit(repo, ["add", ".gitignore", "tracked.txt"]);
    await runGit(repo, ["commit", "-m", "base"]);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
      repo,
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "ignored-worktree-preservation",
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
          input: {
            prompt: "edit ignored output",
            options: { profile: "general", isolation: "worktree" },
          },
        }),
      }),
      dispatchAgentRequest: async (request) => {
        await fs.writeFile(join(request.agentCwd, "tracked.txt"), "after\n");
        await fs.writeFile(join(request.agentCwd, "only-copy.cache"), "uncaptured bytes\n");
        return { state: "resolved", output: "editing complete", detail: null, usage: null };
      },
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "failed");
      const operation = store.listOperations("run-1")[0];
      if (!operation) throw new Error("Missing ignored-file operation");
      const output = store.getWorktreeOutput("run-1", operation.operationId);
      expect(operation).toMatchObject({
        state: "failed",
        error: expect.stringContaining("Ignored worktree content"),
      });
      expect(output).toMatchObject({
        state: "prepared",
        artifactId: null,
        cleanupError: expect.stringContaining("worktree preserved for reconciliation"),
      });
      if (!output) throw new Error("Missing ignored-file reconciliation metadata");
      expect(await fs.readFile(join(output.worktreePath, "only-copy.cache"), "utf8")).toBe(
        "uncaptured bytes\n",
      );
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skip("quarantines a committed replay worktree when its pre-dispatch base was never persisted", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "workflow-legacy-worktree-"));
    const repo = join(root, "repo");
    const dataDir = join(root, "data");
    const dbPath = join(root, "workflow.sqlite");
    await Promise.all([fs.mkdir(repo), fs.mkdir(dataDir)]);
    await runGit(repo, ["init"]);
    await runGit(repo, ["config", "user.name", "Workflow Test"]);
    await runGit(repo, ["config", "user.email", "workflow@example.test"]);
    await fs.writeFile(join(repo, "tracked.txt"), "before\n");
    await runGit(repo, ["add", "tracked.txt"]);
    await runGit(repo, ["commit", "-m", "base"]);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
      repo,
    );
    expect(
      store.tryClaimTrustedRun({ runId: "run-1", claimerId: "legacy-engine", now: 10 }),
    ).not.toBeNull();
    const operationId = `wfop:${sha256("root:site-agent:0").slice(0, 40)}`;
    const requestId = workflowAgentRequestId("run-1", operationId, 0);
    expect(
      store.createOperation(
        {
          runId: "run-1",
          operationId,
          callSiteId: "site-agent",
          parentOperationId: null,
          phase: null,
          label: null,
          kind: "agent",
          input: persistedAgentInput("legacy edit", true, repo),
          inputSha256: canonicalJsonSha256(persistedAgentInput("legacy edit", true, repo)),
          state: "queued",
          attempt: 0,
          requestId: null,
          output: null,
          resultArtifactId: null,
          error: null,
          usage: null,
          claimedBy: null,
          claimedAt: null,
          createdAt: 10,
          startedAt: null,
          updatedAt: 10,
          terminalAt: null,
        },
        "legacy-engine",
      ),
    ).toBe(true);
    expect(
      store.transitionOperation({
        runId: "run-1",
        operationId,
        runOwnerId: "legacy-engine",
        from: "queued",
        to: "dispatched",
        requestId,
        now: 11,
      }),
    ).toBe(true);
    const worktree = join(
      dataDir,
      "workflow-worktrees",
      sha256("run-1").slice(0, 20),
      sha256(operationId).slice(0, 20),
    );
    await fs.mkdir(dirname(worktree), { recursive: true });
    await runGit(repo, ["worktree", "add", "--detach", worktree, "HEAD"]);
    await fs.writeFile(join(worktree, "tracked.txt"), "legacy committed edit\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "legacy agent edit"]);

    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "legacy-worktree-quarantine",
      pollMs: 5,
      now: () => 100_000,
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
          input: {
            prompt: "legacy edit",
            options: { profile: "general", isolation: "worktree" },
          },
        }),
      }),
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-1")?.state === "failed");
      expect(store.getWorktreeOutput("run-1", operationId)).toMatchObject({
        state: "quarantined",
        baseCommit: null,
        artifactId: null,
        cleanupError: expect.stringContaining("no durable pre-dispatch base"),
      });
      expect(await fs.readFile(join(worktree, "tracked.txt"), "utf8")).toBe(
        "legacy committed edit\n",
      );
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.skip("aborts a hung patch capture on cancellation and preserves reconciliation metadata", async () => {
    const dbPath = join(tmpdir(), `workflow-cancel-capture-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
    );
    let captureStarted = false;
    let removeCalls = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "cancel-hung-capture",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      prepareWorktree: async () => ({
        path: "/preserved/hung-capture",
        baseCommit: "a".repeat(40),
      }),
      captureWorktreePatch: async ({ signal }) => {
        captureStarted = true;
        return await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("capture aborted")), {
            once: true,
          });
        });
      },
      removeWorktree: async () => {
        removeCalls += 1;
      },
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
          input: {
            prompt: "edit then capture",
            options: { profile: "general", isolation: "worktree" },
          },
        }),
      }),
      dispatchAgentRequest: async () => ({
        state: "resolved",
        output: "editing complete",
        detail: null,
        usage: null,
      }),
    });
    try {
      await engine.start();
      await waitFor(() => captureStarted);
      expect(
        store.cancelRunAndChildren({ runId: "run-1", now: 20, detail: "cancel capture" })?.state,
      ).toBe("cancelled");
      await waitFor(() => {
        const operation = store.listOperations("run-1")[0];
        return Boolean(
          operation && store.getWorktreeOutput("run-1", operation.operationId)?.cleanupError,
        );
      });
      const operation = store.listOperations("run-1")[0];
      const output = operation ? store.getWorktreeOutput("run-1", operation.operationId) : null;
      expect(output).toMatchObject({
        state: "prepared",
        artifactId: null,
        cleanupError: expect.stringContaining("capture aborted"),
      });
      expect(removeCalls).toBe(0);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it.skip("blocks a cancelled receipt observed after live handoff and preserves its editing worktree", async () => {
    const dbPath = join(tmpdir(), `workflow-live-cancelled-handoff-${crypto.randomUUID()}.sqlite`);
    const store = new TerminalReceiptReadStore(dbPath);
    const raw = new LiveCapturingRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(
      store,
      "run-1",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      60_000,
      true,
    );
    let captured:
      | {
          requestId: string;
          runId: string;
          operationId: string;
          dispatchEpoch: string;
          resolvedModel: string;
        }
      | undefined;
    let sideEffects = 0;
    let prepareCalls = 0;
    let removeCalls = 0;
    let replacementModelResolutions = 0;
    let resolveLiveSelection: () => void = () => {};
    const liveSelection = new Promise<void>((resolve) => {
      resolveLiveSelection = resolve;
    });
    let resolveInitialReceiptMiss: () => void = () => {};
    const initialReceiptMiss = new Promise<void>((resolve) => {
      resolveInitialReceiptMiss = resolve;
    });
    const prepareWorktree = async () => {
      prepareCalls += 1;
      if (prepareCalls === 2) resolveLiveSelection();
      return { path: "/preserved/worktree", baseCommit: "a".repeat(40) };
    };
    const removeWorktree = async () => {
      removeCalls += 1;
    };
    const startSandbox = (
      input: Parameters<
        NonNullable<ConstructorParameters<typeof WorkflowEngine>[0]["startSandbox"]>
      >[0],
    ) => ({
      cancel: async () => {},
      result: input.onCall({
        type: "call" as const,
        id: 1,
        kind: "agent" as const,
        callSiteId: "site-agent",
        occurrence: 0,
        path: "root:site-agent:0",
        parentPath: null,
        phase: null,
        depth: 0,
        input: {
          prompt: "apply side effect",
          options: { profile: "general", isolation: "worktree" },
        },
      }),
    });
    const first = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "live-cancelled-first",
      pollMs: 5,
      now: () => 10,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      prepareWorktree,
      removeWorktree,
      startSandbox,
      validateAgentSelection: () => ({
        model: "provider/model-a",
        reasoning: "high",
        request: {
          spec: "provider/model-a",
          provider: "provider",
          modelId: "model-a",
          reasoning: "high",
          reasoningDisplay: "simple",
        },
      }),
      dispatchAgentRequest: async (request) => {
        sideEffects += 1;
        if (!request.controlToken) throw new Error("Missing live handoff control token");
        const runOwnerId = store.getRun(request.run.runId)?.claimedBy;
        if (!runOwnerId) throw new Error("Missing live handoff run owner");
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
            token: request.controlToken,
            dispatchEpoch: request.dispatchEpoch,
            ownerId: "live-runner",
            now: 10,
          }),
        ).toBe(true);
        captured = {
          requestId: request.requestId,
          runId: request.run.runId,
          operationId: request.operation.operationId,
          dispatchEpoch: request.dispatchEpoch,
          resolvedModel: request.policy.resolvedModel,
        };
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
      dataDir: dirname(dbPath),
      subscriptionId: "live-cancelled-replacement",
      pollMs: 5,
      receiptPollMs: 10_000,
      now: () => 12,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      prepareWorktree,
      removeWorktree,
      startSandbox,
      validateAgentSelection: () => {
        replacementModelResolutions += 1;
        return {
          model: "provider/model-b",
          reasoning: "low",
          request: {
            spec: "provider/model-b",
            provider: "provider",
            modelId: "model-b",
            reasoning: "low",
            reasoningDisplay: "simple",
          },
        };
      },
    });
    try {
      await first.start();
      await waitFor(() => captured !== undefined);
      expect(store.pauseRunAndChildren({ runId: "run-1", now: 11, detail: "pause" })?.state).toBe(
        "paused",
      );
      await first.stop();
      expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now: 12 })).toBe(
        true,
      );

      store.onMissingTerminalReceipt = resolveInitialReceiptMiss;
      await replacement.start();
      await liveSelection;
      await initialReceiptMiss;
      if (!captured) throw new Error("Missing selected live dispatch");
      expect(captured.resolvedModel).toBe("provider/model-a");
      expect(replacementModelResolutions).toBe(0);
      expect(
        store.recordWorkflowRequestTerminal({
          ...captured,
          ownerId: "live-runner",
          state: "cancelled",
          detail: "cancelled after side effect",
          now: 13,
        }),
      ).toBe(true);
      await bus.publish(
        lilacEventTypes.EvtRequestLifecycleChanged,
        { state: "cancelled", ts: 13, detail: "cancelled after side effect" },
        {
          headers: {
            request_id: captured.requestId,
            session_id: `workflow:${captured.runId}:${captured.operationId}`,
            request_client: "unknown",
            workflow_dispatch_epoch: captured.dispatchEpoch,
          },
        },
      );
      await waitFor(() => store.getRun("run-1")?.state === "paused");

      expect(sideEffects).toBe(1);
      expect(removeCalls).toBe(0);
      expect(store.getRun("run-1")?.terminalDetail).toBe(WORKFLOW_MANUAL_RECONCILIATION_DETAIL);
      expect(store.listOperations("run-1")[0]).toMatchObject({
        state: "blocked",
        attempt: 0,
        requestId: captured.requestId,
        error: WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
      });
      expect(
        raw.messages.filter(
          (message) =>
            message.type === lilacEventTypes.CmdRequestMessage &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "prompt",
        ),
      ).toHaveLength(0);
    } finally {
      await first.stop();
      await replacement.stop();
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
      dataDir: dirname(dbPath),
      subscriptionId: "lease-loss-local-only",
      pollMs: 5,
      now: () => now,
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
          input: { prompt: "inspect", options: { profile: "explore" } },
        }),
      }),
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
      await waitFor(() => store.listOperations("run-1", { state: "dispatched" }).length === 1);
      expect(
        store.tryClaimTrustedRun({
          runId: "run-1",
          claimerId: "successor",
          now: 100,
          staleAfterMs: 50,
        })?.claimedBy,
      ).toBe("successor");
      now = 101;
      await waitFor(() => store.getRun("run-1")?.claimedBy === "successor");
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

  it("tick attempts every sandbox and agent cancellation when earlier cancellations fail", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-tick-cancel-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new FailingInterruptRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(store);
    createApprovedRun(store, "run-2");
    const sandboxCancellations: number[] = [];
    let launches = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "tick-cancellation-fanout",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => {
        const launch = ++launches;
        return {
          cancel: async () => {
            sandboxCancellations.push(launch);
            if (launch === 1) throw new Error("injected sandbox cancellation failure");
          },
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
            input: { prompt: "inspect", options: { profile: "explore" } },
          }),
        };
      },
      dispatchAgentRequest: async ({ signal }) => {
        if (signal.aborted) {
          return { state: "cancelled", output: "", detail: "cancelled", usage: null };
        }
        return await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "cancelled", usage: null }),
            { once: true },
          );
        });
      },
    });
    try {
      await engine.start();
      await waitFor(
        () =>
          store.listOperations("run-1", { state: "dispatched" }).length === 1 &&
          store.listOperations("run-2", { state: "dispatched" }).length === 1,
      );
      store.cancelRunAndChildren({ runId: "run-1", now: 10, detail: "cancel one" });
      store.cancelRunAndChildren({ runId: "run-2", now: 10, detail: "cancel two" });
      await waitFor(() => sandboxCancellations.length === 2 && raw.interruptAttempts.length === 2);
      expect(sandboxCancellations.sort()).toEqual([1, 2]);
      expect(new Set(raw.interruptAttempts).size).toBe(2);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("stop aggregates failures after attempting every sandbox and agent cancellation", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-stop-cancel-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const raw = new FailingInterruptRawBus();
    const bus = createLilacBus(raw);
    createApprovedRun(store);
    createApprovedRun(store, "run-2");
    const sandboxCancellations: number[] = [];
    let launches = 0;
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "stop-cancellation-fanout",
      pollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => {
        const launch = ++launches;
        return {
          cancel: async () => {
            sandboxCancellations.push(launch);
            if (launch === 1) throw new Error("injected sandbox cancellation failure");
          },
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
            input: { prompt: "inspect", options: { profile: "explore" } },
          }),
        };
      },
      dispatchAgentRequest: async ({ signal }) => {
        if (signal.aborted) {
          return { state: "cancelled", output: "", detail: "stopped", usage: null };
        }
        return await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "stopped", usage: null }),
            { once: true },
          );
        });
      },
    });
    try {
      await engine.start();
      await waitFor(
        () =>
          store.listOperations("run-1", { state: "dispatched" }).length === 1 &&
          store.listOperations("run-2", { state: "dispatched" }).length === 1,
      );
      await expect(engine.stop()).rejects.toThrow(/stop failed while cancelling active work/u);
      expect(sandboxCancellations.sort()).toEqual([1, 2]);
      expect(raw.interruptAttempts).toHaveLength(2);
      expect(new Set(raw.interruptAttempts).size).toBe(2);
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });

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
      dataDir: dirname(dbPath),
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
            input: { prompt: "inspect", options: { profile: "explore", label: "Inspect" } },
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

  it("reclaims a crashed running run and replays completed operations without dispatch", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-restart-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(store);
    const claimed = store.tryClaimTrustedRun({ runId: "run-1", claimerId: "dead", now: 3 });
    expect(claimed?.state).toBe("running");
    store.createOperation(
      {
        runId: "run-1",
        operationId: `wfop:${sha256("root:site-agent:0").slice(0, 40)}`,
        callSiteId: "site-agent",
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
        resultArtifactId: null,
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
      dataDir: dirname(dbPath),
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
          input: { prompt: "inspect", options: { profile: "explore" } },
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
      dataDir: dirname(dbPath),
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
          input: { prompt: "inspect", options: { profile: "explore" } },
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
    await fs.mkdir(root);
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
          input: { prompt: "large", options: { profile: "explore" } },
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
      dataDir: dirname(dbPath),
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
            input: { prompt: "inspect", options: { profile: "explore" } },
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
      expect(
        store.pauseRunAndChildren({ runId: "run-1", now: 10, detail: "test pause" })?.state,
      ).toBe("paused");
      await waitFor(() => store.listOperations("run-1", { state: "dispatched" }).length === 1);
      expect(store.listOperations("run-1")[0]?.attempt).toBe(0);
      expect(store.transitionRun({ runId: "run-1", from: "paused", to: "queued", now: 11 })).toBe(
        true,
      );
      await waitFor(() => store.getRun("run-1")?.state === "succeeded");
      expect(store.getRun("run-1")?.result).toBe("resumed");
      expect(launches).toBe(2);

      createApprovedRun(store, "run-cancel");
      await waitFor(() => store.listOperations("run-cancel", { state: "dispatched" }).length === 1);
      expect(
        store.cancelRunAndChildren({
          runId: "run-cancel",
          now: 12,
          detail: "test cancellation",
        })?.state,
      ).toBe("cancelled");
      await waitFor(() => store.listOperations("run-cancel", { state: "cancelled" }).length === 1);
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

  it("cancels the exact idle request and waits for its fenced terminal receipt", async () => {
    const dbPath = join(tmpdir(), `workflow-engine-idle-receipt-${crypto.randomUUID()}.sqlite`);
    const store = new DurableWorkflowStore(dbPath);
    class IdleReceiptBus extends LiveCapturingRawBus {
      cancelledRequestId: string | null = null;
      stateBeforeReceipt: string | null = null;
      interruptAttempts = 0;

      override async publish<TData>(
        message: Omit<Message<TData>, "id" | "ts">,
        options: PublishOptions,
      ) {
        if (message.type === lilacEventTypes.CmdRequestMessage) {
          const data = message.data as {
            queue?: string;
            raw?: {
              cancel?: boolean;
              workflow?: { controlToken?: string; dispatchEpoch?: string };
            };
          };
          const requestId = message.headers?.request_id;
          if (data.queue === "prompt" && requestId && data.raw?.workflow?.controlToken) {
            store.claimWorkflowRequest({
              requestId,
              token: data.raw.workflow.controlToken,
              dispatchEpoch: data.raw.workflow.dispatchEpoch ?? "",
              ownerId: "idle-test-runner",
              now: Date.now(),
            });
            await super.publish(
              {
                topic: "evt.request",
                type: lilacEventTypes.EvtRequestLifecycleChanged,
                data: { state: "running" },
                headers: {
                  request_id: requestId,
                  session_id: message.headers?.session_id ?? "",
                  request_client: "unknown",
                  workflow_dispatch_epoch: data.raw.workflow.dispatchEpoch ?? "",
                },
              },
              { topic: "evt.request", type: lilacEventTypes.EvtRequestLifecycleChanged },
            );
          }
          if (data.queue === "interrupt" && data.raw?.cancel === true && requestId) {
            this.interruptAttempts += 1;
            if (this.interruptAttempts === 1) throw new Error("transient cancel publish failure");
            this.cancelledRequestId = requestId;
            this.stateBeforeReceipt = store.getOperationByRequestId(requestId)?.state ?? null;
            await Bun.sleep(50);
            const operation = store.getOperationByRequestId(requestId);
            if (!operation) throw new Error("Missing idle operation");
            const dispatch = store.getWorkflowRequestDispatchHandoff({
              requestId,
              now: Date.now(),
              staleAfterMs: 60_000,
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
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      10_000,
      false,
      process.cwd(),
      false,
      1_000,
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "idle-receipt",
      pollMs: 5,
      receiptPollMs: 5,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (source) => source,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call",
          id: 1,
          kind: "agent",
          callSiteId: "idle-agent",
          occurrence: 0,
          path: "root:idle-agent:0",
          parentPath: null,
          phase: null,
          depth: 0,
          input: { prompt: "wait forever", options: { profile: "explore" } },
        }),
      }),
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-idle-receipt")?.state === "failed");
      const operation = store.listOperations("run-idle-receipt")[0];
      expect(raw.cancelledRequestId).toBe(operation?.requestId ?? null);
      expect(raw.interruptAttempts).toBe(2);
      expect(raw.stateBeforeReceipt).toBe("running");
      expect(operation).toMatchObject({
        state: "timed_out",
        error: "Agent operation idle timeout",
      });
      expect(store.getWorkflowRequestTerminalReceipt(raw.cancelledRequestId!)).toMatchObject({
        state: "cancelled",
        detail: "idle process tree quiesced",
      });
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
      dataDir: dirname(dbPath),
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
      await waitFor(() => store.listOperations("run-sleep")[0]?.state === "blocked");
      await waitFor(() => store.listOperations("run-timeout")[0]?.state === "blocked");
      now = 110;
      await resolver.reconcileTimers();
      const timeoutOperation = store.listOperations("run-timeout")[0];
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
    let now = 10;
    const makeEngine = () =>
      new WorkflowEngine({
        bus,
        store,
        dataDir: dirname(dbPath),
        subscriptionId: `test-reply-restart-${crypto.randomUUID()}`,
        pollMs: 5,
        now: () => now,
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
      await waitFor(() => store.listOperations("run-reply")[0]?.state === "blocked");
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
      now = 60_011;
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
