import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
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
import type { WorkflowRequestPolicy } from "../../src/workflow/workflow-request-authority";
import { canonicalJsonSha256, sha256 } from "../../src/workflow/workflow-definition";
import {
  normalizeWorkflowResourcePolicy,
  WORKFLOW_MANUAL_RECONCILIATION_DETAIL,
  type WorkflowCompletionTarget,
} from "../../src/workflow/workflow-domain";
import { WorkflowWaitResolver } from "../../src/workflow/workflow-wait-resolver";
import { readWorkflowValueArtifact } from "../../src/workflow/workflow-artifact-store";
import {
  compileWorkflowSource,
  parseWorkflowCallSiteManifest,
} from "../../src/workflow/workflow-source-compiler";

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
  editing = false,
  canonicalWorkspaceRoot = process.cwd(),
  mixedEditing = false,
  operationIdleTimeoutMs = 2_000,
  originUserId: string | null = "user-1",
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
    operationIdleTimeoutMs,
    waits: ["reply", "sleep"],
  });
  const limits = {
    maxSourceBytes: 100_000,
    maxInputBytes: 10_000,
    maxOperationOutputBytes: outputLimits.operation,
    maxResultBytes: outputLimits.result,
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
    runtimeVersion: "lilac-workflow-js-v4",
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
        userId: originUserId,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for workflow state");
    await Bun.sleep(10);
  }
}

function persistedAgentInput(prompt: string, editing = false, cwd = process.cwd()) {
  return {
    prompt,
    options: {
      profile: editing ? "general" : "explore",
      cwd,
    },
  };
}

function workflowSource(bindings: string, body: string): string {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  async run({ ${bindings} }) {
    ${body}
  },
});
`;
}

function compileTestWorkflow(source: string): string {
  return compileWorkflowSource(source, sha256(source));
}

function agentWorkflowSource(prompt = "inspect", options = '{ profile: "explore" }'): string {
  return workflowSource("agent", `return await agent(${JSON.stringify(prompt)}, ${options});`);
}

function firstOperationId(source: string): string {
  const callSite = parseWorkflowCallSiteManifest(compileTestWorkflow(source))[0];
  if (!callSite) throw new Error("Test workflow has no host call");
  return `wfop:${sha256(`root:${callSite.callSiteId}:0`).slice(0, 40)}`;
}

describe("WorkflowEngine", () => {
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
      loadSnapshot: async () =>
        workflowSource(
          "agent",
          `return await Promise.all([
            agent("edit-a", { profile: "general" }),
            agent("edit-b", { profile: "general" }),
            agent("read-a", { profile: "explore" }),
            agent("read-b", { profile: "explore" }),
          ]);`,
        ),
      compileSource: compileTestWorkflow,
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
      loadSnapshot: async () =>
        workflowSource(
          "agent",
          `return await agent("work in nested cwd", { profile: "general", cwd: ${JSON.stringify(requestedCwd)} });`,
        ),
      compileSource: compileTestWorkflow,
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
      true,
    );
    let now = 10;
    let firstDispatched = false;
    let replacementResolutions = 0;
    const recoveredPolicies: WorkflowRequestPolicy[] = [];
    const source = workflowSource(
      "agent",
      'return await agent("durable request", { profile: "general" });',
    );
    const first = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "stale-policy-first",
      pollMs: 5,
      now: () => now,
      loadSnapshot: async () => source,
      compileSource: compileTestWorkflow,
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
      loadSnapshot: async () => source,
      compileSource: compileTestWorkflow,
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
      const source = agentWorkflowSource();
      const operationId = firstOperationId(source);
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
        loadSnapshot: async () => source,
        compileSource: compileTestWorkflow,
        createDispatchEpoch: () => dispatchEpoch,
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
            const sessionId = message.headers?.session_id;
            if (!requestId || !sessionId) throw new Error("Missing workflow request identity");
            const workflow = z
              .object({
                workflow: z.strictObject({
                  runId: z.string(),
                  operationId: z.string(),
                  dispatchEpoch: z.string(),
                }),
              })
              .parse(message.data.raw).workflow;
            expect(
              store.authorizeWorkflowRequest({
                requestId,
                sessionId,
                platform: "unknown",
              })?.policy,
            ).toMatchObject(workflow);
            expect(
              store.claimWorkflowRequest({
                requestId,
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
        loadSnapshot: async () => agentWorkflowSource(),
        compileSource: compileTestWorkflow,
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      beforePromptPublication: async ({
        requestId,
        runId,
        operationId,
        dispatchEpoch,
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
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
            workflow: z.strictObject({
              runId: z.string(),
              operationId: z.string(),
              dispatchEpoch: z.string(),
            }),
          }),
        })
        .parse(command.data);
      const requestId = command.headers["request_id"];
      const sessionId = command.headers["session_id"];
      if (!requestId || !sessionId) throw new Error("Missing workflow command identity");
      const authorized = store.authorizeWorkflowRequest({
        requestId,
        sessionId,
        platform: "unknown",
      });
      if (!authorized) throw new Error("Workflow command was not authorized");
      expect(
        store.claimWorkflowRequest({
          requestId,
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async (request) => {
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
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
        loadSnapshot: async () => agentWorkflowSource(),
        compileSource: compileTestWorkflow,
        dispatchAgentRequest: async (request) => {
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
        loadSnapshot: async () => agentWorkflowSource(),
        compileSource: compileTestWorkflow,
        createDispatchEpoch:
          raceWindow === "authorization"
            ? () => {
                commitReceipt();
                return "replacement-dispatch-epoch";
              }
            : undefined,
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async (request) => {
        dispatches += 1;
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
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
        store.tryClaimRun({
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

  it("journals deterministic operations and captures usage and output", async () => {
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
      loadSnapshot: async () =>
        workflowSource(
          "phase, agent",
          `return await phase("audit", async () => {
            const first = await agent("inspect", { profile: "explore", label: "Inspect" });
            return { first, cached: first };
          });`,
        ),
      compileSource: compileTestWorkflow,
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
    const source = agentWorkflowSource();
    const claimed = store.tryClaimRun({ runId: "run-1", claimerId: "dead", now: 3 });
    expect(claimed?.state).toBe("running");
    store.createOperation(
      {
        runId: "run-1",
        operationId: firstOperationId(source),
        callSiteId: parseWorkflowCallSiteManifest(compileTestWorkflow(source))[0]!.callSiteId,
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
      loadSnapshot: async () => source,
      compileSource: compileTestWorkflow,
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

  it("fails operations that exceed configured output limits", async () => {
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
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
      loadSnapshot: async () => agentWorkflowSource("large"),
      compileSource: compileTestWorkflow,
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
      loadSnapshot: async () => agentWorkflowSource(),
      compileSource: compileTestWorkflow,
      dispatchAgentRequest: async ({ run, signal }) => {
        launches += 1;
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
          const data = z
            .object({
              queue: z.string().optional(),
              raw: z
                .object({
                  cancel: z.boolean().optional(),
                  workflow: z
                    .strictObject({
                      runId: z.string(),
                      operationId: z.string(),
                      dispatchEpoch: z.string(),
                    })
                    .optional(),
                })
                .optional(),
            })
            .parse(message.data);
          const requestId = message.headers?.request_id;
          const sessionId = message.headers?.session_id;
          if (data.queue === "prompt" && requestId && sessionId && data.raw?.workflow) {
            const authorized = store.authorizeWorkflowRequest({
              requestId,
              sessionId,
              platform: "unknown",
            });
            if (!authorized) throw new Error("Idle workflow request was not authorized");
            const claimed = store.claimWorkflowRequest({
              requestId,
              dispatchEpoch: data.raw.workflow.dispatchEpoch,
              ownerId: "idle-test-runner",
              now: Date.now(),
            });
            if (!claimed) throw new Error("Idle workflow request was not claimed");
            await super.publish(
              {
                topic: "evt.request",
                type: lilacEventTypes.EvtRequestLifecycleChanged,
                data: { state: "running" },
                headers: {
                  request_id: requestId,
                  session_id: sessionId,
                  request_client: "unknown",
                  workflow_dispatch_epoch: data.raw.workflow.dispatchEpoch,
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
      loadSnapshot: async () => agentWorkflowSource("wait forever"),
      compileSource: compileTestWorkflow,
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
      loadSnapshot: async () =>
        workflowSource(
          "args, waitForReply, sleep",
          `if (args.timeout === true) return await waitForReply({ timeoutMs: 10 });
          return await sleep(10);`,
        ),
      compileSource: compileTestWorkflow,
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
        loadSnapshot: async () =>
          workflowSource(
            "waitForReply",
            'return await waitForReply({ messageId: "anchor-1", timeoutMs: 1000 });',
          ),
        compileSource: compileTestWorkflow,
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

  it("rejects reply waits without an authenticated Discord origin user", async () => {
    const dbPath = join(
      tmpdir(),
      `workflow-engine-unauthenticated-reply-${crypto.randomUUID()}.sqlite`,
    );
    const store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new CapturingRawBus());
    createApprovedRun(
      store,
      "run-unauthenticated-reply",
      {},
      { operation: 10_000, result: 10_000 },
      { kind: "detached" },
      false,
      process.cwd(),
      false,
      2_000,
      null,
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir: dirname(dbPath),
      subscriptionId: "test-unauthenticated-reply",
      pollMs: 5,
      loadSnapshot: async () =>
        workflowSource("waitForReply", "return await waitForReply({ timeoutMs: 1000 });"),
      compileSource: compileTestWorkflow,
    });
    try {
      await engine.start();
      await waitFor(() => store.getRun("run-unauthenticated-reply")?.state === "failed");
      expect(store.getRun("run-unauthenticated-reply")?.terminalDetail).toContain(
        "authenticated originating Discord session and user",
      );
    } finally {
      await engine.stop();
      await bus.close();
      store.close();
      rmSync(dbPath, { force: true });
    }
  });
});
