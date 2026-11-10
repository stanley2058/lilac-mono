import { workflowStoreValue } from "./workflow-store-test-helpers";
import { createWorkflowTestBlobStore } from "./workflow-test-blob-store";
import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { Result, type Result as ResultType } from "better-result";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ToolSet } from "ai";
import { AiSdkPiAgent, type AiSdkPiAgentOptions } from "@stanley2058/lilac-agent";
import type { ServerToolResult } from "@stanley2058/lilac-plugin-runtime";
import { parseCoreConfigV1ToUniversal, toDurableResolvedModelPlan } from "@stanley2058/lilac-utils";
import {
  createLilacBus,
  lilacEventTypes,
  type FetchOptions,
  type Message,
  type PublishOptions,
  type RawBus,
  type SubscriptionOptions,
} from "@stanley2058/lilac-event-bus";

const blobStore = await createWorkflowTestBlobStore();
import {
  okResultForTest,
  startResultForTest,
  stopResultForTest,
  subscribeForTest,
  type TestRawMessageHandler,
} from "../helpers/result-raw-bus";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
} from "../../src/surface/types";
import { createDiscordWorkflowProgressPort } from "../../src/surface/discord/discord-runtime-descriptor";
import { discordSurfaceProtocol } from "../../src/surface/discord/discord-surface-protocol";
import type { SurfaceProtocolResolver } from "../../src/surface/runtime-descriptor";
import { ProgrammaticWorkflow } from "../../src/tool-server/tools/programmatic-workflow";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { startWorkflowActionResolver } from "../../src/workflow/workflow-action-resolver";
import { WorkflowEngine } from "../../src/workflow/workflow-engine";
import { WorkflowProgressProjector } from "../../src/workflow/workflow-progress-projector";
import { SurfaceAdapterTestBase } from "../helpers/surface-adapter-test-base";
import { createRequestMessageCache } from "../../src/tool-server/request-message-cache";
import {
  joinAgentRunRecoveryHeads,
  resolveRequestCapabilityIdentity,
} from "../../src/runtime/create-core-runtime";
import {
  resolveAgentRunModel,
  startBusAgentRunner,
} from "../../src/surface/bridge/bus-agent-runner";
import { createCoreToolPluginManager, type CoreToolPluginManager } from "../../src/plugins";
import { createToolServer } from "../../src/tool-server/create-tool-server";
import { RequestControlAuthority } from "../../src/tool-server/request-control-authority";
import type { RequestContext, ServerTool } from "../../src/tool-server/types";
import { SqliteAgentRunJournal } from "../../src/surface/bridge/agent-run-journal";
import { createCoreRequestDelivery } from "../../src/surface/bridge/request-delivery";

function serverToolValue<T>(result: ServerToolResult<T>): T {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw new Error(error.message);
    },
  })();
}

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

const TEST_SURFACE_PROTOCOL_RESOLVER: SurfaceProtocolResolver = {
  resolve: (platform) =>
    platform === "discord" ? { platform, protocol: discordSurfaceProtocol } : null,
};

function createWorkflowProgressProjectorForTest(
  input: Omit<ConstructorParameters<typeof WorkflowProgressProjector>[0], "reportFatalPanic">,
) {
  return new WorkflowProgressProjector({
    ...input,
    reportFatalPanic: (panic) => {
      throw panic;
    },
  });
}

function workflowProgressPorts(adapter: WorkflowCardAdapter) {
  return new Map([
    [
      "discord" as const,
      {
        platform: "discord" as const,
        protocol: discordSurfaceProtocol,
        port: createDiscordWorkflowProgressPort(adapter),
      },
    ],
  ]);
}

class LiveRawBus implements RawBus {
  subscribe = subscribeForTest;
  readonly messages: Array<Omit<Message<unknown>, "id" | "ts">> = [];
  private sequence = 0;
  private readonly subscriptions = new Set<{
    topic: string;
    handler: TestRawMessageHandler;
  }>();
  async publish<TData>(message: Omit<Message<TData>, "id" | "ts">, options: PublishOptions) {
    this.messages.push(message);
    const id = `${++this.sequence}-0`;
    const stored: Message<TData> = { ...message, id, ts: Date.now(), topic: options.topic };
    for (const subscription of this.subscriptions) {
      if (subscription.topic === options.topic) {
        await subscription.handler(stored, id);
      }
    }
    return { id, cursor: id };
  }
  async openTestSubscription(
    topic: string,
    _options: SubscriptionOptions,
    handler: TestRawMessageHandler,
  ) {
    const subscription = { topic, handler };
    this.subscriptions.add(subscription);
    return { stop: async () => void this.subscriptions.delete(subscription) };
  }
  async fetch(_topic: string, _options: FetchOptions) {
    return { messages: [] };
  }
  async close() {
    this.subscriptions.clear();
  }
}
class WorkflowReceiptTrackingStore extends DurableWorkflowStore {
  readonly requestClaims: Array<{
    requestId: string;
    claimed: boolean;
  }> = [];
  readonly terminalRequests: Array<{
    requestId: string;
    recorded: boolean;
  }> = [];
  override claimWorkflowRequest(
    input: Parameters<DurableWorkflowStore["claimWorkflowRequest"]>[0],
  ): boolean {
    const claimed = super.claimWorkflowRequest(input);
    this.requestClaims.push({ requestId: input.requestId, claimed });
    return claimed;
  }
  override recordWorkflowRequestTerminal(
    input: Parameters<DurableWorkflowStore["recordWorkflowRequestTerminal"]>[0],
  ): boolean {
    const recorded = super.recordWorkflowRequestTerminal(input);
    this.terminalRequests.push({ requestId: input.requestId, recorded });
    return recorded;
  }
}
class WorkflowCardAdapter extends SurfaceAdapterTestBase {
  readonly contents: ContentOpts[] = [];
  readonly messages = new Map<string, SurfaceMessage>();
  sends = 0;
  edits = 0;
  async connect() {}
  async disconnect() {}
  async getSelf() {
    return { platform: "discord" as const, userId: "bot", userName: "bot" };
  }
  async listSessions() {
    return Result.ok([]);
  }
  async startOutput() {
    return Result.ok({
      push: async () => Result.ok("visible" as const),
      finish: async () => {
        const ref = { platform: "discord" as const, channelId: "unused", messageId: "unused" };
        return Result.ok({ created: [ref], last: ref });
      },
      abort: async () => Result.ok(undefined),
    });
  }
  async sendMsg(session: SessionRef, content: ContentOpts, _opts?: SendOpts) {
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
    return Result.ok(ref);
  }
  async readMsg(ref: MsgRef) {
    return Result.ok(this.messages.get(ref.messageId) ?? null);
  }
  async listMsg(_session: SessionRef, _opts?: LimitOpts) {
    return Result.ok([...this.messages.values()]);
  }
  async editMsg(ref: MsgRef, content: ContentOpts) {
    const current = this.messages.get(ref.messageId);
    if (!current) return Result.ok(undefined);
    this.edits += 1;
    this.contents.push(content);
    this.messages.set(ref.messageId, { ...current, text: content.text ?? "" });
    return Result.ok(undefined);
  }
  async deleteMsg() {
    return Result.ok(undefined);
  }
  async getReplyContext() {
    return Result.ok([]);
  }
  async addReaction() {
    return Result.ok(undefined);
  }
  async removeReaction() {
    return Result.ok(undefined);
  }
  async listReactions() {
    return Result.ok([]);
  }
  async getUnRead() {
    return Result.ok([]);
  }
  async markRead() {
    return Result.ok(undefined);
  }
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
  resources: {
    agents: { maxConcurrent: 1, maxTotal: 1 },
    waits: [],
  },
  async run({ args, phase, agent }) {
    return phase("audit", () => agent("Inspect " + args.target, { profile: "explore", label: "integration audit" }));
  },
});
`;
}

function workflowAgentTextStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: text },
        { type: "text-end" as const, id: "text" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 0, text: 0, reasoning: 0 },
          },
        },
      ],
    }),
  };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow integration");
    // test-wait-justification: polls integration state produced by independently scheduled workflow and bus workers
    await Bun.sleep(10);
  }
}
describe("unified workflow integration", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });
  it("authors, validates, dispatches through the request bus, persists, and projects the terminal result", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-integration-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    await fs.mkdir(workspaceRoot);
    const store = new DurableWorkflowStore(path.join(root, "workflow.sqlite"));
    const bus = createLilacBus(new LiveRawBus());
    const requestMessageCache = createRequestMessageCache();
    const adapter = new WorkflowCardAdapter();
    const projector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: workflowProgressPorts(adapter),
      subscriptionId: "integration-projector",
      coalesceMs: 5,
      minEditIntervalMs: 0,
    });
    const actionResolver = await startWorkflowActionResolver({
      bus,
      store,
      subscriptionId: "integration-actions",
      surfaceProtocolResolver: TEST_SURFACE_PROTOCOL_RESOLVER,
    });
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir,
      store,
      bus,
      progressCards: projector,
    });
    const requestIds: string[] = [];
    const requestResponder = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "integration-agent" },
        async (message) => {
          if (
            message.type === lilacEventTypes.CmdRequestMessage &&
            message.data.queue === "prompt"
          ) {
            const requestId = message.headers?.request_id;
            const sessionId = message.headers?.session_id;
            if (!requestId || !sessionId) throw new Error("workflow request missing identity");
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
            requestIds.push(requestId);
          }
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const level1Contexts: Array<
      NonNullable<
        Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      >
    > = [];
    const level2Contexts: RequestContext[] = [];
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "openai/workflow-integration" };
    const pluginManager = createCoreToolPluginManager({ runtime: { config }, dataDir });
    const pluginInitialized = await pluginManager.init();
    if (pluginInitialized.status === "error") throw pluginInitialized.error;
    const buildLevel1ToolsetResult = pluginManager.buildLevel1ToolsetResult.bind(pluginManager);
    pluginManager.buildLevel1ToolsetResult = async (input) => {
      if (input.requestContext) level1Contexts.push(input.requestContext);
      return await buildLevel1ToolsetResult(input);
    };
    const level2Tool: ServerTool = {
      id: "workflow-integration-level2",
      async init() {},
      async destroy() {},
      async list() {
        return [
          {
            callableId: "workflow.integration.level2",
            name: "Workflow integration Level 2",
            description: "Exercises delegated workflow authority",
            shortInput: [],
          },
        ];
      },
      async call(_callableId, _input, options) {
        if (options?.context) level2Contexts.push(options.context);
        return Result.ok({ ok: true });
      },
    };
    const requestControlAuthority = new RequestControlAuthority();
    const toolServer = createToolServer({
      tools: [level2Tool],
      requestMessageCache,
      authorizeControlRequest: (input) => requestControlAuthority.authorize(input),
    });
    await toolServer.init();
    let activeCapability:
      | {
          readonly requestId: string;
          readonly sessionId: string;
          readonly token: string;
        }
      | undefined;
    const runner = await startBusAgentRunner({
      bus,
      blobStore,
      subscriptionId: "integration-runner",
      config,
      pluginManager,
      durableWorkflowStore: store,
      surfaceProtocolResolver: TEST_SURFACE_PROTOCOL_RESOLVER,
      requestMessageCache,
      reportFatalPanic: (panic) => {
        throw panic;
      },
      issueControlCapability: (input) => {
        const cachedRequest = requestMessageCache.getOrigin(input.requestId);
        expect(cachedRequest).toMatchObject({
          requestClient: "unknown",
          source: "internal-delegated",
          authenticatedOrigin: { platform: "discord", userId: "user-1" },
        });
        const identity = resolveRequestCapabilityIdentity({
          requestClient: input.requestClient,
          sessionId: input.sessionId,
          safetyMode: input.safetyMode,
          ...(input.authenticatedOrigin ? { authenticatedOrigin: input.authenticatedOrigin } : {}),
          ...(cachedRequest ? { cachedRequest } : {}),
        });
        const token = requestControlAuthority.issue({
          kind: "primary",
          requestId: input.requestId,
          sessionId: input.sessionId,
          platform: input.requestClient,
          principal: identity.principal,
          authenticatedOrigin: identity.authenticatedOrigin,
          allowedCallables: null,
          profile: input.profile,
          canonicalCwd: input.canonicalCwd,
          safetyMode: identity.safetyMode,
          expiresAt: input.expiresAt,
        });
        activeCapability = {
          requestId: input.requestId,
          sessionId: input.sessionId,
          token,
        };
        return { capability: token, ...identity };
      },
      expireControlCapability: (requestId) => requestControlAuthority.expire(requestId),
      createAgent: (options: AiSdkPiAgentOptions<ToolSet>) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "workflow-integration",
            doStream: async () => {
              const capability = activeCapability;
              if (!capability) throw new Error("workflow capability was not issued");
              const response = await toolServer.app.handle(
                new Request("http://localhost/call", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "x-lilac-request-id": capability.requestId,
                    "x-lilac-session-id": capability.sessionId,
                    "x-lilac-request-client": "unknown",
                    "x-lilac-cwd": workspaceRoot,
                    "x-lilac-control-capability": capability.token,
                  },
                  body: JSON.stringify({
                    callableId: "workflow.integration.level2",
                    input: {},
                  }),
                }),
              );
              expect(response.status).toBe(200);
              return workflowAgentTextStep("integration result");
            },
          }),
        }),
    });
    const engine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir,
      subscriptionId: "integration-engine",
      pollMs: 5,
      now: () => 100,
      validateAgentSelection: ({ profile, model, reasoning }) => {
        const resolved = resolveAgentRunModel({
          cfg: config,
          runProfile: profile,
          ...(model ? { requestModelOverride: model } : {}),
          ...(reasoning ? { reasoningOverride: reasoning } : {}),
        });
        return {
          model: resolved.head.spec,
          reasoning: resolved.head.reasoning ?? null,
          request: toDurableResolvedModelPlan(resolved, config.agent.reasoningDisplay),
        };
      },
    });
    const context = {
      requestId: "discord:channel-1:origin-1",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      projectRoot: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      requestInitiator: { platform: "discord" as const, userId: "user-1" },
      requestInitiatorSessionId: "channel-1",
      toolCallId: "integration-tool-1",
    };
    try {
      await projector.start();
      await tool.init();
      serverToolValue(
        await tool.call(
          "workflow.definition.save",
          { scope: "project", name: "integration-audit", source: source() },
          { context },
        ),
      );
      serverToolValue(
        await tool.call(
          "workflow.definition.validate",
          {
            scope: "auto",
            name: "integration-audit",
            args: { target: "src", token: "super-secret-value" },
          },
          { context },
        ),
      );
      const triggered = serverToolValue(
        await tool.call(
          "workflow.run.trigger",
          {
            scope: "auto",
            name: "integration-audit",
            args: { target: "src", token: "super-secret-value" },
            progress: { requestOrigin: true },
          },
          { context },
        ),
      );
      const { runId } = z.object({ runId: z.string() }).parse(triggered);
      expect(workflowStoreValue(store.getRun(runId))?.state).toBe("queued");
      expect(adapter.contents[0]?.actions?.map((action) => action.label)).toEqual([
        "Pause",
        "Cancel",
      ]);
      expect(JSON.stringify(adapter.contents)).not.toContain("super-secret-value");
      await engine.start();
      expect(
        ["queued", "running", "succeeded"].includes(
          workflowStoreValue(store.getRun(runId))?.state ?? "",
        ),
      ).toBe(true);
      await waitFor(() => workflowStoreValue(store.getRun(runId))?.state === "succeeded");
      await waitFor(() =>
        adapter.contents.some((content) => content.text?.includes("**Succeeded**")),
      );
      const run = workflowStoreValue(store.getRun(runId));
      const operations = workflowStoreValue(store.listOperations(runId));
      const agentOperation = operations.find((operation) => operation.kind === "agent");
      expect(run).toMatchObject({
        result: "integration result",
        terminalDetail: "Workflow completed",
      });
      expect(operations.map((operation) => operation.kind).sort()).toEqual(["agent", "phase"]);
      expect(agentOperation).toMatchObject({
        state: "succeeded",
        output: "integration result",
        usage: { totalTokens: 0 },
      });
      expect(requestIds).toHaveLength(1);
      expect(agentOperation?.requestId).toBe(requestIds[0]);
      expect(requestIds[0]).toMatch(/^wfr:/u);
      expect(level1Contexts).toHaveLength(1);
      expect(level1Contexts[0]).toMatchObject({
        requestId: requestIds[0],
        requestClient: "unknown",
        safetyMode: "trusted",
        requestInitiator: { platform: "discord", userId: "user-1" },
        requestInitiatorSessionId: "channel-1",
      });
      expect(level2Contexts).toHaveLength(1);
      expect(level2Contexts[0]).toMatchObject({
        requestId: requestIds[0],
        requestClient: "unknown",
        safetyMode: "trusted",
        requestInitiator: { platform: "discord", userId: "user-1" },
        requestInitiatorSessionId: "channel-1",
      });
      expect(adapter.contents.at(-1)?.text).not.toContain("integration result");
      expect(adapter.contents.at(-1)?.actions).toEqual([]);
      expect(JSON.stringify(adapter.contents)).not.toContain("super-secret-value");
    } finally {
      await engine.stop();
      await runner.stop();
      await stopResultForTest(requestResponder.stop());
      await requestMessageCache.stop();
      await toolServer.stop();
      await pluginManager.destroy();
      await actionResolver.stop();
      await projector.stop();
      await tool.destroy();
      await bus.close();
      store.close();
    }
  }, 20000);
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
      projectRoot: workspaceRoot,
      safetyMode: "trusted" as const,
      serverOwnedRequest: true,
      requestInitiator: { platform: "discord" as const, userId: "user-1" },
      requestInitiatorSessionId: "channel-1",
      toolCallId: "restart-tool-1",
    };
    const firstProjector = createWorkflowProgressProjectorForTest({
      bus,
      store,
      ports: workflowProgressPorts(adapter),
      subscriptionId: "restart-projector-first",
      coalesceMs: 5,
      minEditIntervalMs: 0,
    });
    const tool = new ProgrammaticWorkflow({
      blobStore,
      dataDir,
      store,
      bus,
      progressCards: firstProjector,
    });
    await tool.init();
    await firstProjector.start();
    serverToolValue(
      await tool.call(
        "workflow.definition.save",
        { scope: "project", name: "integration-audit", source: source() },
        { context },
      ),
    );
    const triggered = serverToolValue(
      await tool.call(
        "workflow.run.trigger",
        {
          scope: "auto",
          name: "integration-audit",
          args: { target: "restart", token: "restart-secret" },
        },
        { context },
      ),
    );
    const { runId } = z.object({ runId: z.string() }).parse(triggered);
    const firstBinding = workflowStoreValue(store.getSurfaceBinding(runId))?.messageRef;
    const firstEngine = new WorkflowEngine({
      bus,
      store,
      blobStore,
      dataDir,
      subscriptionId: "restart-engine-first",
      pollMs: 5,
      now: () => 100,
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
    let restartedEngine: WorkflowEngine | null = null;
    let restartedProjector: WorkflowProgressProjector | null = null;
    try {
      await firstEngine.start();
      await waitFor(
        () => workflowStoreValue(store.listOperations(runId, { state: "dispatched" })).length === 1,
      );
      const persistedRequestId = workflowStoreValue(store.listOperations(runId)).find(
        (operation) => operation.kind === "agent",
      )?.requestId;
      if (!persistedRequestId) throw new Error("active operation did not persist its request ID");
      await firstEngine.stop();
      await firstProjector.stop();
      await tool.destroy();
      store.close();
      store = new DurableWorkflowStore(dbPath);
      restartedProjector = createWorkflowProgressProjectorForTest({
        bus,
        store,
        ports: workflowProgressPorts(adapter),
        subscriptionId: "restart-projector-second",
        coalesceMs: 5,
        minEditIntervalMs: 0,
      });
      await restartedProjector.start();
      expect(workflowStoreValue(store.getSurfaceBinding(runId))?.messageRef).toEqual(firstBinding);
      expect(adapter.sends).toBe(1);
      let reconciled = false;
      restartedEngine = new WorkflowEngine({
        bus,
        store,
        blobStore,
        dataDir,
        subscriptionId: "restart-engine-second",
        pollMs: 5,
        now: () => 60101,
        dispatchAgentRequest: async ({ requestId, reconcile }) => {
          expect(requestId).toBe(persistedRequestId);
          reconciled = reconcile;
          return { state: "resolved", output: "recovered result", detail: null, usage: null };
        },
      });
      await restartedEngine.start();
      await waitFor(() => workflowStoreValue(store.getRun(runId))?.state === "succeeded");
      await waitFor(() =>
        adapter.contents.some((content) => content.text?.includes("**Succeeded**")),
      );
      expect(reconciled).toBe(true);
      expect(
        workflowStoreValue(store.listOperations(runId))
          .map((operation) => operation.kind)
          .sort(),
      ).toEqual(["agent", "phase"]);
      expect(workflowStoreValue(store.getRun(runId))?.result).toBe("recovered result");
      expect(JSON.stringify(adapter.contents)).not.toContain("restart-secret");
      await restartedEngine.stop();
      await restartedProjector.stop();
    } finally {
      await restartedEngine?.stop();
      await restartedProjector?.stop();
      await firstEngine.stop();
      await firstProjector.stop();
      await tool.destroy();
      await bus.close();
      store.close();
    }
  }, 15000);
  it("converges workflow ownership with one recovered child from an active agent WAL head", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-workflow-agent-wal-restart-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const workflowDbPath = path.join(root, "workflow.sqlite");
    const requestDbPath = path.join(root, "request-delivery.db");
    await fs.mkdir(workspaceRoot);

    let workflowStore = new DurableWorkflowStore(workflowDbPath);
    let requestDelivery = createCoreRequestDelivery({
      dbPath: requestDbPath,
      blobStore,
      now: () => 100,
    });
    let journal = new SqliteAgentRunJournal({ dbPath: requestDbPath, now: () => 100 });
    const raw = new LiveRawBus();
    const bus = createLilacBus(raw);
    const tool = new ProgrammaticWorkflow({ blobStore, dataDir, store: workflowStore, bus });
    const config = parseCoreConfigV1ToUniversal({});
    config.models.main = { model: "openai/workflow-wal-recovery" };
    const context: RequestContext = {
      requestId: "discord:channel-1:wal-origin",
      sessionId: "channel-1",
      requestClient: "discord",
      cwd: workspaceRoot,
      safetyMode: "trusted",
      serverOwnedRequest: true,
      requestInitiator: { platform: "discord", userId: "user-1" },
      requestInitiatorSessionId: "channel-1",
      toolCallId: "workflow-wal-tool",
    };
    const persisted = Promise.withResolvers<{
      requestDeliveryId: string;
      requestId: string;
      sessionId: string;
      dispatchEpoch: string;
    }>();
    const firstRequestCapture = await startResultForTest(
      bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "workflow-wal-crashing-runner" },
        async (message) => {
          if (
            message.type !== lilacEventTypes.CmdRequestMessage ||
            message.data.queue !== "prompt"
          ) {
            return okResultForTest();
          }
          const requestId = message.headers?.request_id;
          const sessionId = message.headers?.session_id;
          if (!requestId || !sessionId) throw new Error("workflow request missing identity");
          const workflow = z
            .object({
              workflow: z.strictObject({
                runId: z.string(),
                operationId: z.string(),
                dispatchEpoch: z.string(),
              }),
            })
            .parse(message.data.raw).workflow;
          const requestDeliveryId = message.data.requestDeliveryId;
          const prompt = z
            .object({ role: z.literal("user"), content: z.string() })
            .parse(message.data.messages[0]).content;
          const data = {
            requestDeliveryId,
            queue: "prompt" as const,
            messages: [{ role: "user" as const, content: prompt }],
            raw: message.data.raw,
          };
          const headers = {
            ...message.headers,
            request_id: requestId,
            session_id: sessionId,
            request_client: "unknown" as const,
          };
          resultValue(
            requestDelivery.store.prepare({
              requestDeliveryId,
              requestId,
              envelope: { headers, data },
              inputHandles: [],
              createdAt: 100,
            }),
          );
          const accepted = resultValue(
            requestDelivery.store.accept({
              requestDeliveryId,
              work: {
                requestDeliveryId,
                requestId,
                sessionId,
                requestClient: "unknown",
                headers,
                data,
              },
              inputReferences: [],
              acceptedAt: 100,
            }),
          ).record;
          expect(
            workflowStore.claimWorkflowRequest({
              requestId,
              dispatchEpoch: workflow.dispatchEpoch,
              ownerId: "crashed-agent-runner",
              now: 70_000,
            }),
          ).toBe(true);
          const handle = resultValue(
            journal.openRun({
              requestDeliveryId: accepted.requestDeliveryId,
              requestId: accepted.requestId,
              sessionId: accepted.work.sessionId,
            }),
          );
          resultValue(
            journal.writeCheckpoint(handle, {
              version: 1,
              messages: [{ role: "user", content: "durable workflow child checkpoint" }],
              retainedRequestDeliveries: [],
            }),
          );
          persisted.resolve({ requestDeliveryId, requestId, sessionId, ...workflow });
          return okResultForTest();
        },
        () => "commit",
      ),
    );
    const firstEngine = new WorkflowEngine({
      bus,
      store: workflowStore,
      blobStore,
      dataDir,
      subscriptionId: "workflow-wal-first",
      pollMs: 5,
      now: () => 100,
      validateAgentSelection: ({ profile, model, reasoning }) => {
        const resolved = resolveAgentRunModel({
          cfg: config,
          runProfile: profile,
          ...(model ? { requestModelOverride: model } : {}),
          ...(reasoning ? { reasoningOverride: reasoning } : {}),
        });
        return {
          model: resolved.head.spec,
          reasoning: resolved.head.reasoning ?? null,
          request: toDurableResolvedModelPlan(resolved, config.agent.reasoningDisplay),
        };
      },
    });

    let restartedEngine: WorkflowEngine | null = null;
    let runner: Awaited<ReturnType<typeof startBusAgentRunner>> | null = null;
    let pluginManager: CoreToolPluginManager | null = null;
    try {
      await tool.init();
      serverToolValue(
        await tool.call(
          "workflow.definition.save",
          { scope: "project", name: "integration-audit", source: source() },
          { context },
        ),
      );
      const triggered = serverToolValue(
        await tool.call(
          "workflow.run.trigger",
          {
            scope: "project",
            name: "integration-audit",
            args: { target: "agent WAL restart", token: "workflow-wal-secret" },
          },
          { context },
        ),
      );
      const { runId } = z.object({ runId: z.string() }).parse(triggered);
      await firstEngine.start();
      const child = await persisted.promise;
      expect(workflowStoreValue(workflowStore.getRun(runId))?.state).toBe("running");
      expect(
        workflowStoreValue(workflowStore.listOperations(runId, { state: "dispatched" })),
      ).toHaveLength(1);

      await firstEngine.stop();
      await tool.destroy();
      journal.close();
      requestDelivery.store.close();
      workflowStore.close();

      const recoveredWorkflowStore = new WorkflowReceiptTrackingStore(workflowDbPath);
      workflowStore = recoveredWorkflowStore;
      requestDelivery = createCoreRequestDelivery({ dbPath: requestDbPath, blobStore });
      journal = new SqliteAgentRunJournal({ dbPath: requestDbPath });
      const loaded = resultValue(journal.loadRecoveryHeads());
      expect(loaded.heads).toHaveLength(1);
      expect(loaded.heads[0]).toMatchObject({
        state: "active",
        handle: { runId: child.requestDeliveryId, requestId: child.requestId },
        checkpoint: {
          messages: [{ role: "user", content: "durable workflow child checkpoint" }],
        },
      });
      const joined = joinAgentRunRecoveryHeads({
        heads: loaded.heads,
        requestDeliveryStore: requestDelivery.store,
        journal,
        logger: { warn: () => undefined },
      });
      expect([...joined.heads.keys()]).toEqual([child.requestDeliveryId]);

      pluginManager = createCoreToolPluginManager({ runtime: { config }, dataDir });
      resultValue(await pluginManager.init());
      let modelCalls = 0;
      const recoveredPrompts: string[] = [];
      let runnerPanic: Error | null = null;
      runner = await startBusAgentRunner({
        bus,
        blobStore,
        subscriptionId: "workflow-wal-recovered-runner",
        config,
        pluginManager,
        durableWorkflowStore: workflowStore,
        requestDelivery: requestDelivery.coordinator,
        agentRunJournal: journal,
        startPaused: true,
        surfaceProtocolResolver: TEST_SURFACE_PROTOCOL_RESOLVER,
        reportFatalPanic: (panic) => (runnerPanic = panic),
        issueControlCapability: () => ({ capability: "workflow-wal", principal: null }),
        createAgent: (options: AiSdkPiAgentOptions<ToolSet>) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "workflow-wal-recovery",
              doStream: async (call) => {
                modelCalls += 1;
                recoveredPrompts.push(JSON.stringify(call.prompt));
                return workflowAgentTextStep("recovered workflow child");
              },
            }),
          }),
      });
      let resumedDeliveries = 0;
      const recovery = resultValue(
        await requestDelivery.coordinator.recoverAccepted((record) => {
          resumedDeliveries += 1;
          return runner!.resumeAcceptedDelivery(record, joined.heads.get(record.requestDeliveryId));
        }),
      );
      expect(recovery).toMatchObject({ resumed: 1, terminalized: 0, failures: [] });
      expect(resumedDeliveries).toBe(1);

      runner.activate();
      await runner.waitForIdle();
      expect(runnerPanic).toBeNull();
      expect(modelCalls).toBe(1);
      expect(recoveredWorkflowStore.requestClaims).toEqual([
        { requestId: child.requestId, claimed: true },
      ]);
      expect(recoveredWorkflowStore.terminalRequests).toEqual([
        { requestId: child.requestId, recorded: true },
      ]);
      expect(
        resultValue(workflowStore.getWorkflowRequestTerminalReceipt(child.requestId)),
      ).toMatchObject({
        requestId: child.requestId,
        dispatchEpoch: child.dispatchEpoch,
        state: "resolved",
        output: "recovered workflow child",
      });
      restartedEngine = new WorkflowEngine({
        bus,
        store: workflowStore,
        blobStore,
        dataDir,
        subscriptionId: "workflow-wal-second",
        pollMs: 5,
        now: () => 60_101,
      });
      await restartedEngine.start();
      await waitFor(() => {
        const state = workflowStoreValue(workflowStore.getRun(runId))?.state;
        return state === "succeeded" || state === "failed" || state === "cancelled";
      });
      expect(workflowStoreValue(workflowStore.getRun(runId))).toMatchObject({
        state: "succeeded",
      });
      await runner.waitForIdle();

      expect(recoveredPrompts).toHaveLength(1);
      expect(recoveredPrompts[0]).toContain("durable workflow child checkpoint");
      expect(recoveredPrompts[0]).not.toContain("Inspect agent WAL restart");
      expect(workflowStoreValue(workflowStore.getRun(runId))?.result).toBe(
        "recovered workflow child",
      );
      const operations = workflowStoreValue(workflowStore.listOperations(runId));
      expect(operations.filter((operation) => operation.kind === "agent")).toMatchObject([
        { state: "succeeded", requestId: child.requestId, output: "recovered workflow child" },
      ]);
      expect(resultValue(requestDelivery.store.load(child.requestDeliveryId)).state).toBe(
        "terminal",
      );
      expect(resultValue(journal.loadRecoveryHeads()).heads).toEqual([]);
      expect(
        raw.messages.filter(
          (message) =>
            message.type === lilacEventTypes.CmdRequestMessage &&
            message.headers?.request_id === child.requestId &&
            typeof message.data === "object" &&
            message.data !== null &&
            "queue" in message.data &&
            message.data.queue === "prompt",
        ),
      ).toHaveLength(1);
    } finally {
      await restartedEngine?.stop();
      await runner?.stop();
      await pluginManager?.destroy();
      await firstEngine.stop();
      await stopResultForTest(firstRequestCapture.stop());
      await tool.destroy();
      await bus.close();
      journal.close();
      requestDelivery.store.close();
      workflowStore.close();
    }
  }, 20000);
});
