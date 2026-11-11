import { afterEach, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ToolSet } from "ai";
import { AiSdkPiAgent, type AiSdkPiAgentOptions } from "@stanley2058/lilac-agent";
import { createLilacBus, lilacEventTypes } from "@stanley2058/lilac-event-bus";
import {
  parseCoreConfigV1ToUniversal,
  parseCoreConfigV3ToUniversal,
  toDurableResolvedModelPlan,
} from "@stanley2058/lilac-utils";

import { createCoreToolPluginManager } from "../../src/plugins";
import {
  resolveAgentRunModel,
  startBusAgentRunner,
} from "../../src/surface/bridge/bus-agent-runner";
import { createOrchestrateTool } from "../../src/tools/orchestrate";
import { DurableWorkflowStore } from "../../src/workflow/durable-workflow-store";
import { WorkflowEngine } from "../../src/workflow/workflow-engine";
import { WorkflowSubagentDispatcher } from "../../src/workflow/workflow-subagent-dispatcher";
import { createInMemoryDeliveryBus } from "../helpers/in-memory-delivery-bus";
import { workflowStoreValue } from "./workflow-store-test-helpers";
import { createWorkflowTestBlobStore } from "./workflow-test-blob-store";

const blobStore = await createWorkflowTestBlobStore();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function textStep(text: string) {
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
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the subagent");
    // test-wait-justification: polls durable workflow state written by the engine's own worker loop
    await Bun.sleep(10);
  }
}

it("steers a running subagent, and sends an automatic steer that misses it as a follow-up", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-subagent-steer-"));
  roots.push(root);
  const projectRoot = path.join(root, "project");
  const dataDir = path.join(root, "data");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const store = new DurableWorkflowStore(path.join(root, "workflow.sqlite"));
  const bus = createLilacBus(createInMemoryDeliveryBus());
  const config = parseCoreConfigV1ToUniversal({});
  config.models.main = { model: "openai/subagent-steer" };
  const pluginManager = createCoreToolPluginManager({ runtime: { config }, dataDir });
  const initialized = await pluginManager.init();
  if (initialized.status === "error") throw initialized.error;

  const firstCall = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const dispatcher = await WorkflowSubagentDispatcher.create({ store, blobStore, dataDir });
  const runner = await startBusAgentRunner({
    bus,
    blobStore,
    subscriptionId: "subagent-steer-runner",
    config,
    pluginManager,
    durableWorkflowStore: store,
    workflowSubagentDispatcher: dispatcher,
    reportFatalPanic: (panic) => {
      throw panic;
    },
    issueControlCapability: () => ({ capability: "subagent-steer", principal: null }),
    createAgent: (options: AiSdkPiAgentOptions<ToolSet>) =>
      new AiSdkPiAgent({
        ...options,
        model: new MockLanguageModelV4({
          modelId: "subagent-steer",
          doStream: async ({ prompt }) => {
            prompts.push(JSON.stringify(prompt));
            if (prompts.length === 1) {
              firstCall.resolve();
              await releaseFirst.promise;
              return textStep("Looking.");
            }
            return textStep("Checked the cookies too.");
          },
        }),
      }),
  });
  const engine = new WorkflowEngine({
    bus,
    store,
    blobStore,
    dataDir,
    subscriptionId: "subagent-steer-engine",
    pollMs: 5,
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
  try {
    await engine.start();
    const handle = await dispatcher.delegate({
      mode: "deferred",
      profile: "full",
      sessionName: "audit",
      stableNamedContinuation: true,
      task: "Audit the login flow",
      idleTimeoutMs: 10_000,
      depth: 1,
      parentRequestId: "parent:1",
      parentSessionId: "channel:1",
      parentRequestClient: "discord",
      parentToolCallId: "tool:delegate",
      childRequestId: "sub:child:1",
      childSessionId: "sub:channel:1:named:audit",
      parentHeaders: { request_id: "parent:1", session_id: "channel:1", request_client: "discord" },
      childHeaders: {
        request_id: "sub:child:1",
        session_id: "sub:channel:1:named:audit",
        request_client: "unknown",
        parent_request_id: "parent:1",
        parent_tool_call_id: "tool:delegate",
        subagent_profile: "full",
        subagent_depth: "1",
      },
      initialMessages: [{ role: "user", content: "Audit the login flow" }],
      projectRoot,
      fallbackSurface: { platform: "discord", userId: "user-1", sessionId: "channel:1" },
    });
    await firstCall.promise;

    const tool = createOrchestrateTool({
      config: parseCoreConfigV3ToUniversal({ configVersion: 3 }),
      cwd: projectRoot,
      runProfile: "primary",
      canControl: true,
      idleTimeoutMs: 10_000,
      maxDepth: 1,
      workflows: store,
      bus,
      liveSubagents: () => runner,
      requestContext: {
        requestId: "parent:1",
        sessionId: "channel:1",
        requestClient: "discord",
        subagentDepth: 0,
        subagentProfile: "primary",
      },
    });
    const sent = (await tool.execute!(
      { action: "send", id: handle.runId, message: "Also check the session cookies" } as never,
      { toolCallId: "tool:steer", messages: [] } as never,
    )) as { disposition: string };
    expect(sent.disposition).toBe("steered");

    releaseFirst.resolve();
    await waitFor(() => workflowStoreValue(store.getRun(handle.runId))?.state === "succeeded");
    expect(prompts.at(-1)).toContain("Also check the session cookies");
    expect(workflowStoreValue(store.getRun(handle.runId))?.result).toContain(
      "Checked the cookies too.",
    );

    // A steer that reaches the child after its run ended continues as a follow-up.
    const ended = workflowStoreValue(store.listOperations(handle.runId)).find(
      (operation) => operation.kind === "agent",
    );
    await bus.publish(
      lilacEventTypes.CmdRequestMessage,
      {
        requestDeliveryId: crypto.randomUUID(),
        queue: "steer",
        messages: [{ role: "user", content: "And the logout flow" }],
        raw: {
          requiresActive: true,
          autoFollowUp: { parentRequestId: "parent:2", parentToolCallId: "tool:late-steer" },
          subagent: { profile: "full", depth: 1 },
        },
      },
      {
        headers: {
          request_id: ended!.requestId!,
          session_id: "sub:channel:1:named:audit",
          request_client: "unknown",
        },
      },
    );
    const followUp = () =>
      workflowStoreValue(store.listSubagentRuns("channel:1")).find(
        (run) => run.runId !== handle.runId,
      );
    await waitFor(() => followUp()?.state === "succeeded");
    expect(followUp()?.completionTarget).toMatchObject({
      kind: "live_parent",
      parentRequestId: "parent:2",
      parentToolCallId: "tool:late-steer",
      childSessionId: "sub:channel:1:named:audit",
      sessionName: "audit",
    });
    expect(prompts.at(-1)).toContain("And the logout flow");
  } finally {
    releaseFirst.resolve();
    await engine.stop();
    await runner.stop();
    await pluginManager.destroy();
    await bus.close();
    store.close();
  }
}, 20_000);
