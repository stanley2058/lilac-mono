import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  createLilacBus,
  lilacEventTypes,
  outReqTopic,
  type HandleContext,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

import type { TrustedSubagentDelegationRegistration } from "../../src/tools/subagent";
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
import { WorkflowLiveParentBridge } from "../../src/workflow/workflow-live-parent-bridge";
import { WorkflowProgressProjector } from "../../src/workflow/workflow-progress-projector";
import { WorkflowSubagentDispatcher } from "../../src/workflow/workflow-subagent-dispatcher";
import { WorkflowEngine } from "../../src/workflow/workflow-engine";
import { createToolResultArtifactStore } from "../../src/artifacts/tool-result-artifact-store";

const roots: string[] = [];
const AUTHENTICATED_PARENT = { platform: "discord", userId: "user-1" } as const;

function createInMemoryRawBus(control?: {
  failProgressRequested?: boolean;
  progressRequestedFailures?: number;
}): RawBus & { activeSubscriptions(): number } {
  const topics = new Map<string, Array<Message<unknown>>>();
  const subscriptions = new Set<{
    topic: string;
    handler: (message: Message<unknown>, context: HandleContext) => Promise<void>;
  }>();
  return {
    publish: async <TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) => {
      if (
        control?.failProgressRequested &&
        options.type === lilacEventTypes.EvtWorkflowProgressRequested
      ) {
        control.progressRequestedFailures = (control.progressRequestedFailures ?? 0) + 1;
        throw new Error("simulated progress publication failure");
      }
      const id = crypto.randomUUID();
      const stored: Message<unknown> = {
        topic: options.topic,
        id,
        type: options.type,
        ts: Date.now(),
        key: options.key,
        headers: options.headers,
        data: message.data,
      };
      const existing = topics.get(options.topic) ?? [];
      existing.push(stored);
      topics.set(options.topic, existing);
      for (const subscription of subscriptions) {
        if (subscription.topic === options.topic) {
          await subscription.handler(stored, { cursor: id, commit: async () => {} });
        }
      }
      return { id, cursor: id };
    },
    subscribe: async <TData>(
      topic: string,
      _options: SubscriptionOptions,
      handler: (message: Message<TData>, context: HandleContext) => Promise<void>,
    ) => {
      const entry = {
        topic,
        handler: (message: Message<unknown>, context: HandleContext) =>
          handler(message as Message<TData>, context),
      };
      subscriptions.add(entry);
      return {
        stop: async () => {
          subscriptions.delete(entry);
        },
      };
    },
    fetch: async <TData>(topic: string) => ({
      messages: (topics.get(topic) ?? []).map((message) => ({
        msg: message as Message<TData>,
        cursor: message.id,
      })),
      next: topics.get(topic)?.at(-1)?.id,
    }),
    watermark: async (topic: string) => topics.get(topic)?.at(-1)?.id ?? null,
    activeSubscriptions: () => subscriptions.size,
    close: async () => {},
  };
}

class FallbackTrackingWorkflowStore extends DurableWorkflowStore {
  private nullTargetProjectionResolve: (() => void) | null = null;

  waitForNullTargetProjection(): Promise<void> {
    return new Promise((resolve) => {
      this.nullTargetProjectionResolve = resolve;
    });
  }

  override getRun(runId: string) {
    const run = super.getRun(runId);
    if (run?.progressTarget === null && this.nullTargetProjectionResolve) {
      const resolve = this.nullTargetProjectionResolve;
      this.nullTargetProjectionResolve = null;
      // The no-target path has no awaits; the timer runs after its projection promise settles.
      setTimeout(resolve, 0);
    }
    return run;
  }
}

class FallbackCardAdapter implements SurfaceAdapter {
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;

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
    this.sends += 1;
    const ref = {
      platform: "discord" as const,
      channelId: session.channelId,
      messageId: `fallback-card-${this.sends}`,
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
    return this.messages.get(ref.messageId) ?? null;
  }
  async listMsg(_session: SessionRef, _opts?: LimitOpts) {
    return [...this.messages.values()];
  }
  async editMsg(ref: MsgRef, content: ContentOpts) {
    const current = this.messages.get(ref.messageId);
    if (!current) throw new Error("fallback card is missing");
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

afterEach(async () => {
  await Promise.all(roots.splice(0, roots.length).map((root) => rm(root, { recursive: true })));
});

async function setup(maxActiveRuns?: number) {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-subagent-workflow-"));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  const projectRoot = path.join(root, "project");
  const dataDir = path.join(root, "data");
  const dbPath = path.join(root, "workflow.db");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  const store = new FallbackTrackingWorkflowStore(dbPath);
  const dispatcher = await WorkflowSubagentDispatcher.create({
    store,
    dataDir,
    pollMs: 1,
    getMaxActiveRuns: maxActiveRuns === undefined ? undefined : () => maxActiveRuns,
  });
  return { root, workspaceRoot, projectRoot, dataDir, dbPath, store, dispatcher };
}

function registration(
  projectRoot: string,
  parentRequestId = "parent:1",
): TrustedSubagentDelegationRegistration {
  return {
    mode: "deferred",
    profile: "explore",
    sessionName: "audit",
    task: "Audit the authentication flow",
    idleTimeoutMs: 2_000,
    depth: 1,
    parentRequestId,
    parentSessionId: "channel:1",
    parentRequestClient: "discord",
    parentToolCallId: "tool:delegate",
    childRequestId: "sub:child:1",
    childSessionId: "sub:channel:1:named:audit",
    parentHeaders: {
      request_id: parentRequestId,
      session_id: "channel:1",
      request_client: "discord",
    },
    childHeaders: {
      request_id: "sub:child:1",
      session_id: "sub:channel:1:named:audit",
      request_client: "unknown",
      parent_request_id: parentRequestId,
      parent_tool_call_id: "tool:delegate",
      subagent_profile: "explore",
      subagent_depth: "1",
    },
    initialMessages: [{ role: "user", content: "Audit the authentication flow" }],
    projectRoot,
    fallbackSurface: {
      ...AUTHENTICATED_PARENT,
      sessionId: "channel:1",
    },
  };
}

async function createRun(parentRequestId = "parent:1") {
  const setupResult = await setup();
  const handle = await setupResult.dispatcher.delegate(
    registration(setupResult.projectRoot, parentRequestId),
  );
  const run = setupResult.store.getRun(handle.runId);
  if (!run) throw new Error("generated subagent run not found");
  return { ...setupResult, handle, run };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for workflow state");
    await Bun.sleep(5);
  }
}

describe("workflow subagent convergence", () => {
  it("rejects delegation at global capacity without creating partial durable state", async () => {
    const { projectRoot, store, dispatcher } = await setup(1);
    const first = await dispatcher.delegate(registration(projectRoot, "parent:first"));

    await expect(dispatcher.delegate(registration(projectRoot, "parent:rejected"))).rejects.toThrow(
      "global workflow capacity is full (1/1 active runs)",
    );
    expect(store.listRuns().map((item) => item.runId)).toEqual([first.runId]);
    expect(store.listActiveLiveParentRuns("parent:rejected")).toEqual([]);
    expect(store.listRevisions()).toHaveLength(1);
    store.close();
  });

  it("creates an immutable run under the project root when the tool workspace differs", async () => {
    const { workspaceRoot, projectRoot, store, handle, run } = await createRun();
    const revision = store.getRevision(run.revisionId);

    expect(run.state).toBe("queued");
    expect(run.origin).toMatchObject({ client: "discord", userId: "user-1" });
    expect(run.completionTarget).toMatchObject({
      kind: "live_parent",
      parentRequestId: "parent:1",
      parentToolCallId: "tool:delegate",
      childSessionId: "sub:channel:1:named:audit",
      profile: "explore",
      sessionName: "audit",
    });
    expect(revision?.name).toBe("subagent-delegate");
    expect(revision?.canonicalWorkspaceRoot).toBe(projectRoot);
    expect(revision?.canonicalWorkspaceRoot).not.toBe(workspaceRoot);
    expect(revision?.resources.agents).toMatchObject({
      maxConcurrent: 1,
      maxTotal: 1,
    });
    expect(store.listActiveLiveParentRuns("parent:1").map((item) => item.runId)).toEqual([
      handle.runId,
    ]);
    expect(store.getLiveParentDeliverySnapshot("parent:1")).toEqual({
      pendingCompletionCount: 0,
      outstandingRunCount: 1,
    });
    store.close();
  });

  it("persists completion materialization failures across store restarts", async () => {
    const { store, dbPath, run } = await createRun("parent:materialization-retry");
    expect(
      store.recordLiveParentCompletionMaterializationFailure({
        runId: run.runId,
        error: "temporary read failure",
        now: 20,
      }),
    ).toBe(1);
    store.close();

    const reopened = new DurableWorkflowStore(dbPath);
    expect(
      reopened.recordLiveParentCompletionMaterializationFailure({
        runId: run.runId,
        error: "temporary read failure",
        now: 21,
      }),
    ).toBe(2);
    expect(reopened.clearLiveParentCompletionMaterializationFailure(run.runId, 22)).toBe(true);
    expect(
      reopened.recordLiveParentCompletionMaterializationFailure({
        runId: run.runId,
        error: "temporary read failure",
        now: 23,
      }),
    ).toBe(1);
    reopened.close();
  });

  it("creates and caches generated definitions independently for multiple project roots", async () => {
    const { root, projectRoot, store, dispatcher } = await setup();
    const otherProjectRoot = path.join(root, "unrelated-project");
    await mkdir(otherProjectRoot);

    const direct = await dispatcher.delegate(registration(projectRoot, "parent:direct-root"));
    const nested = await dispatcher.delegate(registration(otherProjectRoot, "parent:nested-root"));
    const directRun = store.getRun(direct.runId);
    const nestedRun = store.getRun(nested.runId);
    const directRevision = directRun ? store.getRevision(directRun.revisionId) : null;
    const nestedRevision = nestedRun ? store.getRevision(nestedRun.revisionId) : null;

    expect(directRevision?.canonicalWorkspaceRoot).toBe(projectRoot);
    expect(nestedRevision?.canonicalWorkspaceRoot).toBe(otherProjectRoot);
    expect(nestedRevision?.canonicalProjectId).not.toBe(directRevision?.canonicalProjectId);
    store.close();
  });

  it("targets the authoritative Discord surface for nested delegation fallback", async () => {
    const { projectRoot, store, dispatcher } = await setup();
    const syntheticParentSessionId = "sub:channel:1:named:outer";
    const nested = registration(projectRoot, "wfr:nested-parent");
    const handle = await dispatcher.delegate({
      ...nested,
      parentSessionId: syntheticParentSessionId,
      parentRequestClient: "unknown",
      parentHeaders: {
        ...nested.parentHeaders,
        session_id: syntheticParentSessionId,
        request_client: "unknown",
      },
    });
    const run = store.getRun(handle.runId);

    expect(run?.origin).toMatchObject({
      sessionId: "channel:1",
      client: "discord",
      userId: "user-1",
    });
    expect(run?.completionTarget).toMatchObject({
      kind: "live_parent",
      parentSessionId: syntheticParentSessionId,
      fallbackProgressTarget: {
        platform: "discord",
        channelId: "channel:1",
        replyToMessageId: null,
      },
    });
    expect(run?.completionTarget).not.toMatchObject({
      fallbackProgressTarget: { channelId: syntheticParentSessionId },
    });
    store.close();
  });

  it("preserves a self profile in the generated workflow", async () => {
    const { dataDir, projectRoot, store, dispatcher } = await setup();
    const handle = await dispatcher.delegate({
      ...registration(projectRoot),
      profile: "self",
      childHeaders: {
        ...registration(projectRoot).childHeaders,
        subagent_profile: "self",
      },
    });
    const run = store.getRun(handle.runId);
    const revision = run ? store.getRevision(run.revisionId) : null;
    expect(run?.completionTarget).toMatchObject({ kind: "live_parent", profile: "self" });
    expect(revision?.resources.agents).toMatchObject({
      maxConcurrent: 1,
    });
    if (!revision) throw new Error("generated self revision missing");
    const generated = await readFile(
      path.join(dataDir, "workflow-snapshots", `${revision.sourceSha256}.js`),
      "utf8",
    );
    expect(generated).toContain('profile: { type: "string", const: "self" }');
    expect(generated).not.toContain("delegation:");
    store.close();
  });

  it("transfers child tool-result wrappers before parent delivery", async () => {
    const setupResult = await setup();
    const artifacts = createToolResultArtifactStore(path.join(setupResult.dataDir, "tool-results"));
    await artifacts.init();
    const dispatcher = await WorkflowSubagentDispatcher.create({
      store: setupResult.store,
      dataDir: setupResult.dataDir,
      toolResultArtifacts: artifacts,
      pollMs: 1,
    });
    const child = registration(setupResult.projectRoot);
    const artifact = await artifacts.create({
      sessionId: child.childSessionId,
      requestId: child.childRequestId,
      toolCallId: "child-tool-call",
      toolName: "grep",
      content: "complete child tool output",
      ttlMs: 60_000,
      maxBytesPerSession: 1_000_000,
    });
    const handle = await dispatcher.delegate(child);
    const run = setupResult.store.getRun(handle.runId);
    if (!run) throw new Error("generated run missing");
    expect(
      setupResult.store.transitionRun({
        runId: run.runId,
        from: "queued",
        to: "running",
        now: 20,
      }),
    ).toBe(true);
    const wrapper = `head\n\n[tool result truncated: 10 characters omitted]\nComplete output: ${artifact.uri}\nUse read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse the returned nextStart unchanged while more content remains.\n\ntail`;
    expect(
      setupResult.store.transitionRun({
        runId: run.runId,
        from: "running",
        to: "succeeded",
        now: 21,
        result: wrapper,
      }),
    ).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({
      status: "resolved",
      finalText: "complete child tool output",
    });
    setupResult.store.close();
  });

  it("uses the same durable terminal run without deferred delivery for synchronous completion", async () => {
    const setupResult = await setup();
    const handle = await setupResult.dispatcher.delegate({
      ...registration(setupResult.projectRoot),
      mode: "sync",
    });
    const run = setupResult.store.getRun(handle.runId);
    if (!run) throw new Error("generated subagent run not found");
    const { store } = setupResult;
    expect(store.listActiveLiveParentRuns("parent:1").map((item) => item.runId)).toEqual([
      handle.runId,
    ]);
    expect(store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 })).toBe(
      true,
    );
    expect(
      store.transitionRun({
        runId: run.runId,
        from: "running",
        to: "succeeded",
        now: 20,
        result: "audit complete",
      }),
    ).toBe(true);

    await expect(handle.completion).resolves.toEqual({
      status: "resolved",
      finalText: "audit complete",
    });
    expect(store.listPendingLiveParentCompletions("parent:1", 100, true)).toEqual([]);
    store.close();
  });

  it("aggregates distinct child tools without letting non-tool activity erase the tree", async () => {
    const { store } = await createRun("parent:tool-tree");
    const bus = createLilacBus(createInMemoryRawBus());
    const updates: Array<{ toolCallId: string; display: string }> = [];
    await bus.subscribeTopic(
      outReqTopic("parent:tool-tree"),
      { mode: "tail", offset: { type: "begin" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
          updates.push({ toolCallId: message.data.toolCallId, display: message.data.display });
        }
        await context.commit();
      },
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-tool-tree",
    });
    await bridge.start();
    let parentActivity = 0;
    const parent = bridge.registerParent({
      parentRequestId: "parent:tool-tree",
      onActivity: () => {
        parentActivity += 1;
      },
    });
    await parent.ready;

    const childHeaders = {
      request_id: "sub:child:1",
      session_id: "sub:channel:1:named:audit",
      request_client: "unknown" as const,
    };
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:grep", status: "start", display: "[grep] auth" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:read", status: "start", display: "[read] config" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:grep", status: "end", display: "[grep] auth", ok: true },
      { headers: childHeaders },
    );

    const expectedTree = [
      "subagent (explore; 1/2 done)",
      "|- > [read] config",
      "`- + [grep] delayed",
    ].join("\n");
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:grep", status: "update", display: "[grep] delayed" },
      { headers: childHeaders },
    );
    expect(updates.at(-1)).toEqual({ toolCallId: "tool:delegate", display: expectedTree });
    const updateCount = updates.length;
    const activityBefore = parentActivity;

    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaText,
      { delta: "checking middleware" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputDeltaReasoning,
      { delta: "thinking" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputActivity,
      { source: "model" },
      { headers: childHeaders },
    );

    expect(parentActivity).toBe(activityBefore + 3);
    expect(updates).toHaveLength(updateCount);
    expect(updates.at(-1)?.display).toBe(expectedTree);

    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("reconciles pending terminal child output when the parent registers", async () => {
    const { store, run } = await createRun("parent:terminal-tree");
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "done",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const childHeaders = {
      request_id: "sub:child:1",
      session_id: "sub:channel:1:named:audit",
      request_client: "unknown" as const,
    };
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      { toolCallId: "child:trailing", status: "start", display: "[read] trailing output" },
      { headers: childHeaders },
    );
    await bus.publish(
      lilacEventTypes.EvtAgentOutputToolCall,
      {
        toolCallId: "child:trailing",
        status: "end",
        display: "[read] trailing output",
        ok: true,
      },
      { headers: childHeaders },
    );

    const updates: Array<{ toolCallId: string; display: string }> = [];
    await bus.subscribeTopic(
      outReqTopic("parent:terminal-tree"),
      { mode: "tail", offset: { type: "begin" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
          updates.push({ toolCallId: message.data.toolCallId, display: message.data.display });
        }
        await context.commit();
      },
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-terminal-tree",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:terminal-tree" });
    await parent.ready;

    expect(updates).toEqual([
      {
        toolCallId: "tool:delegate",
        display: "subagent (explore; 1/1 done)\n`- + [read] trailing output",
      },
    ]);

    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("dispatches the generated agent operation through the workflow engine", async () => {
    const { store, handle, run, dataDir } = await createRun();
    const bus = createLilacBus(createInMemoryRawBus());
    let childSessionId: string | undefined;
    let childRequestId: string | undefined;
    let hasWorkflowIdentity = false;
    const progress: string[] = [];
    await bus.subscribeTopic(
      outReqTopic("parent:1"),
      { mode: "tail", offset: { type: "begin" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtAgentOutputToolCall) {
          progress.push(message.data.display);
        }
        await context.commit();
      },
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "generated-subagent-parent-bridge",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await parent.ready;
    await bus.subscribeTopic(
      "cmd.request",
      { mode: "fanout", subscriptionId: "generated-agent", offset: { type: "now" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.CmdRequestMessage && message.data.queue === "prompt") {
          childSessionId = message.headers?.session_id;
          childRequestId = message.headers?.request_id;
          const workflow = z
            .object({
              workflow: z.strictObject({
                runId: z.string(),
                operationId: z.string(),
                dispatchEpoch: z.string(),
              }),
            })
            .parse(message.data.raw).workflow;
          hasWorkflowIdentity = true;
          if (!childRequestId || !childSessionId) {
            throw new Error("generated workflow request authority is incomplete");
          }
          const authorized = store.authorizeWorkflowRequest({
            requestId: childRequestId,
            sessionId: childSessionId,
            platform: "unknown",
            now: Date.now(),
          });
          if (!authorized) throw new Error("generated workflow request was not authorized");
          expect(authorized.policy).toMatchObject({
            profile: "explore",
            model: null,
            reasoning: null,
          });
          expect(
            store.claimWorkflowRequest({
              requestId: childRequestId,
              dispatchEpoch: workflow.dispatchEpoch,
              ownerId: "generated-runner",
              now: Date.now(),
            }),
          ).toBe(true);
          expect(
            store.recordWorkflowRequestTerminal({
              requestId: childRequestId,
              runId: authorized.policy.runId,
              operationId: authorized.policy.operationId,
              dispatchEpoch: workflow.dispatchEpoch,
              ownerId: "generated-runner",
              state: "resolved",
              output: "engine result",
              now: Date.now(),
            }),
          ).toBe(true);
          await bus.publish(
            lilacEventTypes.EvtAgentOutputDeltaText,
            { delta: "checking authentication middleware" },
            { headers: message.headers },
          );
          await bus.publish(
            lilacEventTypes.EvtAgentOutputResponseText,
            { finalText: "engine result" },
            { headers: message.headers },
          );
          await bus.publish(
            lilacEventTypes.EvtRequestLifecycleChanged,
            { state: "resolved" },
            { headers: message.headers },
          );
        }
        await context.commit();
      },
    );
    const engine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "generated-subagent-engine",
      pollMs: 5,
    });

    await engine.start();
    await waitFor(() => store.getRun(run.runId)?.state === "succeeded");
    await waitFor(() =>
      progress.some((display) => display.includes("checking authentication middleware")),
    );
    expect(childSessionId).toBe("sub:channel:1:named:audit");
    expect(hasWorkflowIdentity).toBe(true);
    expect(
      childRequestId ? store.getWorkflowRequestTerminalReceipt(childRequestId) : null,
    ).toMatchObject({ state: "resolved", output: "engine result" });
    expect(progress.some((display) => display.includes("subagent (explore;"))).toBe(true);
    expect(progress.some((display) => display.includes("checking authentication middleware"))).toBe(
      true,
    );
    expect(parent.listPending().map((completion) => completion.runId)).toEqual([run.runId]);
    await expect(handle.completion).resolves.toEqual({
      status: "resolved",
      finalText: "engine result",
    });

    await engine.stop();
    await parent.acknowledge([run.runId]);
    expect(parent.listPending()).toEqual([]);
    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("recovers and acknowledges pending completions in terminal order", async () => {
    const { store, run } = await createRun();
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "done",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });

    expect(parent.snapshot()).toMatchObject({
      hasPendingCompletions: true,
      hasOutstandingRuns: false,
    });
    expect(store.getLiveParentDeliverySnapshot("parent:1")).toEqual({
      pendingCompletionCount: 1,
      outstandingRunCount: 0,
    });
    const pending = parent.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      runId: run.runId,
      status: "resolved",
      finalText: "done",
    });
    parent.acknowledge([run.runId]);
    expect(parent.snapshot().hasPendingCompletions).toBe(false);
    expect(store.getLiveParentDeliverySnapshot("parent:1")).toEqual({
      pendingCompletionCount: 0,
      outstandingRunCount: 0,
    });

    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("keeps artifact-backed completion pending when artifact loading fails", async () => {
    const { store, run, dataDir } = await createRun();
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      resultArtifactId: `workflow-value:${"f".repeat(64)}`,
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      dataDir,
      subscriptionId: "missing-artifact-delivery",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await expect(parent.listPendingAsync()).rejects.toThrow();
    expect(parent.snapshot().hasPendingCompletions).toBe(true);
    await parent.close();
    await expect(bridge.enableFallbacks()).rejects.toThrow();
    expect(store.listOrphanedLiveParentCompletions().map((item) => item.runId)).toEqual([
      run.runId,
    ]);
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("materializes independent completions when one result artifact is unreadable", async () => {
    const setupResult = await setup();
    const first = await setupResult.dispatcher.delegate(
      registration(setupResult.projectRoot, "parent:partial-materialization"),
    );
    const second = await setupResult.dispatcher.delegate({
      ...registration(setupResult.projectRoot, "parent:partial-materialization"),
      childRequestId: "sub:child:materialized",
      childSessionId: "sub:channel:1:named:materialized",
      sessionName: "materialized",
      parentToolCallId: "tool:delegate:materialized",
    });
    const firstRun = setupResult.store.getRun(first.runId);
    const secondRun = setupResult.store.getRun(second.runId);
    if (!firstRun || !secondRun) throw new Error("generated subagent run not found");
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "queued",
      to: "running",
      now: 10,
    });
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      resultArtifactId: `workflow-value:${"f".repeat(64)}`,
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "queued",
      to: "running",
      now: 11,
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "running",
      to: "succeeded",
      now: 21,
      result: "available result",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store: setupResult.store,
      dataDir: setupResult.dataDir,
      subscriptionId: "partial-materialization",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:partial-materialization" });

    const settled = await parent.listPendingSettledAsync();
    expect(settled).toHaveLength(2);
    expect(settled.find((item) => !item.loaded)?.loaded).toBe(false);
    expect(
      settled.find((item) => item.loaded && item.completion.runId === second.runId),
    ).toMatchObject({
      loaded: true,
      completion: { finalText: "available result" },
    });

    await parent.close();
    await bridge.stop();
    await bus.close();
    setupResult.store.close();
  });

  it("orders out-of-order child completions by durable terminal time", async () => {
    const setupResult = await setup();
    const first = await setupResult.dispatcher.delegate(
      registration(setupResult.projectRoot, "parent:ordered"),
    );
    const secondRegistration = {
      ...registration(setupResult.projectRoot, "parent:ordered"),
      childRequestId: "sub:child:2",
      childSessionId: "sub:channel:1:named:audit-2",
      sessionName: "audit-2",
      parentToolCallId: "tool:delegate:2",
    };
    const second = await setupResult.dispatcher.delegate(secondRegistration);
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "queued",
      to: "running",
      now: 10,
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "queued",
      to: "running",
      now: 10,
    });
    setupResult.store.transitionRun({
      runId: first.runId,
      from: "running",
      to: "succeeded",
      now: 30,
      result: "first",
    });
    setupResult.store.transitionRun({
      runId: second.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "second",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store: setupResult.store,
      subscriptionId: "test-live-parent-order",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:ordered" });

    expect(parent.listPending().map((completion) => completion.runId)).toEqual([
      second.runId,
      first.runId,
    ]);

    await parent.close();
    await bridge.stop();
    await bus.close();
    setupResult.store.close();
  });

  it("cascades parent cancellation to active generated runs", async () => {
    const { store, run } = await createRun();
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-cancel",
    });
    const parent = bridge.registerParent({ parentRequestId: "parent:1" });
    await parent.cancelAll("parent request cancelled");

    expect(store.getRun(run.runId)?.state).toBe("cancelled");
    expect(parent.snapshot()).toMatchObject({
      hasPendingCompletions: false,
      hasOutstandingRuns: false,
    });

    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("releases each child activity subscription across many sequential children", async () => {
    const setupResult = await setup();
    const raw = createInMemoryRawBus();
    const bus = createLilacBus(raw);
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store: setupResult.store,
      subscriptionId: "test-live-parent-sequential",
    });
    await bridge.start();
    const parent = bridge.registerParent({ parentRequestId: "parent:sequential" });
    await parent.ready;
    expect(raw.activeSubscriptions()).toBe(1);

    for (let index = 0; index < 30; index += 1) {
      const childRequestId = `sub:sequential:${index}`;
      const handle = await setupResult.dispatcher.delegate({
        ...registration(setupResult.projectRoot, "parent:sequential"),
        childRequestId,
        childSessionId: `sub:session:${index}`,
      });
      const run = setupResult.store.getRun(handle.runId);
      if (!run) throw new Error("sequential child run missing");
      expect(
        setupResult.store.tryClaimRun({
          runId: run.runId,
          claimerId: "sequential-engine",
          now: 100 + index,
        }),
      ).not.toBeNull();
      const operationId = `operation-${index}`;
      expect(
        setupResult.store.createOperation(
          {
            runId: run.runId,
            operationId,
            callSiteId: `site-${index}`,
            parentOperationId: null,
            phase: null,
            label: "sequential child",
            kind: "agent",
            input: {},
            inputSha256: "a".repeat(64),
            state: "running",
            attempt: 0,
            requestId: childRequestId,
            output: null,
            resultArtifactId: null,
            error: null,
            usage: null,
            claimedBy: null,
            claimedAt: null,
            createdAt: 100 + index,
            startedAt: 100 + index,
            updatedAt: 100 + index,
            terminalAt: null,
          },
          "sequential-engine",
        ),
      ).toBe(true);
      await bus.publish(lilacEventTypes.EvtWorkflowOperationChanged, {
        runId: run.runId,
        revisionId: run.revisionId,
        operationId,
        kind: "agent",
        state: "running",
        ts: 100 + index,
      });
      expect(raw.activeSubscriptions()).toBe(2);
      expect(
        setupResult.store.transitionOperation({
          runOwnerId: "sequential-engine",
          runId: run.runId,
          operationId,
          from: "running",
          to: "succeeded",
          now: 190 + index,
          output: `result-${index}`,
        }),
      ).toBe(true);
      await bus.publish(lilacEventTypes.EvtWorkflowOperationChanged, {
        runId: run.runId,
        revisionId: run.revisionId,
        operationId,
        kind: "agent",
        state: "succeeded",
        previousState: "running",
        ts: 190 + index,
      });
      expect(raw.activeSubscriptions()).toBe(2);
      expect(
        setupResult.store.terminalizeRun({
          runId: run.runId,
          from: "running",
          to: "succeeded",
          ownerId: "sequential-engine",
          now: 200 + index,
          detail: "complete",
          result: `result-${index}`,
          resultArtifactId: null,
        }),
      ).toBe(true);
      await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
        runId: run.runId,
        revisionId: run.revisionId,
        state: "succeeded",
        previousState: "running",
        ts: 200 + index,
      });
      expect(raw.activeSubscriptions()).toBe(1);
    }

    await parent.close();
    await bridge.stop();
    expect(raw.activeSubscriptions()).toBe(0);
    await bus.close();
    setupResult.store.close();
  });

  it("converges a coalesced null-target event to one card after surface fallback", async () => {
    const { store, run } = await createRun();
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "fallback result",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new FallbackCardAdapter();
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "test-live-parent-fallback-projector",
      coalesceMs: 25,
      minEditIntervalMs: 0,
    });
    await projector.start();
    const projected: string[] = [];
    await bus.subscribeTopic(
      "evt.workflow",
      { mode: "tail", offset: { type: "begin" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.EvtWorkflowProgressRequested) {
          projected.push(message.data.runId);
        }
        await context.commit();
      },
    );
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-fallback",
    });
    const nullTargetProjection = store.waitForNullTargetProjection();
    await bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
      runId: run.runId,
      revisionId: run.revisionId,
      state: "succeeded",
      previousState: "running",
      ts: 20,
    });
    await nullTargetProjection;
    expect(store.getSurfaceBinding(run.runId)).toBeNull();
    expect(adapter.sends).toBe(0);
    await bridge.enableFallbacks();
    await waitFor(() => Boolean(store.getSurfaceBinding(run.runId)?.messageRef));

    expect(store.getRun(run.runId)?.progressTarget).toEqual({
      platform: "discord",
      channelId: "channel:1",
      replyToMessageId: null,
    });
    expect(projected).toContain(run.runId);
    expect(adapter.sends).toBe(1);
    expect(adapter.messages.size).toBe(1);
    expect(
      store.listSurfaceBindings({ limit: 10 }).filter((item) => item.runId === run.runId),
    ).toHaveLength(1);

    await projector.stop();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("reconciles a committed fallback after progress publication recovers", async () => {
    const { store, run } = await createRun("parent:publish-failure");
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "fallback after recovery",
    });
    const publishControl = { failProgressRequested: true, progressRequestedFailures: 0 };
    const bus = createLilacBus(createInMemoryRawBus(publishControl));
    const adapter = new FallbackCardAdapter();
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "test-live-parent-publish-recovery-projector",
      coalesceMs: 0,
      minEditIntervalMs: 0,
      retryIntervalMs: 10,
    });
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-publish-recovery",
    });
    await projector.start();

    await bridge.enableFallbacks();
    expect(publishControl.progressRequestedFailures).toBe(1);
    expect(store.getRun(run.runId)?.progressTarget).not.toBeNull();
    expect(store.getSurfaceBinding(run.runId)).toBeNull();

    publishControl.failProgressRequested = false;
    await projector.reconcile();
    await waitFor(() => Boolean(store.getSurfaceBinding(run.runId)?.messageRef));
    await Bun.sleep(30);
    expect(adapter.sends).toBe(1);
    expect(adapter.messages.size).toBe(1);
    expect(
      store.listSurfaceBindings({ limit: 10 }).filter((item) => item.runId === run.runId),
    ).toHaveLength(1);

    await projector.stop();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("keeps a completion with a parent that reattaches before fallback activation", async () => {
    const { root, store, run } = await createRun("parent:race");
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    const artifactId = "00000000-0000-0000-0000-000000000000";
    const result = [
      "preview",
      "",
      "[tool result truncated: 1 characters omitted]",
      `Complete output: tool-result://${artifactId}`,
      'Use read_file with this URI and start: { "type": "offset", "offset": 0 }. Reuse the returned nextStart unchanged while more content remains.',
      "",
      "tail",
    ].join("\n");
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result,
    });

    let releaseRead = () => {};
    let markReadStarted = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const toolResultArtifacts = createToolResultArtifactStore(path.join(root, "race-artifacts"));
    toolResultArtifacts.read = async () => {
      markReadStarted();
      await readGate;
      return {
        ok: true,
        content: "complete child output",
        id: artifactId,
        bytes: 21,
        createdAt: 1,
        expiresAt: 1_000,
      };
    };
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-reattachment-race",
      toolResultArtifacts,
    });

    const fallback = bridge.enableFallbacks();
    await readStarted;
    const parent = bridge.registerParent({ parentRequestId: "parent:race" });
    releaseRead();
    await fallback;

    expect(store.getRun(run.runId)?.progressTarget).toBeNull();
    const pending = await parent.listPendingAsync();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      runId: run.runId,
      finalText: "complete child output",
    });
    await parent.acknowledge([run.runId]);
    expect(await parent.listPendingAsync()).toHaveLength(0);

    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });

  it("does not fall back while a restored parent is reattaching", async () => {
    const { store, run } = await createRun("parent:restored");
    store.transitionRun({ runId: run.runId, from: "queued", to: "running", now: 10 });
    store.transitionRun({
      runId: run.runId,
      from: "running",
      to: "succeeded",
      now: 20,
      result: "restored result",
    });
    const bus = createLilacBus(createInMemoryRawBus());
    const bridge = new WorkflowLiveParentBridge({
      bus,
      store,
      subscriptionId: "test-live-parent-protected",
    });
    await bridge.enableFallbacks({
      protectedParentRequestIds: ["parent:restored"],
      protectionMs: 20,
    });
    expect(store.getRun(run.runId)?.progressTarget).toBeNull();

    const parent = bridge.registerParent({ parentRequestId: "parent:restored" });
    await Bun.sleep(30);
    expect(store.getRun(run.runId)?.progressTarget).toBeNull();
    expect(parent.listPending()).toHaveLength(1);

    await parent.close();
    await bridge.stop();
    await bus.close();
    store.close();
  });
});
