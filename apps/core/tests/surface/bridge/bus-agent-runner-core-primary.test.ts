import { executeAiSdkModelCall } from "@stanley2058/lilac-agent/adapters/ai-sdk/model-call";
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  lilacEventTypes,
  type CmdRequestMessageData,
  type CorePrimaryLineageV2,
} from "@stanley2058/lilac-event-bus";
import { ModelCapability, parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Result } from "better-result";
import { AiSdkPiAgent, attachAutoCompaction } from "@stanley2058/lilac-agent";
import {
  ClaudeCodeRunExternalFailure,
  materializeClaudeCodeRunResult,
  type ClaudeNativeAttemptObservation,
  type ClaudeNativeSessionStart,
  type MaterializedClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";
import {
  degradeCorePrimaryLineageForMutation,
  resolveCoreClaudeCompactionSummaryModel,
  mapCorePrimaryCompactionCurrentCanonicalStart,
} from "../../../src/surface/bridge/bus-agent-runner";
import { resolveCorePrimaryLoadedCatalogIds } from "../../../src/surface/bridge/bus-agent-runner/lineage-tool-authority";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { projectStoredMessagesV1 } from "../../../src/transcript/stored-message-materialization";
import { hashCanonicalStoredMessagesV2 } from "../../../src/transcript/transcript-persistence-codec";
import {
  adaptDiscordRequestRouterStartOutcomeToHost,
  startDiscordRequestRouter,
} from "../../../src/surface/discord/discord-request-router";
import { DiscordRequestDeliveryFailed } from "../../../src/surface/discord/discord-request-router/publish";
import { bridgeAdapterToBus } from "../../../src/surface/bridge/publish-to-bus";
import { bridgeBusToAdapter } from "../../../src/surface/bridge/subscribe-from-bus";
import { createDiscordRelayPolicy } from "../../../src/surface/discord/discord-runtime-descriptor";
import { getTestBlobStore } from "../../helpers/blob-store";
import { createTestResourceRegistry } from "../../helpers/resource-registry";
import type { MsgRef } from "../../../src/surface/types";
import {
  createCorePrimaryClaudeRuntime,
  startBusAgentRunner,
  transcriptResultValue,
  computeCorePrimaryClaudeTerminalHead,
  attemptMutationValue,
  getPrimaryBinding,
  promotePrimaryBinding,
  buildCoreLineageManifestV2,
  getRequestTranscript,
  getCorePrimaryLineageManifest,
  getTranscriptBySurfaceMessage,
  level1TestToolset,
  level1TextStep,
  level1ToolCallStep,
  level1OfferedToolNames,
  autoInjectPlanForQuery,
  createInMemoryRawBus,
  deferred,
  ProductionPathDiscordAdapter,
  observeRequestLifecycle,
  observeResponseAfterOutputRelay,
  publishRunnerRequest,
  corePrimaryTestPluginManager,
  admitPrimarySurface,
  extendPrimaryManifest,
} from "./bus-agent-runner-test-support";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

describe("startBusAgentRunner prefix-lineage tool authority", () => {
  it("keeps loaded tools on descendants and excludes them from earlier forks and new threads", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-tool-lineage-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    pluginManager.buildLevel1ToolsetResult = async (input) =>
      Result.ok(
        level1TestToolset({
          searchExecute: () => {
            input.onSelectCatalogIds?.(["catalog-id"]);
            return "selected";
          },
        }),
      );
    const offered: string[][] = [];
    let modelCall = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "prefix-lineage-tool-authority",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "test", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "prefix-lineage-tool-authority",
            doStream: async (modelOptions) => {
              offered.push(level1OfferedToolNames(modelOptions));
              modelCall += 1;
              return modelCall === 1
                ? level1ToolCallStep([{ toolCallId: "search", toolName: "find_tools" }])
                : level1TextStep(`done-${modelCall}`);
            },
          }),
        }),
    });

    const sessionId = "tool-lineage-channel";
    const firstRequestId = "discord:tool-lineage:first";
    const firstMessages = [{ role: "user", content: "load a tool" }] satisfies ModelMessage[];
    const firstManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input-first", firstMessages),
    ]);
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    await publishRunnerRequest({
      bus,
      requestId: firstRequestId,
      sessionId,
      requestClient: "discord",
      text: "load a tool",
      corePrimaryLineage: firstManifest,
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    await firstLifecycle.stop();

    const secondRequestId = "discord:tool-lineage:second";
    const secondMessages = [{ role: "user", content: "continue" }] satisfies ModelMessage[];
    const secondManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: firstManifest,
      completedRequestId: firstRequestId,
      outputMessageId: "output-first",
      currentMessageId: "input-second",
      currentMessages: secondMessages,
    });
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    await publishRunnerRequest({
      bus,
      requestId: secondRequestId,
      sessionId,
      requestClient: "discord",
      text: "continue",
      messages: secondManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: secondManifest,
    });
    await expect(secondLifecycle.terminal).resolves.toBe("resolved");
    await secondLifecycle.stop();

    const forkAfterRequestId = "discord:tool-lineage:fork-after";
    const forkAfterMessages = [
      { role: "user", content: "fork after load" },
    ] satisfies ModelMessage[];
    const forkAfterManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: firstManifest,
      completedRequestId: firstRequestId,
      outputMessageId: "output-first-fork",
      currentMessageId: "input-fork-after",
      currentMessages: forkAfterMessages,
    });
    const forkAfterLifecycle = await observeRequestLifecycle(bus, forkAfterRequestId);
    await publishRunnerRequest({
      bus,
      requestId: forkAfterRequestId,
      sessionId,
      requestClient: "discord",
      text: "fork after load",
      messages: forkAfterManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: forkAfterManifest,
    });
    await expect(forkAfterLifecycle.terminal).resolves.toBe("resolved");
    await forkAfterLifecycle.stop();

    const thirdRequestId = "discord:tool-lineage:third";
    const thirdMessages = [{ role: "user", content: "continue again" }] satisfies ModelMessage[];
    const thirdManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-second",
      currentMessageId: "input-third",
      currentMessages: thirdMessages,
    });
    const thirdLifecycle = await observeRequestLifecycle(bus, thirdRequestId);
    await publishRunnerRequest({
      bus,
      requestId: thirdRequestId,
      sessionId,
      requestClient: "discord",
      text: "continue again",
      messages: thirdManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: thirdManifest,
    });
    await expect(thirdLifecycle.terminal).resolves.toBe("resolved");
    await thirdLifecycle.stop();

    const forkFromSecondRequestId = "discord:tool-lineage:fork-from-second";
    const forkFromSecondMessages = [
      { role: "user", content: "fork from second response" },
    ] satisfies ModelMessage[];
    const forkFromSecondManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-second-fork",
      currentMessageId: "input-fork-from-second",
      currentMessages: forkFromSecondMessages,
    });
    const forkFromSecondLifecycle = await observeRequestLifecycle(bus, forkFromSecondRequestId);
    await publishRunnerRequest({
      bus,
      requestId: forkFromSecondRequestId,
      sessionId,
      requestClient: "discord",
      text: "fork from second response",
      messages: forkFromSecondManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: forkFromSecondManifest,
    });
    await expect(forkFromSecondLifecycle.terminal).resolves.toBe("resolved");
    await forkFromSecondLifecycle.stop();

    const forkRequestId = "discord:tool-lineage:fork-before";
    const forkMessages = [{ role: "user", content: "fork before load" }] satisfies ModelMessage[];
    const forkManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input-fork", forkMessages),
    ]);
    const forkLifecycle = await observeRequestLifecycle(bus, forkRequestId);
    await publishRunnerRequest({
      bus,
      requestId: forkRequestId,
      sessionId,
      requestClient: "discord",
      text: "fork before load",
      corePrimaryLineage: forkManifest,
    });
    await expect(forkLifecycle.terminal).resolves.toBe("resolved");
    await forkLifecycle.stop();

    const freshSessionId = "tool-lineage-new-thread";
    const freshRequestId = "discord:tool-lineage:fresh";
    const freshMessages = [{ role: "user", content: "new thread" }] satisfies ModelMessage[];
    const freshManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, freshSessionId, "input-fresh", freshMessages),
    ]);
    const freshLifecycle = await observeRequestLifecycle(bus, freshRequestId);
    await publishRunnerRequest({
      bus,
      requestId: freshRequestId,
      sessionId: freshSessionId,
      requestClient: "discord",
      text: "new thread",
      corePrimaryLineage: freshManifest,
    });
    await expect(freshLifecycle.terminal).resolves.toBe("resolved");
    await freshLifecycle.stop();

    expect(offered).toEqual([
      ["builtin", "find_tools"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools", "deferred_tool"],
      ["builtin", "find_tools"],
      ["builtin", "find_tools"],
    ]);
    expect(getRequestTranscript(store, { requestId: firstRequestId })?.loadedCatalogIds).toEqual([
      "catalog-id",
    ]);
    expect(getRequestTranscript(store, { requestId: secondRequestId })?.loadedCatalogIds).toEqual([
      "catalog-id",
    ]);
    expect(
      getRequestTranscript(store, { requestId: forkAfterRequestId })?.loadedCatalogIds,
    ).toEqual(["catalog-id"]);
    expect(getRequestTranscript(store, { requestId: thirdRequestId })?.loadedCatalogIds).toEqual([
      "catalog-id",
    ]);
    expect(
      getRequestTranscript(store, { requestId: forkFromSecondRequestId })?.loadedCatalogIds,
    ).toEqual(["catalog-id"]);
    expect(getRequestTranscript(store, { requestId: forkRequestId })?.loadedCatalogIds).toEqual([]);
    expect(getRequestTranscript(store, { requestId: freshRequestId })?.loadedCatalogIds).toEqual(
      [],
    );

    await runner.stop();
    await pluginManager.destroy();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("carries loaded tools through a real compaction checkpoint into its descendant", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-tool-compaction-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    pluginManager.buildLevel1ToolsetResult = async () => Result.ok(level1TestToolset());
    const config = parseCoreConfigV2ToUniversal({
      models: {
        main: { model: "openrouter/openai/gpt-4o" },
        fast: { model: "openrouter/openai/gpt-4o" },
        def: {},
        capability: {
          forceUnknownProviders: ["openrouter"],
          overrides: {
            "openrouter/openai/gpt-4o": {
              limit: { context: 4_000, output: 1_000 },
            },
          },
        },
      },
    });
    const modelCalls: Array<{ prompt: string; tools: string[] }> = [];
    const model = new MockLanguageModelV4({
      modelId: "tool-authority-compaction",
      doStream: async (modelOptions) => {
        const tools = level1OfferedToolNames(modelOptions);
        modelCalls.push({ prompt: JSON.stringify(modelOptions.prompt), tools });
        return tools.length === 0
          ? level1TextStep("## Objective\n- Preserve the loaded tool authority.")
          : level1TextStep("compacted response");
      },
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "prefix-lineage-tool-compaction",
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      transcriptStore: store,
      issueControlCapability: () => ({ capability: "tool-compaction", principal: null }),
      createAgent: (options) => new AiSdkPiAgent({ ...options, model }),
    });

    const sessionId = "tool-compaction-channel";
    const seedRequestId = "discord:tool-compaction:seed";
    const historicalMessages = Array.from({ length: 120 }, (_, index) =>
      index % 2 === 0
        ? ({ role: "user", content: `historical question ${index} ${"x".repeat(10_000)}` } as const)
        : ({ role: "assistant", content: `historical answer ${index}` } as const),
    ) satisfies ModelMessage[];
    const seedLineage = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "seed-input", historicalMessages),
    ]);
    transcriptResultValue(
      store.saveRequestTranscript({
        requestId: seedRequestId,
        sessionId,
        requestClient: "discord",
        messages: [{ role: "assistant", content: "seed response" }],
        providerState: {
          lastFamily: "ai-sdk",
          containsCrossFamilyTurns: false,
        },
        loadedCatalogIds: ["catalog-id"],
        corePrimaryLineage: seedLineage,
      }),
    );

    const compactingRequestId = "discord:tool-compaction:compacting";
    const compactingMessages = [
      { role: "user", content: "compact this prefix" },
    ] satisfies ModelMessage[];
    const compactingLineage = extendPrimaryManifest({
      store,
      sessionId,
      previous: seedLineage,
      completedRequestId: seedRequestId,
      outputMessageId: "seed-output",
      currentMessageId: "compacting-input",
      currentMessages: compactingMessages,
    });
    const compactingLifecycle = await observeRequestLifecycle(bus, compactingRequestId);

    try {
      await publishRunnerRequest({
        bus,
        requestId: compactingRequestId,
        sessionId,
        requestClient: "discord",
        text: "compact this prefix",
        messages: compactingLineage.segments.flatMap((segment) => segment.canonicalMessages),
        corePrimaryLineage: compactingLineage,
      });
      const compactingTerminal = await compactingLifecycle.terminal;
      if (compactingTerminal !== "resolved") {
        throw new Error(
          `compaction request ${compactingTerminal}: ${compactingLifecycle.details.join(" | ")}`,
        );
      }
      await compactingLifecycle.stop();

      const checkpoint = getRequestTranscript(store, { requestId: compactingRequestId });
      expect(checkpoint?.contextMeta).toEqual({ type: "compaction", formatVersion: 1 });
      expect(checkpoint?.loadedCatalogIds).toEqual(["catalog-id"]);
      if (!checkpoint?.transcriptDigest) throw new Error("compaction checkpoint missing");
      store.linkSurfaceMessagesToRequest({
        requestId: compactingRequestId,
        created: [
          {
            platform: "discord",
            channelId: sessionId,
            messageId: "compacting-output",
          },
        ],
        last: {
          platform: "discord",
          channelId: sessionId,
          messageId: "compacting-output",
        },
      });

      const descendantMessages = [
        { role: "user", content: "continue after compaction" },
      ] satisfies ModelMessage[];
      const descendantLineage = buildCoreLineageManifestV2([
        {
          atoms: [
            {
              kind: "checkpoint",
              requestId: compactingRequestId,
              transcriptDigest: checkpoint.transcriptDigest,
            },
          ],
          canonicalMessages: checkpoint.messages,
        },
        admitPrimarySurface(store, sessionId, "post-compaction-input", descendantMessages),
      ]);
      const descendantRequestId = "discord:tool-compaction:descendant";
      expect(
        transcriptResultValue(
          store.validateCorePrimaryLineageReferences({
            manifest: descendantLineage,
            requestClient: "discord",
            sessionId,
            surfaceId: `discord:${sessionId}`,
          }),
        ),
      ).toBeNull();
      expect(
        resolveCorePrimaryLoadedCatalogIds({ lineage: descendantLineage, transcriptStore: store }),
      ).toEqual(["catalog-id"]);
      const descendantLifecycle = await observeRequestLifecycle(bus, descendantRequestId);
      await publishRunnerRequest({
        bus,
        requestId: descendantRequestId,
        sessionId,
        requestClient: "discord",
        text: "continue after compaction",
        messages: descendantLineage.segments.flatMap((segment) => segment.canonicalMessages),
        corePrimaryLineage: descendantLineage,
      });
      await expect(descendantLifecycle.terminal).resolves.toBe("resolved");
      await descendantLifecycle.stop();

      expect(modelCalls.filter((call) => call.tools.length > 0).map((call) => call.tools)).toEqual([
        ["builtin", "find_tools", "deferred_tool"],
        ["builtin", "find_tools", "deferred_tool"],
      ]);
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("startBusAgentRunner Core-primary Claude production path", () => {
  it("promotes an auto-injected first turn and forks the exact linked reply with suffix-only input", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "claude-code/sonnet" };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    config.conversation.thread.autoInject = {
      ...config.conversation.thread.autoInject,
      enabled: true,
      minTextUnits: 20,
      followUpMinTextUnits: 20,
      limit: 1,
      minScore: 0.1,
      expansionMinConfidence: 0.57,
      mode: "hybrid",
      filterCurrentParticipants: false,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-auto-inject-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const adapter = new ProductionPathDiscordAdapter();
    const sessionId = "primary-auto-inject-session";
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][] = [];
    let plannedSearches = 0;
    const routedRequests: Array<{
      readonly headers?: Readonly<Record<string, string>>;
      readonly data: CmdRequestMessageData;
    }> = [];
    const routedSubResult = await bus.subscribeTopic(
      "cmd.request",
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (message.type === lilacEventTypes.CmdRequestMessage) {
          routedRequests.push(message);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (routedSubResult.status === "error") throw routedSubResult.error;
    const routedSub = routedSubResult.value;
    const outputCreated = deferred<MsgRef>();
    const outputCreatedSubResult = await bus.subscribeTopic(
      "evt.surface",
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (
          message.type === lilacEventTypes.EvtSurfaceOutputMessageCreated &&
          message.headers?.request_id === `discord:${sessionId}:input-1`
        ) {
          const msgRef = message.data.msgRef;
          if (msgRef.platform === "discord") {
            outputCreated.resolve({
              platform: "discord",
              channelId: msgRef.channelId,
              messageId: msgRef.messageId,
            });
          }
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (outputCreatedSubResult.status === "error") throw outputCreatedSubResult.error;
    const outputCreatedSub = outputCreatedSubResult.value;
    const routedOutputUpdates: string[] = [];
    const outputUpdatedSubResult = await bus.subscribeTopic(
      "evt.adapter",
      { mode: "tail", offset: { type: "now" } },
      async (message) => {
        if (
          message.type === lilacEventTypes.EvtAdapterMessageUpdated &&
          message.data.platform === "discord"
        ) {
          routedOutputUpdates.push(message.data.messageId);
        }
        return Result.ok(undefined);
      },
      () => "dead-letter",
    );
    if (outputUpdatedSubResult.status === "error") throw outputUpdatedSubResult.error;
    const outputUpdatedSub = outputUpdatedSubResult.value;
    const adapterIngress = await bridgeAdapterToBus({
      eventSource: adapter,
      platform: "discord",
      bus,
      subscriptionId: "production-primary-auto-inject-ingress",
      transcriptStore: store,
    });
    const requestBlobStore = await getTestBlobStore();
    const router = adaptDiscordRequestRouterStartOutcomeToHost(
      await startDiscordRequestRouter({
        adapter,
        bus,
        blobStore: requestBlobStore,
        resourceRegistry: createTestResourceRegistry(),
        requestDelivery: {
          async prepareAndPublish({ envelope }) {
            return (
              await bus.publish(lilacEventTypes.CmdRequestMessage, envelope.data, {
                headers: envelope.headers,
              })
            )
              .map(() => undefined)
              .mapError(
                (cause) =>
                  new DiscordRequestDeliveryFailed({
                    cause,
                    message: "Test request publication failed",
                  }),
              );
          },
        },
        subscriptionId: "production-primary-auto-inject-router",
        config,
        transcriptStore: store,
        routerGate: async () => ({
          forward: true,
          reason: "deterministic integration route",
        }),
      }),
      () => {},
      () => {},
    );
    const outputRelay = await bridgeBusToAdapter({
      adapter,
      blobStore: requestBlobStore,
      bus,
      platform: "discord",
      policy: createDiscordRelayPolicy(adapter),
      subscriptionId: "production-primary-auto-inject-relay",
      transcriptStore: store,
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-auto-inject",
      reportFatalPanic: () => undefined,
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      conversationThreads: {
        planAutoInjectSearch: async () => {
          plannedSearches += 1;
          return autoInjectPlanForQuery("native continuation", "Find continuation context.");
        },
        search: async () => ({
          meta: {
            query: "native continuation",
            limit: 1,
            mode: "hybrid",
            minScore: 0.1,
            count: 1,
            vectorAvailable: false,
          },
          results: [
            {
              surface: "discord" as const,
              threadId: "related-thread",
              title: "Relevant native continuation context",
              brief: "A deterministic auto-injected result.",
              score: 0.9,
            },
          ],
        }),
        metadata: async () => {
          throw new Error("not used");
        },
        read: async () => {
          throw new Error("not used");
        },
        runSummarization: async () => {
          throw new Error("not used");
        },
      },
      materializeClaudeCodeRun: async (options) => {
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral")
          throw new Error("expected persistent Claude start");
        const runIndex = starts.length;
        starts.push(start);
        const observation = (): ClaudeNativeAttemptObservation => ({
          requestedSessionId: start.sessionId,
          sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
          initSessionId: start.sessionId,
          resultSessionId: start.sessionId,
          contextTokens: 100 + runIndex,
          contextMaxTokens: 4_000,
          requestedModel: options.modelId,
          initializedModel: options.modelId,
          requestedReasoning: options.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        });
        const model = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async (call) => {
            modelPrompts.push([...call.prompt]);
            return level1TextStep(`auto-inject response ${runIndex + 1}`);
          },
        });
        return {
          agentModel: model,
          executeCall: executeAiSdkModelCall,
          continuationModel: model,
          createUtilityModelResult: () => Result.ok(model),
          createUtilityModel: () => model,
          control: {
            inject: () => false,
            interrupt: async () => false,
            async interruptResult() {
              return Result.ok(await this.interrupt());
            },
            clear: () => {},
            clearResult() {
              this.clear();
              return Result.ok();
            },
          },
          nativeSession: {
            getObservation: observation,
            waitForObservation: async () => observation(),
            recordWarning: () => {},
            finalize: async () => ({
              status: "promotable" as const,
              issues: [] as const,
              observations: observation(),
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1_000 + runIndex,
              },
              sourcePreflight:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
              sourceFinal:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
            }),
            async finalizeResult() {
              return Result.ok(await this.finalize());
            },
          },
          dispose: async () => {},
          disposeResult: async () => Result.ok(),
        };
      },
    });

    const firstRequestId = `discord:${sessionId}:input-1`;
    const firstText = Array.from({ length: 40 }, (_, index) => `detail-${index}`).join(" ");
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    const firstRelayedResponse = await observeResponseAfterOutputRelay(bus, firstRequestId);
    await adapter.emitCreated({
      ref: { platform: "discord", channelId: sessionId, messageId: "input-1" },
      session: { platform: "discord", channelId: sessionId },
      userId: "user-1",
      userName: "User One",
      text: `<@bot> ${firstText}`,
      ts: 1_000,
      raw: {
        reference: {},
        discord: {
          isChat: true,
          isDMBased: false,
          mentionsBot: true,
          replyToBot: false,
          botUserId: "bot",
        },
      },
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    await firstRelayedResponse.relayed;
    expect(await outputCreated.promise).toEqual({
      platform: "discord",
      channelId: sessionId,
      messageId: "output-1",
    });

    const firstRouted = routedRequests.find(
      (request) => request.headers?.request_id === firstRequestId,
    );
    if (!firstRouted || firstRouted.data.corePrimaryLineage?.state !== "complete") {
      throw new Error("first request did not route with complete Stage 6 lineage");
    }
    const firstInputManifest = firstRouted.data.corePrimaryLineage;
    const persistedFirstManifest = getCorePrimaryLineageManifest(store, {
      requestId: firstRequestId,
    });
    if (!persistedFirstManifest) throw new Error("auto-injected manifest was not persisted");
    expect(persistedFirstManifest.currentCanonicalStart).toBe(
      firstInputManifest.currentCanonicalStart,
    );
    expect(firstInputManifest.segments).toEqual(persistedFirstManifest.segments.slice(0, -1));
    expect(persistedFirstManifest.segments.at(-1)?.atoms).toEqual([
      expect.objectContaining({
        kind: "synthetic",
        source: "conversation-thread-auto-inject",
      }),
    ]);
    expect(
      persistedFirstManifest.segments.at(-1)?.canonicalMessages.map((message) => message.role),
    ).toEqual(["user"]);
    const firstOutput = adapter.outputs[0];
    if (!firstOutput) throw new Error("first output stream was not created");
    expect(
      firstOutput.parts
        .filter((part) => part.type === "tool.status")
        .map((part) => part.update.status),
    ).toEqual(["start", "end"]);
    expect(firstOutput.parts[0]).toMatchObject({
      type: "tool.status",
      update: {
        status: "start",
        display: "conversation_thread_search auto-injected metadata",
      },
    });
    expect(
      adapter.updatedOutputMessageIds.filter((id) => id === firstOutput.messageId).length,
    ).toBe(firstOutput.parts.length);
    expect(routedOutputUpdates.filter((id) => id === firstOutput.messageId).length).toBe(
      firstOutput.parts.length,
    );
    expect(adapter.messages.get(firstOutput.messageId)?.text).toBe("auto-inject response 1");
    expect(
      getTranscriptBySurfaceMessage(store, {
        platform: "discord",
        channelId: sessionId,
        messageId: firstOutput.messageId,
      })?.requestId,
    ).toBe(firstRequestId);
    const firstBinding = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    const firstTranscript = getRequestTranscript(store, {
      requestId: firstRequestId,
    });
    if (!firstBinding || !firstTranscript?.transcriptDigest || !firstTranscript.providerState) {
      throw new Error("auto-injected first turn did not promote");
    }
    expect(firstBinding).toMatchObject(
      computeCorePrimaryClaudeTerminalHead({
        manifest: persistedFirstManifest,
        requestId: firstRequestId,
        transcriptDigest: firstTranscript.transcriptDigest,
        responseMessageCount: firstTranscript.messages.length,
        providerState: firstTranscript.providerState,
      }),
    );

    const secondRequestId = `discord:${sessionId}:input-2`;
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    const secondRelayedResponse = await observeResponseAfterOutputRelay(bus, secondRequestId);
    await adapter.emitCreated({
      ref: { platform: "discord", channelId: sessionId, messageId: "input-2" },
      session: { platform: "discord", channelId: sessionId },
      userId: "user-1",
      userName: "User One",
      text: "next",
      ts: 20_000,
      raw: {
        reference: { messageId: firstOutput.messageId, channelId: sessionId },
        discord: {
          isChat: true,
          isDMBased: false,
          mentionsBot: false,
          replyToBot: true,
          botUserId: "bot",
        },
      },
    });
    await expect(secondLifecycle.terminal).resolves.toBe("resolved");
    await secondRelayedResponse.relayed;

    const secondRouted = routedRequests.find(
      (request) => request.headers?.request_id === secondRequestId,
    );
    if (!secondRouted || secondRouted.data.corePrimaryLineage?.state !== "complete") {
      throw new Error("second request did not route with complete Stage 6 lineage");
    }
    const secondManifest = secondRouted.data.corePrimaryLineage;
    expect(secondManifest.segments.map((segment) => segment.atoms[0]?.kind)).toEqual([
      "surface",
      "synthetic",
      "request",
      "surface",
    ]);
    expect(secondManifest.segments[2]?.requestSource?.aliases).toEqual([
      {
        requestClient: "discord",
        surfaceId: `discord:${sessionId}`,
        sessionId,
        messageId: firstOutput.messageId,
      },
    ]);
    expect(secondManifest.segments[1]?.canonicalMessages).toEqual(
      persistedFirstManifest.segments.at(-1)?.canonicalMessages,
    );
    const secondCurrentSegment = secondManifest.segments.at(-1);
    if (!secondCurrentSegment) throw new Error("second current segment is missing");
    expect(secondManifest.currentCanonicalStart).toBe(secondCurrentSegment.canonicalStart);

    expect(plannedSearches).toBe(1);
    expect(starts[0]).toMatchObject({
      mode: "fresh",
      sessionId: firstBinding.claudeSessionId,
    });
    expect(starts[1]).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
    });
    expect(modelPrompts).toHaveLength(2);
    expect(JSON.stringify(modelPrompts[0])).toContain("related-thread");
    expect(JSON.stringify(modelPrompts[1])).toContain("next");
    expect(JSON.stringify(modelPrompts[1])).not.toContain("detail-0");
    expect(JSON.stringify(modelPrompts[1])).not.toContain("related-thread");
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      })?.revision,
    ).toBe(2);

    await Promise.all([
      firstLifecycle.stop(),
      secondLifecycle.stop(),
      firstRelayedResponse.stop(),
      secondRelayedResponse.stop(),
    ]);
    await runner.stop();
    await outputRelay.stop();
    await router.stop();
    await adapterIngress.stop();
    const routedStopped = await routedSub.stop();
    if (routedStopped.status === "error") throw routedStopped.error;
    const outputCreatedStopped = await outputCreatedSub.stop();
    if (outputCreatedStopped.status === "error") throw outputCreatedStopped.error;
    const outputUpdatedStopped = await outputUpdatedSub.stop();
    if (outputUpdatedStopped.status === "error") throw outputUpdatedStopped.error;
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("promotes fresh and exact-fork tool-loop turns, then fences cancellation and CAS loss", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = {
      model: "claude-code/sonnet",
      fallback: ["openai/must-not-run"],
    };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-claude-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const sessionId = "primary-claude-session";
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][][] = [];
    const finalizationStarted = [deferred<void>(), deferred<void>()];
    const releaseFinalization = [deferred<void>(), deferred<void>()];
    const switchedModels: Array<string | undefined> = [];
    const materialize = async (
      options: Parameters<typeof materializeClaudeCodeRunResult>[0],
    ): Promise<MaterializedClaudeCodeRun> => {
      const start = options.nativeSession;
      if (!start || start.mode === "ephemeral") throw new Error("expected persistent Claude start");
      const runIndex = starts.length;
      starts.push(start);
      modelPrompts.push([]);
      let modelCalls = 0;
      let contextTokens = 100 + runIndex * 100;
      const observation = (): ClaudeNativeAttemptObservation => ({
        requestedSessionId: start.sessionId,
        sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
        initSessionId: start.sessionId,
        resultSessionId: start.sessionId,
        contextTokens,
        contextMaxTokens: 4_000,
        requestedModel: options.modelId,
        initializedModel: options.modelId,
        requestedReasoning: options.reasoning ?? null,
        providerWarnings: [],
        invoked: true,
        requiredObservabilityError: null,
        callbackError: null,
      });
      const model = new MockLanguageModelV4({
        modelId: options.modelId,
        doStream: async (call) => {
          modelPrompts[runIndex]!.push([...call.prompt]);
          modelCalls += 1;
          if (runIndex === 1 && modelCalls === 1) {
            return level1ToolCallStep([{ toolCallId: "native-tool", toolName: "builtin" }]);
          }
          return level1TextStep(`native response ${runIndex + 1}`);
        },
      });
      return {
        agentModel: model,
        executeCall: executeAiSdkModelCall,
        continuationModel: model,
        createUtilityModelResult: () => Result.ok(model),
        createUtilityModel: () => model,
        control: {
          inject: () => false,
          interrupt: async () => false,
          async interruptResult() {
            return Result.ok(await this.interrupt());
          },
          clear: () => {},
          clearResult() {
            this.clear();
            return Result.ok();
          },
        },
        nativeSession: {
          getObservation: observation,
          waitForObservation: async () => {
            contextTokens += 25;
            return observation();
          },
          recordWarning: () => {},
          finalize: async () => {
            if (runIndex === 2 || runIndex === 3) {
              const gateIndex = runIndex - 2;
              finalizationStarted[gateIndex]!.resolve(undefined);
              await releaseFinalization[gateIndex]!.promise;
            }
            return {
              status: "promotable" as const,
              issues: [] as const,
              observations: observation(),
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1_000 + runIndex,
              },
              sourcePreflight:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
              sourceFinal:
                start.mode === "fork"
                  ? {
                      sessionId: start.baseSessionId,
                      cwd: options.cwd,
                      lastModified: start.expectedSourceLastModified,
                    }
                  : null,
            };
          },
          async finalizeResult() {
            return Result.ok(await this.finalize());
          },
        },
        dispose: async () => {},
        disposeResult: async () => Result.ok(),
      };
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-claude",
      reportFatalPanic: () => undefined,
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      materializeClaudeCodeRun: materialize,
      createAgent: (options) => {
        const agent = new AiSdkPiAgent(options);
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (model, providerOptions, modelSpecifier, reasoning) => {
          switchedModels.push(modelSpecifier);
          setModel(model, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });

    const firstRequestId = "discord:primary-claude-session:input-1";
    const firstMessages = [{ role: "user", content: "first current" }] satisfies ModelMessage[];
    const firstManifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input-1", firstMessages),
    ]);
    const firstLifecycle = await observeRequestLifecycle(bus, firstRequestId);
    await publishRunnerRequest({
      bus,
      requestId: firstRequestId,
      sessionId,
      requestClient: "discord",
      text: "first current",
      corePrimaryLineage: firstManifest,
    });
    await expect(firstLifecycle.terminal).resolves.toBe("resolved");
    const firstBinding = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!firstBinding) throw new Error("first binding was not promoted");
    const firstTranscript = getRequestTranscript(store, {
      requestId: firstRequestId,
    });
    if (!firstTranscript?.transcriptDigest) throw new Error("first transcript digest is missing");
    const firstHead = computeCorePrimaryClaudeTerminalHead({
      manifest: firstManifest,
      requestId: firstRequestId,
      transcriptDigest: firstTranscript.transcriptDigest,
      responseMessageCount: firstTranscript.messages.length,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
    });
    expect(starts[0]).toMatchObject({
      mode: "fresh",
      sessionId: firstBinding.claudeSessionId,
    });
    expect(firstBinding).toMatchObject(firstHead);

    const secondRequestId = "discord:primary-claude-session:input-2";
    const secondMessages = [{ role: "user", content: "second current" }] satisfies ModelMessage[];
    const secondManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: firstManifest,
      completedRequestId: firstRequestId,
      outputMessageId: "output-1",
      currentMessageId: "input-2",
      currentMessages: secondMessages,
    });
    const secondLifecycle = await observeRequestLifecycle(bus, secondRequestId);
    await publishRunnerRequest({
      bus,
      requestId: secondRequestId,
      sessionId,
      requestClient: "discord",
      text: "second current",
      messages: secondManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: secondManifest,
    });
    expect({
      terminal: await secondLifecycle.terminal,
      details: secondLifecycle.details,
    }).toEqual({
      terminal: "resolved",
      details: [undefined, undefined],
    });
    const secondBinding = getPrimaryBinding(store, {
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
    });
    if (!secondBinding) throw new Error("second binding was not promoted");
    const secondTranscript = getRequestTranscript(store, {
      requestId: secondRequestId,
    });
    if (!secondTranscript?.transcriptDigest) throw new Error("second transcript digest is missing");
    const secondHead = computeCorePrimaryClaudeTerminalHead({
      manifest: secondManifest,
      requestId: secondRequestId,
      transcriptDigest: secondTranscript.transcriptDigest,
      responseMessageCount: secondTranscript.messages.length,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
    });
    expect(starts[1]).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
      sessionId: secondBinding.claudeSessionId,
    });
    expect(modelPrompts[1]).toHaveLength(2);
    expect(JSON.stringify(modelPrompts[1]?.[0])).not.toContain("first current");
    expect(JSON.stringify(modelPrompts[1]?.[0])).toContain("second current");
    expect(JSON.stringify(modelPrompts[1]?.[1])).toContain(
      "Continue after the completed tool call.",
    );
    expect(
      JSON.stringify(getRequestTranscript(store, { requestId: secondRequestId })?.messages),
    ).toContain("native-tool");
    expect(secondBinding.canonicalMessageCount).toBe(
      secondManifest.segments.at(-1)!.canonicalEnd +
        getRequestTranscript(store, { requestId: secondRequestId })!.messages.length,
    );
    expect(secondBinding).toMatchObject(secondHead);
    expect(secondBinding.nativeContextTokens).toBeGreaterThan(firstBinding.nativeContextTokens);

    const cancellationRequestId = "discord:primary-claude-session:input-cancel";
    const cancellationMessages = [
      { role: "user", content: "cancel during finalize" },
    ] satisfies ModelMessage[];
    const cancellationManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-2",
      currentMessageId: "input-cancel",
      currentMessages: cancellationMessages,
    });
    const cancellationLifecycle = await observeRequestLifecycle(bus, cancellationRequestId);
    await publishRunnerRequest({
      bus,
      requestId: cancellationRequestId,
      sessionId,
      requestClient: "discord",
      text: "cancel during finalize",
      messages: cancellationManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: cancellationManifest,
    });
    await finalizationStarted[0]!.promise;
    await publishRunnerRequest({
      bus,
      requestId: cancellationRequestId,
      sessionId,
      requestClient: "discord",
      queue: "interrupt",
      text: "cancel",
      raw: { cancel: true },
    });
    releaseFinalization[0]!.resolve(undefined);
    await expect(cancellationLifecycle.terminal).resolves.toBe("cancelled");
    expect(starts[2]).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: cancellationRequestId,
        attemptIndex: 0,
      }),
    ).toMatchObject({
      candidateSessionId:
        starts[2]?.mode === "fresh" || starts[2]?.mode === "fork" ? starts[2].sessionId : null,
      sourceSessionId: secondBinding.claudeSessionId,
      state: "cancelled",
    });
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toEqual(secondBinding);

    const raceRequestId = "discord:primary-claude-session:input-race";
    const raceMessages = [{ role: "user", content: "race finalize" }] satisfies ModelMessage[];
    const raceManifest = extendPrimaryManifest({
      store,
      sessionId,
      previous: secondManifest,
      completedRequestId: secondRequestId,
      outputMessageId: "output-2-race",
      currentMessageId: "input-race",
      currentMessages: raceMessages,
    });
    const raceLifecycle = await observeRequestLifecycle(bus, raceRequestId);
    await publishRunnerRequest({
      bus,
      requestId: raceRequestId,
      sessionId,
      requestClient: "discord",
      text: "race finalize",
      messages: raceManifest.segments.flatMap((segment) => segment.canonicalMessages),
      corePrimaryLineage: raceManifest,
    });
    await finalizationStarted[1]!.promise;
    expect(starts[3]).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });

    const competitorRequestId = "primary-competitor";
    const competitorSessionId = crypto.randomUUID();
    attemptMutationValue(
      store.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: secondBinding.executionScopeHash,
        requestId: competitorRequestId,
        attemptIndex: 0,
        candidateSessionId: competitorSessionId,
        sourceSessionId: secondBinding.claudeSessionId,
        expectedBindingRevision: secondBinding.revision,
      }),
    );
    store.saveRequestTranscript({
      requestId: competitorRequestId,
      sessionId,
      requestClient: "discord",
      messages: [{ role: "assistant", content: "competitor response" }],
      corePrimaryLineage: raceManifest,
    });
    const competitorTranscript = getRequestTranscript(store, {
      requestId: competitorRequestId,
    });
    if (!competitorTranscript?.transcriptDigest)
      throw new Error("competitor transcript is missing");
    const competitorHead = computeCorePrimaryClaudeTerminalHead({
      manifest: raceManifest,
      requestId: competitorRequestId,
      transcriptDigest: competitorTranscript.transcriptDigest,
      responseMessageCount: competitorTranscript.messages.length,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
    });
    store.publishCorePrimaryClaudeSuccess({
      providerId: "claude-code",
      requestClient: "discord",
      lilacSessionId: sessionId,
      requestId: competitorRequestId,
      attemptIndex: 0,
      terminalRequestId: competitorRequestId,
      terminalLineageVersion: 2,
      terminalAtomCount: competitorHead.atomCount,
      terminalPrefixDigest: competitorHead.prefixDigest,
      terminalCanonicalMessageCount: competitorHead.canonicalMessageCount,
      providerState: {
        lastFamily: "claude-code",
        containsCrossFamilyTurns: false,
      },
      nativeCwd: dataDir,
      nativeLastModified: 9_999,
      nativeContextTokens: 999,
      nativeContextMaxTokens: 4_000,
      lastModelSpecifier: "claude-code/sonnet",
      lastReasoning: "provider-default",
    });
    expect(
      promotePrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: competitorRequestId,
        attemptIndex: 0,
      }),
    ).toBe(true);
    releaseFinalization[1]!.resolve(undefined);
    await expect(raceLifecycle.terminal).resolves.toBe("resolved");
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toMatchObject({
      claudeSessionId: competitorSessionId,
      atomCount: competitorHead.atomCount,
      prefixDigest: competitorHead.prefixDigest,
      canonicalMessageCount: competitorHead.canonicalMessageCount,
    });
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: raceRequestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("failed");
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId: raceRequestId,
        attemptIndex: 0,
      }),
    ).toMatchObject({
      candidateSessionId:
        starts[3]?.mode === "fresh" || starts[3]?.mode === "fork" ? starts[3].sessionId : null,
      sourceSessionId: secondBinding.claudeSessionId,
    });
    expect(switchedModels).toEqual([]);

    await Promise.all([
      firstLifecycle.stop(),
      secondLifecycle.stop(),
      cancellationLifecycle.stop(),
      raceLifecycle.stop(),
    ]);
    await runner.stop();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("does not invoke a configured cross-family fallback after a Claude failure", async () => {
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = {
      model: "claude-code/sonnet",
      fallback: ["openai/must-not-run"],
    };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-fallback-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const sessionId = "primary-no-fallback";
    let materializations = 0;
    const switchedModels: Array<string | undefined> = [];
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "production-primary-no-fallback",
      reportFatalPanic: () => undefined,
      config,
      pluginManager: corePrimaryTestPluginManager(),
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "test-capability",
        principal: null,
      }),
      materializeClaudeCodeRun: async (options) => {
        materializations += 1;
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral")
          throw new Error("expected persistent Claude start");
        const observation: ClaudeNativeAttemptObservation = {
          requestedSessionId: start.sessionId,
          sourceSessionId: null,
          initSessionId: start.sessionId,
          resultSessionId: start.sessionId,
          contextTokens: 100,
          contextMaxTokens: 4_000,
          requestedModel: options.modelId,
          initializedModel: options.modelId,
          requestedReasoning: options.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        };
        const failingModel = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async () => {
            throw Object.assign(new Error("connection reset"), {
              code: "ECONNRESET",
            });
          },
        });
        return {
          agentModel: failingModel,
          executeCall: executeAiSdkModelCall,
          continuationModel: failingModel,
          createUtilityModelResult: () => Result.ok(failingModel),
          createUtilityModel: () => failingModel,
          control: {
            inject: () => false,
            interrupt: async () => false,
            async interruptResult() {
              return Result.ok(await this.interrupt());
            },
            clear: () => {},
            clearResult() {
              this.clear();
              return Result.ok();
            },
          },
          nativeSession: {
            getObservation: () => observation,
            waitForObservation: async () => observation,
            recordWarning: () => {},
            finalize: async () => ({
              status: "promotable" as const,
              issues: [] as const,
              observations: observation,
              candidate: {
                sessionId: start.sessionId,
                cwd: options.cwd,
                lastModified: 1,
              },
              sourcePreflight: null,
              sourceFinal: null,
            }),
            async finalizeResult() {
              return Result.ok(await this.finalize());
            },
          },
          dispose: async () => {},
          disposeResult: async () => Result.ok(),
        };
      },
      createAgent: (options) => {
        const agent = new AiSdkPiAgent(options);
        const setModel = agent.setModel.bind(agent);
        agent.setModel = (model, providerOptions, modelSpecifier, reasoning) => {
          switchedModels.push(modelSpecifier);
          setModel(model, providerOptions, modelSpecifier, reasoning);
        };
        return agent;
      },
    });
    const requestId = "discord:primary-no-fallback:input";
    const messages = [{ role: "user", content: "fail without fallback" }] satisfies ModelMessage[];
    const manifest = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, "input", messages),
    ]);
    const lifecycle = await observeRequestLifecycle(bus, requestId);

    await publishRunnerRequest({
      bus,
      requestId,
      sessionId,
      requestClient: "discord",
      text: "fail without fallback",
      corePrimaryLineage: manifest,
    });

    await expect(lifecycle.terminal).resolves.toBe("failed");
    expect(materializations).toBe(1);
    expect(switchedModels).toEqual([]);
    expect(
      getPrimaryBinding(store, {
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
      }),
    ).toBeNull();

    await lifecycle.stop();
    await runner.stop();
    store.close();
    await bus.close();
    await rm(dataDir, { recursive: true, force: true });
  });
});

describe("Core-primary local compaction replacement", () => {
  it("falls back from an owned utility-model failure without calling the throwing adapter", () => {
    const fallbackModel = new MockLanguageModelV4({ modelId: "fallback" });
    let compatibilityCalls = 0;
    const reported: ClaudeCodeRunExternalFailure[] = [];
    const failure = new ClaudeCodeRunExternalFailure({
      operation: "Claude utility model construction",
      cause: new Error("construction failed"),
      message: "Claude utility model construction failed",
    });
    const run = {
      createUtilityModelResult: () => Result.err(failure),
      createUtilityModel: () => {
        compatibilityCalls += 1;
        throw failure;
      },
    };

    const model = resolveCoreClaudeCompactionSummaryModel({
      run,
      fallback: () => fallbackModel,
      onFailure: (error) => reported.push(error),
    });

    expect(model).toBe(fallbackModel);
    expect(reported).toEqual([failure]);
    expect(compatibilityCalls).toBe(0);
  });

  it.each([0, 2])(
    "maps current segment %i and prepares retained mixed history in the fresh payload",
    async (currentSegmentIndex) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-primary-compaction-"));
      const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
      const oldPrefix = [
        { role: "user", content: `old question ${"x".repeat(20_000)}` },
        { role: "assistant", content: "old answer" },
      ] satisfies ModelMessage[];
      const retainedHistorical = [
        { role: "user", content: "retained historical question" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "old-tool",
              toolName: "builtin",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "old-tool",
              toolName: "builtin",
              output: { type: "text", value: "historical tool output" },
            },
          ],
        },
        { role: "assistant", content: "retained historical answer" },
      ] satisfies ModelMessage[];
      const current = [
        {
          role: "user",
          content: [
            { type: "text", text: "current question" },
            {
              type: "file",
              data: new Uint8Array([1, 2, 3]),
              mediaType: "image/png",
            },
          ],
        },
      ] satisfies ModelMessage[];
      const oldPrefixStored = transcriptResultValue(projectStoredMessagesV1(oldPrefix));
      const retainedHistoricalStored = transcriptResultValue(
        projectStoredMessagesV1(retainedHistorical),
      );
      const currentStored = transcriptResultValue(
        projectStoredMessagesV1([
          {
            role: "user",
            content: [
              { type: "text", text: "current question" },
              {
                type: "blob",
                blob: {
                  version: 1,
                  objectId: `b1_${"11".repeat(16)}`,
                  sha256: "22".repeat(32),
                  byteLength: 3,
                },
                mediaType: "image/png",
              },
            ],
          },
        ]),
      );
      const originalMessages = [...oldPrefix, ...retainedHistorical, ...current];
      let lineage: CorePrimaryLineageV2 = buildCoreLineageManifestV2(
        [
          {
            atoms: [
              {
                kind: "synthetic",
                source: "old-prefix",
                messageDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(oldPrefixStored))
                  .hash,
              },
            ],
            canonicalMessages: oldPrefixStored,
          },
          {
            atoms: [
              {
                kind: "synthetic",
                source: "retained-history",
                messageDigest: transcriptResultValue(
                  hashCanonicalStoredMessagesV2(retainedHistoricalStored),
                ).hash,
              },
            ],
            canonicalMessages: retainedHistoricalStored,
          },
          {
            atoms: [
              {
                kind: "synthetic",
                source: "current-media",
                messageDigest: transcriptResultValue(hashCanonicalStoredMessagesV2(currentStored))
                  .hash,
              },
            ],
            canonicalMessages: currentStored,
          },
        ],
        { currentSegmentIndex },
      );
      const mainPayloads: ModelMessage[][] = [];
      const mainModel = new MockLanguageModelV4({
        modelId: "sonnet",
        doStream: async (call) => {
          mainPayloads.push([...call.prompt]);
          return level1TextStep("fresh response");
        },
      });
      const summaryModel = new MockLanguageModelV4({
        modelId: "summary",
        doStream: async () => level1TextStep("## Objective\n- Preserve current input."),
      });
      const materializedStarts: ClaudeNativeSessionStart[] = [];
      const disposedSessionIds: string[] = [];
      const observation: ClaudeNativeAttemptObservation = {
        requestedSessionId: null,
        sourceSessionId: null,
        initSessionId: null,
        resultSessionId: null,
        contextTokens: null,
        contextMaxTokens: null,
        requestedModel: "sonnet",
        initializedModel: null,
        requestedReasoning: null,
        providerWarnings: [],
        invoked: false,
        requiredObservabilityError: null,
        callbackError: null,
      };
      const runtime = createCorePrimaryClaudeRuntime({
        store,
        sessionId: "compaction-session",
        requestId: "compaction-request",
        providerId: "claude-code",
        modelSpecifier: "claude-code/sonnet",
        reasoning: "provider-default",
        executionScopeHash: "scope",
        executionCwd: dataDir,
        getLineage: () => lineage,
        materialize: async (start) => {
          materializedStarts.push(start);
          return {
            agentModel: mainModel,
            executeCall: executeAiSdkModelCall,
            continuationModel: mainModel,
            createUtilityModelResult: () => Result.ok(summaryModel),
            createUtilityModel: () => summaryModel,
            control: {
              inject: () => false,
              interrupt: async () => false,
              async interruptResult() {
                return Result.ok(await this.interrupt());
              },
              clear: () => {},
              clearResult() {
                this.clear();
                return Result.ok();
              },
            },
            nativeSession: {
              getObservation: () => ({
                ...observation,
                requestedSessionId: start.mode === "ephemeral" ? null : start.sessionId,
                initSessionId: start.mode === "ephemeral" ? null : start.sessionId,
                resultSessionId: start.mode === "ephemeral" ? null : start.sessionId,
                invoked: true,
              }),
              waitForObservation: async () => observation,
              recordWarning: () => {},
              finalize: async () => ({
                status: "unpromotable" as const,
                issues: [
                  {
                    code: "candidate-missing" as const,
                    message: "not finalized in this test",
                  },
                ],
                observations: observation,
                candidate: null,
                sourcePreflight: null,
                sourceFinal: null,
              }),
              async finalizeResult() {
                return Result.ok(await this.finalize());
              },
            },
            dispose: async () => {
              if (start.mode !== "ephemeral") disposedSessionIds.push(start.sessionId);
            },
            async disposeResult() {
              if (start.mode !== "ephemeral") disposedSessionIds.push(start.sessionId);
              return Result.ok();
            },
          };
        },
      });
      await runtime.prepareModelCall({
        canonicalMessages: originalMessages,
        fullBudgetView: originalMessages,
        runtime: {
          model: mainModel,
          modelSpecifier: "claude-code/sonnet",
          executionMode: "provider-tools",
        },
        payload: { mode: "full" },
        transformContext: { system: "test", tools: level1TestToolset().tools },
      });
      const agent = new AiSdkPiAgent({
        system: "test",
        model: mainModel,
        modelSpecifier: "claude-code/sonnet",
        messages: originalMessages,
        tools: level1TestToolset().tools,
        sendToolsToModel: false,
        prepareModelCall: runtime.prepareModelCall,
      });
      let replacement:
        | {
            originalSuffixStart: number;
            replacementSuffixStart: number;
            replacementMessageCount: number;
          }
        | undefined;
      const detach = await attachAutoCompaction(agent, {
        model: "claude-code/sonnet",
        modelCapability: new ModelCapability({ fetch: globalThis.fetch }),
        summaryModel,
        resolveContextLimit: async () => ({ context: 2_000, output: 200 }),
        resolveSummaryContextLimit: () => 2_000,
        inputEstimateFloor: () => (replacement === undefined ? 2_000 : null),
        thresholdInputSource: "transcript-estimate",
        keepRecentTurns: 2,
        keepRecentTokens: 1_000,
        prepareFullModelView: (messages) => runtime.prepareHistoryView(messages),
        prepareFullBudgetView: (messages, context) =>
          runtime.prepareFullBudgetView(messages, context.canonicalStartIndex),
        onCompactionEnd: (event) => {
          if (event.status !== "completed" || !event.canonicalReplacement) return;
          replacement = event.canonicalReplacement;
          lineage = degradeCorePrimaryLineageForMutation(
            "compaction-checkpoint-transform",
            mapCorePrimaryCompactionCurrentCanonicalStart({
              previousCurrentCanonicalStart: lineage.currentCanonicalStart,
              replacement: event.canonicalReplacement,
            }),
          );
        },
      });

      try {
        await agent.continue();
      } finally {
        detach();
        await runtime.retireAtRunEnd();
      }

      expect(replacement).toMatchObject({
        originalSuffixStart: 3,
        replacementSuffixStart: 1,
        replacementMessageCount: 5,
      });
      expect(String(lineage.state)).toBe("fresh-only");
      expect(lineage.currentCanonicalStart).toBe(currentSegmentIndex === 0 ? 0 : 4);
      expect("reason" in lineage ? lineage.reason : null).toBe("compaction-checkpoint-transform");
      expect(materializedStarts).toHaveLength(2);
      expect(materializedStarts[0]).toMatchObject({ mode: "fresh" });
      expect(materializedStarts[1]).toMatchObject({ mode: "fresh" });
      const firstStart = materializedStarts[0];
      const replacementStart = materializedStarts[1];
      if (
        !firstStart ||
        !replacementStart ||
        firstStart.mode === "ephemeral" ||
        replacementStart.mode === "ephemeral"
      ) {
        throw new Error("expected persisted compaction candidates");
      }
      expect(replacementStart.sessionId).not.toBe(firstStart.sessionId);
      expect(disposedSessionIds).toContain(firstStart.sessionId);
      expect(agent.state.messages.slice(1, 5)).toEqual([
        ...retainedHistorical.slice(1),
        ...current,
      ]);
      expect(mainPayloads).toHaveLength(1);
      const actualPayload = mainPayloads[0]!;
      const serializedPayload = JSON.stringify(actualPayload);
      expect(serializedPayload.includes('"type":"tool-call"')).toBe(currentSegmentIndex === 0);
      expect(serializedPayload.includes('"type":"tool-result"')).toBe(currentSegmentIndex === 0);
      expect(serializedPayload).toContain("historical tool output");
      const payloadCurrent = actualPayload.find(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "file"),
      );
      if (!payloadCurrent || !Array.isArray(payloadCurrent.content)) {
        throw new Error("current media payload is missing");
      }
      expect(
        payloadCurrent.content.some(
          (part) => part.type === "text" && part.text === "current question",
        ),
      ).toBe(true);
      expect(
        payloadCurrent.content.some(
          (part) => part.type === "file" && part.mediaType === "image/png",
        ),
      ).toBe(true);

      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  );
});
