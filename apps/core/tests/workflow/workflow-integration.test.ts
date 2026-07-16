import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
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
import { ProgrammaticWorkflow } from "../../src/tool-server/tools/programmatic-workflow";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../../src/workflow/workflow-action-resolver";
import { WorkflowEngine } from "../../src/workflow/workflow-engine";
import { WorkflowProgressProjector } from "../../src/workflow/workflow-progress-projector";

class LiveRawBus implements RawBus {
  private sequence = 0;
  private readonly subscriptions = new Set<{
    topic: string;
    handler: (message: Message<unknown>, context: HandleContext) => Promise<void>;
  }>();

  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
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

class WorkflowCardAdapter implements SurfaceAdapter {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;
  edits = 0;

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
      delete: false,
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
    this.contents.push(content);
    const ref = {
      platform: "discord" as const,
      channelId: session.channelId,
      messageId: `workflow-card-${this.sends}`,
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
    if (!current) throw new Error("workflow card is missing");
    this.edits += 1;
    this.contents.push(content);
    this.messages.set(ref.messageId, { ...current, text: content.text ?? "" });
  }
  async deleteMsg() {}
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

function source(): string {
  return `import { defineWorkflow } from "@lilac/workflow";
export default defineWorkflow({
  name: "integration-audit",
  description: "Exercise the complete workflow integration",
  input: {
    type: "object",
    required: ["target", "token"],
    properties: {
      target: { type: "string" },
      token: { type: "string", sensitive: true },
    },
  },
  capabilities: {
    agents: { profiles: ["explore"], models: ["inherit"], maxConcurrent: 1, maxTotal: 1, editing: false, isolation: "shared" },
    waits: [],
  },
  async run({ args, phase, agent }) {
    return phase("audit", () => agent("Inspect " + args.target, { label: "integration audit" }));
  },
});
`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow integration");
    await Bun.sleep(10);
  }
}

describe("unified workflow integration", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("authors, reviews, approves, sandboxes, dispatches through the request bus, persists, and projects the terminal result", async () => {
    if (process.env.LILAC_WORKFLOW_SANDBOX_INTEGRATION !== "1") return;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-integration-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const store = new DurableWorkflowStore(path.join(root, "workflow.sqlite"));
    const bus = createLilacBus(new LiveRawBus());
    const adapter = new WorkflowCardAdapter();
    const projector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "integration-projector",
      coalesceMs: 5,
      minEditIntervalMs: 0,
      loadSource: async (revision) =>
        await fs.readFile(
          path.join(dataDir, "workflow-snapshots", `${revision.sourceSha256}.js`),
          "utf8",
        ),
    });
    const actionResolver = await startWorkflowActionResolver({
      bus,
      store,
      subscriptionId: "integration-actions",
    });
    const tool = new ProgrammaticWorkflow({
      workspaceRoot,
      dataDir,
      store,
      bus,
      progressCards: projector,
      reviewerResolver: {
        resolve: async () => ({
          platform: "discord",
          userId: "reviewer-1",
          sessionRef: { platform: "discord", channelId: "channel-1" },
          originMessageRef: {
            platform: "discord",
            channelId: "channel-1",
            messageId: "origin-1",
          },
        }),
      },
    });
    const requestIds: string[] = [];
    const requestResponder = await bus.subscribeTopic(
      "cmd.request",
      { mode: "fanout", subscriptionId: "integration-agent", offset: { type: "now" } },
      async (message, context) => {
        if (message.type === lilacEventTypes.CmdRequestMessage && message.data.queue === "prompt") {
          const requestId = message.headers?.request_id;
          if (!requestId) throw new Error("workflow request missing request_id");
          const workflow = z
            .object({
              workflow: z.object({
                runId: z.string(),
                operationId: z.string(),
                dispatchEpoch: z.string(),
                capability: z.string(),
              }),
            })
            .parse(message.data.raw).workflow;
          expect(
            store.claimWorkflowRequest({
              requestId,
              token: workflow.capability,
              dispatchEpoch: workflow.dispatchEpoch,
              ownerId: "integration-agent",
              now: 100,
            }),
          ).toBe(true);
          requestIds.push(requestId);
          await bus.publish(
            lilacEventTypes.EvtRequestLifecycleChanged,
            { state: "running" },
            { headers: message.headers },
          );
          await bus.publish(
            lilacEventTypes.EvtAgentOutputResponseText,
            {
              finalText: "integration result",
              usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
            },
            { headers: message.headers },
          );
          expect(
            store.recordWorkflowRequestTerminal({
              requestId,
              runId: workflow.runId,
              operationId: workflow.operationId,
              dispatchEpoch: workflow.dispatchEpoch,
              ownerId: "integration-agent",
              state: "resolved",
              output: "integration result",
              usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
              now: 100,
            }),
          ).toBe(true);
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
      subscriptionId: "integration-engine",
      pollMs: 5,
      now: () => 100,
    });
    const context = {
      requestId: "discord:channel-1:origin-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
      toolCallId: "integration-tool-1",
    };

    try {
      await projector.start();
      await tool.init();
      await tool.call(
        "workflow.definition.save",
        { scope: "project", name: "integration-audit", source: source() },
        { context },
      );
      await tool.call(
        "workflow.definition.validate",
        {
          scope: "auto",
          name: "integration-audit",
          args: { target: "src", token: "super-secret-value" },
        },
        { context },
      );
      const triggered = await tool.call(
        "workflow.run.trigger",
        {
          scope: "auto",
          name: "integration-audit",
          args: { target: "src", token: "super-secret-value" },
          progress: { requestOrigin: true },
        },
        { context },
      );
      const { runId } = z.object({ runId: z.string() }).parse(triggered);
      expect(store.getRun(runId)?.state).toBe("awaiting_review");
      expect(adapter.contents[0]?.actions?.map((action) => action.label)).toEqual([
        "Approve",
        "Reject",
      ]);
      expect(JSON.stringify(adapter.contents)).not.toContain("super-secret-value");

      const approveToken = adapter.contents[0]?.actions?.find(
        (action) => action.label === "Approve",
      )?.actionId;
      const binding = store.getSurfaceBinding(runId);
      if (!approveToken || !binding?.messageRef) throw new Error("review action was not bound");
      await engine.start();
      await Bun.sleep(25);
      expect(store.listOperations(runId)).toEqual([]);
      await bus.publish(lilacEventTypes.EvtAdapterActionInvoked, {
        actionId: approveToken,
        platform: "discord",
        userId: "reviewer-1",
        messageRef: binding.messageRef,
        ts: Date.now(),
      });
      expect(["queued", "running", "succeeded"].includes(store.getRun(runId)?.state ?? "")).toBe(
        true,
      );

      await waitFor(() => store.getRun(runId)?.state === "succeeded");
      await waitFor(() =>
        adapter.contents.some((content) => content.text?.includes("State: **succeeded**")),
      );
      const run = store.getRun(runId);
      const operations = store.listOperations(runId);
      expect(run).toMatchObject({
        result: "integration result",
        terminalDetail: "Workflow completed",
      });
      expect(operations.map((operation) => operation.kind)).toEqual(["phase", "agent"]);
      expect(operations[1]).toMatchObject({
        state: "succeeded",
        output: "integration result",
        usage: { totalTokens: 11 },
      });
      expect(requestIds).toHaveLength(1);
      expect(operations[1]?.requestId).toBe(requestIds[0]);
      expect(requestIds[0]).toMatch(/^wfr:/u);
      expect(adapter.contents.at(-1)?.text).not.toContain("integration result");
      expect(adapter.contents.at(-1)?.actions).toEqual([]);
      expect(JSON.stringify(adapter.contents)).not.toContain("super-secret-value");
    } finally {
      await engine.stop();
      await requestResponder.stop();
      await actionResolver.stop();
      await projector.stop();
      await tool.destroy();
      await bus.close();
      store.close();
    }
  }, 20_000);

  it("hard-restarts an active execution and recovers its journal plus existing surface binding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-hard-restart-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const dbPath = path.join(root, "workflow.sqlite");
    await fs.mkdir(workspaceRoot);
    let store = new DurableWorkflowStore(dbPath);
    const bus = createLilacBus(new LiveRawBus());
    const adapter = new WorkflowCardAdapter();
    const context = {
      requestId: "discord:channel-1:origin-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      authenticatedPrincipal: { platform: "discord" as const, userId: "user-1" },
      toolCallId: "restart-tool-1",
    };
    const reviewerResolver = {
      resolve: async () => ({
        platform: "discord" as const,
        userId: "reviewer-1",
        sessionRef: { platform: "discord" as const, channelId: "channel-1" },
        originMessageRef: {
          platform: "discord" as const,
          channelId: "channel-1",
          messageId: "origin-1",
        },
      }),
    };
    const firstProjector = new WorkflowProgressProjector({
      bus,
      store,
      adapters: new Map([["discord", adapter]]),
      subscriptionId: "restart-projector-first",
      coalesceMs: 5,
      minEditIntervalMs: 0,
    });
    const tool = new ProgrammaticWorkflow({
      workspaceRoot,
      dataDir,
      store,
      bus,
      progressCards: firstProjector,
      reviewerResolver,
    });
    await tool.init();
    await firstProjector.start();
    await tool.call(
      "workflow.definition.save",
      { scope: "project", name: "integration-audit", source: source() },
      { context },
    );
    const triggered = await tool.call(
      "workflow.run.trigger",
      {
        scope: "auto",
        name: "integration-audit",
        args: { target: "restart", token: "restart-secret" },
      },
      { context },
    );
    const { runId, approvalId } = z
      .object({ runId: z.string(), approvalId: z.string() })
      .parse(triggered);
    store.transitionApproval({ approvalId, from: "pending", to: "approved", now: Date.now() });
    const firstBinding = store.getSurfaceBinding(runId)?.messageRef;
    const firstEngine = new WorkflowEngine({
      bus,
      store,
      dataDir,
      subscriptionId: "restart-engine-first",
      pollMs: 5,
      now: () => 100,
      assertSandbox: async () => {},
      loadSnapshot: async () => "immutable",
      compileSource: (value) => value,
      startSandbox: (input) => ({
        cancel: async () => {},
        result: input.onCall({
          type: "call",
          id: 1,
          kind: "agent",
          callSiteId: "restart-agent",
          occurrence: 0,
          path: "root:restart-agent:0",
          parentPath: null,
          phase: "audit",
          depth: 1,
          input: { prompt: "restart", options: { label: "restart agent" } },
        }),
      }),
      dispatchAgentRequest: async ({ signal }) => {
        return await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ state: "cancelled", output: "", detail: "core stopped", usage: null }),
            { once: true },
          );
        });
      },
    });

    try {
      await firstEngine.start();
      await waitFor(() => store.listOperations(runId, { state: "dispatched" }).length === 1);
      const persistedRequestId = store.listOperations(runId)[0]?.requestId;
      if (!persistedRequestId) throw new Error("active operation did not persist its request ID");
      await firstEngine.stop();
      await firstProjector.stop();
      await tool.destroy();
      store.close();

      store = new DurableWorkflowStore(dbPath);
      const restartedProjector = new WorkflowProgressProjector({
        bus,
        store,
        adapters: new Map([["discord", adapter]]),
        subscriptionId: "restart-projector-second",
        coalesceMs: 5,
        minEditIntervalMs: 0,
      });
      await restartedProjector.start();
      expect(store.getSurfaceBinding(runId)?.messageRef).toEqual(firstBinding);
      expect(adapter.sends).toBe(1);

      let reconciled = false;
      const restartedEngine = new WorkflowEngine({
        bus,
        store,
        dataDir,
        subscriptionId: "restart-engine-second",
        pollMs: 5,
        now: () => 60_101,
        assertSandbox: async () => {},
        loadSnapshot: async () => "immutable",
        compileSource: (value) => value,
        startSandbox: (input) => ({
          cancel: async () => {},
          result: input.onCall({
            type: "call",
            id: 1,
            kind: "agent",
            callSiteId: "restart-agent",
            occurrence: 0,
            path: "root:restart-agent:0",
            parentPath: null,
            phase: "audit",
            depth: 1,
            input: { prompt: "restart", options: { label: "restart agent" } },
          }),
        }),
        dispatchAgentRequest: async ({ requestId, reconcile }) => {
          expect(requestId).toBe(persistedRequestId);
          reconciled = reconcile;
          return { state: "resolved", output: "recovered result", detail: null, usage: null };
        },
      });
      await restartedEngine.start();
      await waitFor(() => store.getRun(runId)?.state === "succeeded");
      await waitFor(() =>
        adapter.contents.some((content) => content.text?.includes("State: **succeeded**")),
      );
      expect(reconciled).toBe(true);
      expect(store.listOperations(runId)).toHaveLength(1);
      expect(store.getRun(runId)?.result).toBe("recovered result");
      expect(JSON.stringify(adapter.contents)).not.toContain("restart-secret");
      await restartedEngine.stop();
      await restartedProjector.stop();
    } finally {
      await firstEngine.stop();
      await firstProjector.stop();
      await tool.destroy();
      await bus.close();
      store.close();
    }
  }, 15_000);
});
