import { executeAiSdkModelCall } from "@stanley2058/lilac-agent/adapters/ai-sdk/model-call";
import {
  createNativeOutputPublisher,
  NativeOutputPublishFailed,
  type NativeOutputEvent,
} from "../../../src/surface/native/output";
import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createLilacBus,
  lilacEventTypes,
  type StoredMessageV1,
} from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Result } from "better-result";
import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import {
  type ClaudeNativeAttemptObservation,
  type ClaudeNativeSessionStart,
} from "@stanley2058/lilac-claude-code-bridge";
import { type BusAgentRunnerRequestDelivery } from "../../../src/surface/bridge/bus-agent-runner";
import { type CoreToolPluginManager } from "../../../src/plugins";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { projectStoredMessagesV1 } from "../../../src/transcript/stored-message-materialization";
import { createRequestMessageCache } from "../../../src/tool-server/request-message-cache";
import {
  AgentRunJournalConflict,
  AgentRunJournalSqliteFailure,
  type AgentRunCheckpointV1,
  type AgentRunRecoveryHead,
} from "../../../src/surface/bridge/agent-run-journal";
import {
  RequestDeliveryCoordinator,
  SqliteRequestDeliveryStore,
  coreRequestDeliveryCodecs,
  createCoreRequestDeliveryAdmission,
} from "../../../src/surface/bridge/request-delivery";
import type { AuthenticatedSurfaceOrigin } from "../../../src/surface/types";
import { testDeliveriesRemainOpenOnPolicyStop } from "../../helpers/result-raw-bus";
import {
  TEST_BLOB_STORE,
  startBusAgentRunner,
  transcriptResultValue,
  attemptMutationValue,
  buildCoreLineageManifestV2,
  getRequestTranscript,
  level1TestToolset,
  level1TextStep,
  level1ToolCallStep,
  level1OfferedToolNames,
  createInMemoryRawBus,
  deferred,
  observeRequestLifecycle,
  publishRunnerRequest,
  acceptedRunnerDelivery,
  corePrimaryTestPluginManager,
  admitPrimarySurface,
  extendPrimaryManifest,
} from "./bus-agent-runner-test-support";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

describe("durable accepted runner recovery", () => {
  it.each([false, true])(
    "releases toolset ownership after run completion, cancelled during build=%s",
    async (cancelDuringBuild) => {
      const bus = createLilacBus(createInMemoryRawBus());
      const config = parseCoreConfigV2ToUniversal({});
      config.models.main = { model: "openai/toolset-release" };
      const buildStarted = deferred<void>();
      const finishBuild = deferred<void>();
      const released = deferred<void>();
      let releases = 0;
      let modelCalls = 0;
      const toolset = {
        ...level1TestToolset(),
        release: async () => {
          releases += 1;
          released.resolve(undefined);
          return Result.ok(undefined);
        },
      };
      const pluginManager = corePrimaryTestPluginManager(undefined, toolset);
      pluginManager.buildLevel1ToolsetResult = async () => {
        buildStarted.resolve(undefined);
        if (cancelDuringBuild) await finishBuild.promise;
        return Result.ok(toolset);
      };
      const runner = await startBusAgentRunner({
        bus,
        config,
        pluginManager,
        subscriptionId: "toolset-release",
        reportFatalPanic: (panic) => {
          throw panic;
        },
        issueControlCapability: () => ({ capability: "toolset-release", principal: null }),
        createAgent: (options) =>
          new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "toolset-release",
              doStream: async () => {
                modelCalls += 1;
                expect(releases).toBe(0);
                return level1TextStep("finished");
              },
            }),
          }),
      });
      const request = {
        bus,
        requestId: "github:toolset-release:request",
        sessionId: "toolset-release",
        text: "hold toolset ownership",
      };
      try {
        await publishRunnerRequest(request);
        await buildStarted.promise;
        if (cancelDuringBuild) {
          await publishRunnerRequest({
            ...request,
            queue: "interrupt",
            messages: [],
            raw: { cancel: true },
          });
          await runner.waitForIdle();
          expect(releases).toBe(0);
          finishBuild.resolve(undefined);
        }
        await released.promise;
        await runner.waitForIdle();
        expect(releases).toBe(1);
        expect(modelCalls).toBe(cancelDuringBuild ? 0 : 1);
      } finally {
        finishBuild.resolve(undefined);
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );
  it.each(["register", "ready", "terminalize"] as const)(
    "settles preparation failure at parent %s and starts the next session request",
    async (failureStage) => {
      const bus = createLilacBus(createInMemoryRawBus());
      const pluginManager = corePrimaryTestPluginManager();
      let registrations = 0;
      let closes = 0;
      const terminalized: string[] = [];
      const settled: string[] = [];
      const workflowLiveParentBridge = {
        registerParent: () => {
          registrations += 1;
          if (failureStage !== "ready") throw new Error("parent registration unavailable");
          return {
            ready: Promise.reject(new Error("child subscription unavailable")),
            close: async () => {
              closes += 1;
            },
          };
        },
      } as unknown as NonNullable<
        Parameters<typeof startBusAgentRunner>[0]["workflowLiveParentBridge"]
      >;
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: `parent-preparation-${failureStage}`,
        config: parseCoreConfigV2ToUniversal({}),
        pluginManager,
        workflowLiveParentBridge,
        onRequestSettled: (id) => {
          settled.push(id);
        },
        requestDelivery: {
          terminalize: async ({ requestDeliveryId }: { requestDeliveryId: string }) => {
            terminalized.push(requestDeliveryId);
            if (failureStage === "terminalize") {
              return Result.err(new Error("terminal write unavailable"));
            }
            return Result.ok(undefined);
          },
        } as unknown as BusAgentRunnerRequestDelivery,
        reportFatalPanic: (panic) => {
          throw panic;
        },
      });
      try {
        for (const suffix of ["first", "second"]) {
          const requestDeliveryId = crypto.randomUUID();
          transcriptResultValue(
            await runner.resumeAcceptedDelivery(
              acceptedRunnerDelivery({
                requestDeliveryId,
                requestId: `github:parent-preparation:${suffix}`,
                sessionId: "parent-preparation",
                queue: "prompt",
                messages: [{ role: "user", content: "exercise preparation cleanup" }],
              }),
            ),
          );
          await runner.waitForIdle();
          expect(terminalized).toContain(requestDeliveryId);
          expect(settled).toContain(requestDeliveryId);
        }
        expect(registrations).toBe(2);
        expect(closes).toBe(failureStage === "ready" ? 2 : 0);
        expect(runner.getActiveLevel1Work()).toEqual([]);
      } finally {
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );
  it.each(["handler-throw", "result-error", "already-accepted"] as const)(
    "does not start provider work for durable admission outcome %s",
    async (failureKind) => {
      const rawBus = createInMemoryRawBus();
      testDeliveriesRemainOpenOnPolicyStop.add(rawBus);
      const bus = createLilacBus(rawBus);
      const pluginManager = corePrimaryTestPluginManager();
      let modelCalls = 0;
      const requestDelivery = {
        handleDelivery: async () => {
          if (failureKind === "handler-throw") {
            throw new Error("injected delivery handler rejection");
          }
          if (failureKind === "result-error") {
            return Result.err(new Error("injected delivery handler failure"));
          }
          return Result.ok({
            disposition: "commit" as const,
            reason: "already-accepted" as const,
          });
        },
        replaceAcceptedWork: () => {
          throw new Error("unowned work must not be replaced");
        },
        terminalize: async () => {
          throw new Error("unowned work must not be terminalized");
        },
      } as unknown as BusAgentRunnerRequestDelivery;
      const runner = await startBusAgentRunner({
        bus,
        subscriptionId: `durable-admission-${failureKind}`,
        reportFatalPanic: () => undefined,
        config: parseCoreConfigV2ToUniversal({}),
        pluginManager,
        requestDelivery,
        issueControlCapability: () => ({
          capability: "durable-admission",
          principal: null,
        }),
        createAgent: (options) => {
          modelCalls += 1;
          return new AiSdkPiAgent({
            ...options,
            model: new MockLanguageModelV4({
              modelId: "must-not-run",
              doStream: async () => level1TextStep("must not run"),
            }),
          });
        },
      });
      try {
        await publishRunnerRequest({
          bus,
          requestDeliveryId: crypto.randomUUID(),
          requestId: `github:durable-admission:${failureKind}`,
          sessionId: `durable-admission-${failureKind}`,
          text: "must remain parked",
        });
        expect(runner.isSessionBusy(`durable-admission-${failureKind}`)).toBe(false);
        expect(modelCalls).toBe(0);
      } finally {
        testDeliveriesRemainOpenOnPolicyStop.delete(rawBus);
        await runner.stop();
        await pluginManager.destroy();
        await bus.close();
      }
    },
  );

  it("reconciles accepted work immediately after a post-accept intake failure", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:accepted-reconcile:request";
    const sessionId = "accepted-reconcile";
    const messages: StoredMessageV1[] = [{ role: "user", content: "retry from accepted work" }];
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages,
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    let intakeAttempts = 0;
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "accepted-reconcile",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      beforeRequestIntake: () => {
        intakeAttempts += 1;
        throw new Error("fail after accepted commit");
      },
      issueControlCapability: () => ({
        capability: "reconcile",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "accepted-reconcile",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("reconciled");
            },
          }),
        }),
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "retry from accepted work",
      });
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.waitForIdle();
      expect({ intakeAttempts, modelCalls }).toEqual({
        intakeAttempts: 1,
        modelCalls: 1,
      });
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("terminal");
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("retains an applied attached control until the active run terminalizes", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const activeDeliveryId = crypto.randomUUID();
    const controlDeliveryId = crypto.randomUUID();
    const requestId = "github:retained-control:active";
    const sessionId = "retained-control";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: activeDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: activeDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "stay active" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const uploaded = transcriptResultValue(
      await TEST_BLOB_STORE.startUpload({
        source: new TextEncoder().encode("active steering attachment"),
        retention: { kind: "durable" },
      }),
    );
    const reference = transcriptResultValue(await uploaded.completion);
    const controlMessages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "apply attached steer" },
          {
            type: "blob" as const,
            blob: uploaded.handle,
            mediaType: "text/plain",
            filename: "steer.txt",
          },
        ],
      },
    ];
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: controlDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
        },
        inputHandles: [uploaded.handle],
        createdAt: 2,
      }),
    );
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const steerApplied = deferred<void>();
    const reconciledControlStates: string[] = [];
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => {
        reconciledControlStates.push(transcriptResultValue(store.load(controlDeliveryId)).state);
        return Result.ok(undefined);
      },
    };
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "retained-attached-control",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "retained-control",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "retained-control",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              }
              return level1TextStep("done");
            },
          }),
        });
        const steer = agent.steer.bind(agent);
        agent.steer = (message) => {
          const id = steer(message);
          steerApplied.resolve(undefined);
          return id;
        };
        return agent;
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId: activeDeliveryId,
        requestId,
        sessionId,
        text: "stay active",
      });
      await firstStarted.promise;
      transcriptResultValue(
        await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
          },
        ),
      );
      await steerApplied.promise;
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("accepted");
      expect((await TEST_BLOB_STORE.open(reference)).status).toBe("ok");

      releaseFirst.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.waitForIdle();
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("terminal");
      expect(reconciledControlStates).toEqual(["terminal"]);
      expect((await TEST_BLOB_STORE.open(reference)).status).toBe("error");
    } finally {
      releaseFirst.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("checkpoints a queued control and its retained delivery in the same transition", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const activeDeliveryId = crypto.randomUUID();
    const controlDeliveryId = crypto.randomUUID();
    const requestId = "github:checkpointed-control:active";
    const sessionId = "checkpointed-control";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: activeDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: activeDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "stay active" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const controlMessages = [{ role: "user" as const, content: "apply queued steer" }];
    transcriptResultValue(
      store.prepare({
        requestDeliveryId: controlDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
        },
        inputHandles: [],
        createdAt: 2,
      }),
    );
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const steerApplied = deferred<void>();
    const checkpoints: AgentRunCheckpointV1[] = [];
    let crashBoundaryCheckpoint: AgentRunCheckpointV1 | undefined;
    let controlQueued = false;
    let failedControlCheckpoint = false;
    let journalSequence = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        journalSequence += 1;
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: journalSequence,
        });
      },
      writeCheckpoint: (
        handle: {
          readonly runId: string;
          readonly requestId: string;
          readonly sessionId: string;
          readonly sequence: number;
        },
        checkpoint: AgentRunCheckpointV1,
      ) => {
        const includesControl = JSON.stringify(checkpoint.messages).includes("apply queued steer");
        if (includesControl && !failedControlCheckpoint) {
          failedControlCheckpoint = true;
          throw new Error("injected unexpected checkpoint writer failure");
        }
        checkpoints.push(checkpoint);
        if (controlQueued && !includesControl && !crashBoundaryCheckpoint) {
          crashBoundaryCheckpoint = checkpoint;
        }
        journalSequence = handle.sequence + 1;
        return Result.ok({ ...handle, sequence: journalSequence });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "checkpointed-control",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "checkpointed-control",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "checkpointed-control",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              }
              if (modelCalls === 2) {
                return level1ToolCallStep([
                  { toolCallId: "retry-checkpoint", toolName: "retry_checkpoint" },
                ]);
              }
              return level1TextStep("done");
            },
          }),
          beforeStep: undefined,
          normalizeToolResultOutput: undefined,
          tools: {
            retry_checkpoint: tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: () => "checkpoint retry boundary",
            }),
          },
        });
        const steer = agent.steer.bind(agent);
        agent.steer = (message) => {
          const id = steer(message);
          controlQueued = true;
          steerApplied.resolve(undefined);
          return id;
        };
        return agent;
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId: activeDeliveryId,
        requestId,
        sessionId,
        text: "stay active",
      });
      await firstStarted.promise;
      transcriptResultValue(
        await bus.publish(
          lilacEventTypes.CmdRequestMessage,
          {
            requestDeliveryId: controlDeliveryId,
            queue: "steer",
            messages: controlMessages,
            raw: { requiresActive: true },
          },
          {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
          },
        ),
      );
      await steerApplied.promise;
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("accepted");

      releaseFirst.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.waitForIdle();
      expect(crashBoundaryCheckpoint).toBeDefined();
      expect(crashBoundaryCheckpoint?.retainedRequestDeliveries).toEqual([]);
      expect(
        checkpoints.some(
          (checkpoint) =>
            JSON.stringify(checkpoint.messages).includes("apply queued steer") &&
            checkpoint.retainedRequestDeliveries.filter(
              (retained) => retained.requestDeliveryId === controlDeliveryId,
            ).length === 1,
        ),
      ).toBe(true);
      expect(failedControlCheckpoint).toBe(true);
      expect(modelCalls).toBe(3);
      expect(transcriptResultValue(store.load(controlDeliveryId)).state).toBe("terminal");
    } finally {
      releaseFirst.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("continues provider work while a checkpoint blob upload is pending", async () => {
    const order: string[] = [];
    const uploadStarted = deferred<void>();
    const secondModelStarted = deferred<void>();
    const releaseUpload = deferred<void>();
    let uploadReleased = false;
    let modelAdvancedBeforeUpload = false;
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-runner-journal-background-"));
    const transcriptStore = new SqliteTranscriptStore(path.join(directory, "transcripts.db"));
    const baseBlobStore = transcriptResultValue(await createMemoryBlobStore());
    let uploadCount = 0;
    const blobStore: BlobStore = {
      startUpload: async (input) => {
        const started = await baseBlobStore.startUpload(input);
        uploadCount += 1;
        if (uploadCount !== 1) return started;
        return started.map((upload) => ({
          ...upload,
          completion: (async () => {
            uploadStarted.resolve(undefined);
            await releaseUpload.promise;
            return await upload.completion;
          })(),
        }));
      },
      startStagedUpload: (input) => baseBlobStore.startStagedUpload(input),
      adopt: (handle) => baseBlobStore.adopt(handle),
      resolve: (handle, options) => baseBlobStore.resolve(handle, options),
      open: (ref) => baseBlobStore.open(ref),
      delete: (target) => baseBlobStore.delete(target),
      maintain: (input) => baseBlobStore.maintain(input),
      close: (input) => baseBlobStore.close(input),
    };
    const rawBus = createInMemoryRawBus({
      onPublish: (eventType) => {
        if (eventType === lilacEventTypes.EvtAgentOutputResponseText) order.push("surface-write");
      },
    });
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore,
      admission: createCoreRequestDeliveryAdmission(blobStore),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:journal-order:request";
    const sessionId = "journal-order";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "persist before work" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    let sequence = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        order.push("open");
        sequence += 1;
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence,
        });
      },
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        order.push("checkpoint");
        sequence = handle.sequence + 1;
        return Result.ok({ ...handle, sequence });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        order.push("terminal");
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-order",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      blobStore,
      transcriptStore,
      issueControlCapability: () => ({
        capability: "journal-order",
        principal: null,
      }),
      createAgent: (options) => {
        let modelCalls = 0;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-order",
            doStream: async () => {
              modelCalls += 1;
              order.push(`model-${modelCalls}`);
              if (modelCalls === 1) {
                return level1ToolCallStep([{ toolCallId: "read-image", toolName: "read" }]);
              }
              modelAdvancedBeforeUpload = !uploadReleased;
              secondModelStarted.resolve(undefined);
              return level1TextStep("journalled");
            },
          }),
          beforeStep: undefined,
          normalizeToolResultOutput: undefined,
          tools: {
            read: tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: () => ({ filename: "image.png" }),
              toModelOutput: () => ({
                type: "content",
                value: [
                  { type: "text", text: "Attached image.png" },
                  {
                    type: "file",
                    data: { type: "data", data: "iVBORwE=" },
                    mediaType: "image/png",
                    filename: "image.png",
                  },
                ],
              }),
            }),
          },
        });
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "persist before work",
      });
      await uploadStarted.promise;
      await secondModelStarted.promise;
      expect(modelAdvancedBeforeUpload).toBe(true);
      uploadReleased = true;
      releaseUpload.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.waitForIdle();
      expect(order.indexOf("surface-write")).toBeLessThan(order.indexOf("terminal"));
    } finally {
      uploadReleased = true;
      releaseUpload.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      transcriptStore.close();
      await baseBlobStore.close({ deadlineAtMs: Date.now() + 1_000 });
      store.close();
      await bus.close();
      await rm(directory, { recursive: true });
    }
  });

  it("keeps recovery ownership when both terminal surface publications fail", async () => {
    let terminalSurfaceAttempts = 0;
    const terminalSurfaceFailed = deferred<void>();
    const uploadStarted = deferred<void>();
    const releaseUpload = deferred<void>();
    const liveParentClosed = deferred<void>();
    const directory = await mkdtemp(path.join(tmpdir(), "lilac-runner-journal-failed-output-"));
    const transcriptStore = new SqliteTranscriptStore(path.join(directory, "transcripts.db"));
    const baseBlobStore = transcriptResultValue(await createMemoryBlobStore());
    let uploadCount = 0;
    const blobStore: BlobStore = {
      startUpload: async (input) => {
        const started = await baseBlobStore.startUpload(input);
        uploadCount += 1;
        if (uploadCount !== 1) return started;
        return started.map((upload) => ({
          ...upload,
          completion: (async () => {
            uploadStarted.resolve(undefined);
            await releaseUpload.promise;
            return await upload.completion;
          })(),
        }));
      },
      startStagedUpload: (input) => baseBlobStore.startStagedUpload(input),
      adopt: (handle) => baseBlobStore.adopt(handle),
      resolve: (handle, options) => baseBlobStore.resolve(handle, options),
      open: (ref) => baseBlobStore.open(ref),
      delete: (target) => baseBlobStore.delete(target),
      maintain: (input) => baseBlobStore.maintain(input),
      close: (input) => baseBlobStore.close(input),
    };
    const rawBus = createInMemoryRawBus({
      onPublish: (eventType) => {
        if (eventType !== lilacEventTypes.EvtAgentOutputResponseText) return;
        terminalSurfaceAttempts += 1;
        if (terminalSurfaceAttempts === 2) terminalSurfaceFailed.resolve(undefined);
        throw new Error("injected terminal surface publication failure");
      },
    });
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore,
      admission: createCoreRequestDeliveryAdmission(blobStore),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:journal-terminal-publication-failure:request";
    const sessionId = "journal-terminal-publication-failure";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "retain recovery ownership" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    let terminalMarks = 0;
    let reconciliations = 0;
    const workflowLiveParentBridge = {
      registerParent: () => ({
        ready: Promise.resolve(),
        snapshot: () => ({
          signalVersion: 0,
          hasPendingCompletions: false,
          hasOutstandingRuns: false,
        }),
        waitForSignalSince: async () => undefined,
        listPendingIdentities: () => [],
        listPendingSettledAsync: async () => [],
        acknowledge: async () => undefined,
        isPending: () => false,
        clearMaterializationFailure: () => undefined,
        recordMaterializationFailure: () => 0,
        cancelAll: async () => undefined,
        close: async () => {
          liveParentClosed.resolve(undefined);
        },
      }),
    } as unknown as NonNullable<
      Parameters<typeof startBusAgentRunner>[0]["workflowLiveParentBridge"]
    >;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        terminalMarks += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => {
        reconciliations += 1;
        return Result.ok(undefined);
      },
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-terminal-publication-failure",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      blobStore,
      transcriptStore,
      workflowLiveParentBridge,
      issueControlCapability: () => ({
        capability: "terminal-publication",
        principal: null,
      }),
      createAgent: (options) => {
        let modelCalls = 0;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-terminal-publication-failure",
            doStream: async () => {
              modelCalls += 1;
              return modelCalls === 1
                ? level1ToolCallStep([{ toolCallId: "failed-output-read", toolName: "read" }])
                : level1TextStep("surface must accept this");
            },
          }),
          beforeStep: undefined,
          normalizeToolResultOutput: undefined,
          tools: {
            read: tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: () => ({ filename: "failed-output.png" }),
              toModelOutput: () => ({
                type: "content",
                value: [
                  { type: "text", text: "Attached failed-output.png" },
                  {
                    type: "file",
                    data: { type: "data", data: "iVBORwE=" },
                    mediaType: "image/png",
                    filename: "failed-output.png",
                  },
                ],
              }),
            }),
          },
        });
      },
    });
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "retain recovery ownership",
      });
      await uploadStarted.promise;
      await terminalSurfaceFailed.promise;
      await liveParentClosed.promise;
      await Promise.resolve();
      expect(runner.getActiveLevel1Work()).toHaveLength(1);
      releaseUpload.resolve(undefined);
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.waitForIdle();

      expect(terminalSurfaceAttempts).toBe(2);
      expect(terminalMarks).toBe(0);
      expect(reconciliations).toBe(0);
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("accepted");
    } finally {
      releaseUpload.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      transcriptStore.close();
      await baseBlobStore.close({ deadlineAtMs: Date.now() + 1_000 });
      store.close();
      await bus.close();
      await rm(directory, { recursive: true });
    }
  });

  it("marks the terminal journal head before a blocked live-parent cleanup", async () => {
    const order: string[] = [];
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    const terminalMarked = deferred<void>();
    const rawBus = createInMemoryRawBus({
      onPublish: (eventType) => {
        if (eventType === lilacEventTypes.EvtAgentOutputResponseText) order.push("surface-write");
      },
    });
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const requestDeliveryId = crypto.randomUUID();
    const requestId = "github:journal-cleanup-order:request";
    const sessionId = "journal-cleanup-order";
    transcriptResultValue(
      store.prepare({
        requestDeliveryId,
        requestId,
        envelope: {
          headers: {
            request_id: requestId,
            session_id: sessionId,
            request_client: "github",
          },
          data: {
            requestDeliveryId,
            queue: "prompt",
            messages: [{ role: "user", content: "mark before cleanup" }],
          },
        },
        inputHandles: [],
        createdAt: 1,
      }),
    );
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        order.push("terminal");
        terminalMarked.resolve(undefined);
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const workflowLiveParentBridge = {
      registerParent: () => ({
        ready: Promise.resolve(),
        snapshot: () => ({
          signalVersion: 0,
          hasPendingCompletions: false,
          hasOutstandingRuns: false,
        }),
        waitForSignalSince: async () => undefined,
        listPendingIdentities: () => [],
        listPendingSettledAsync: async () => [],
        acknowledge: async () => undefined,
        isPending: () => false,
        clearMaterializationFailure: () => undefined,
        recordMaterializationFailure: () => 0,
        cancelAll: async () => undefined,
        close: async () => {
          order.push("cleanup");
          cleanupStarted.resolve(undefined);
          await releaseCleanup.promise;
        },
      }),
    } as unknown as NonNullable<
      Parameters<typeof startBusAgentRunner>[0]["workflowLiveParentBridge"]
    >;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-cleanup-order",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      workflowLiveParentBridge,
      issueControlCapability: () => ({
        capability: "journal-cleanup-order",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-cleanup-order",
            doStream: async () => level1TextStep("marked"),
          }),
        }),
    });
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId,
        sessionId,
        text: "mark before cleanup",
      });
      await terminalMarked.promise;
      await cleanupStarted.promise;
      expect(order).toEqual(["surface-write", "terminal", "cleanup"]);
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("accepted");
      releaseCleanup.resolve(undefined);
      await runner.waitForIdle();
      expect(transcriptResultValue(store.load(requestDeliveryId)).state).toBe("terminal");
    } finally {
      releaseCleanup.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("keeps the previous checkpoint after one conflict and admits a later request", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    let failCheckpoint = true;
    let resets = 0;
    let modelCalls = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        if (failCheckpoint) {
          failCheckpoint = false;
          return Result.err(
            new AgentRunJournalConflict({
              runId: handle.runId,
              message: "injected checkpoint failure",
            }),
          );
        }
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      resetRun: () => {
        resets += 1;
        return Result.ok(undefined);
      },
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-failure",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "journal-failure",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-failure",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("continued");
            },
          }),
        }),
    });
    const firstId = "github:journal-failure:first";
    const secondId = "github:journal-failure:second";
    const firstDeliveryId = crypto.randomUUID();
    const secondDeliveryId = crypto.randomUUID();
    for (const [requestDeliveryId, requestId, sessionId, content] of [
      [firstDeliveryId, firstId, "journal-failure-first", "first"],
      [secondDeliveryId, secondId, "journal-failure-second", "second"],
    ] as const) {
      transcriptResultValue(
        store.prepare({
          requestDeliveryId,
          requestId,
          envelope: {
            headers: {
              request_id: requestId,
              session_id: sessionId,
              request_client: "github",
            },
            data: {
              requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content }],
            },
          },
          inputHandles: [],
          createdAt: 1,
        }),
      );
    }
    const firstLifecycle = await observeRequestLifecycle(bus, firstId);
    const secondLifecycle = await observeRequestLifecycle(bus, secondId);
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId: firstDeliveryId,
        requestId: firstId,
        sessionId: "journal-failure-first",
        text: "first",
      });
      await expect(firstLifecycle.terminal).resolves.toBe("resolved");
      await publishRunnerRequest({
        bus,
        requestDeliveryId: secondDeliveryId,
        requestId: secondId,
        sessionId: "journal-failure-second",
        text: "second",
      });
      await expect(secondLifecycle.terminal).resolves.toBe("resolved");
      expect(resets).toBe(0);
      expect(modelCalls).toBe(2);
    } finally {
      await firstLifecycle.stop();
      await secondLifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("stops checkpoint writes for each run after a conflict and still marks it terminal", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const journalCalls = {
      open: 0,
      checkpoint: 0,
      reset: 0,
      terminal: 0,
      remove: 0,
    };
    let modelCalls = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        journalCalls.open += 1;
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        });
      },
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.checkpoint += 1;
        return Result.err(
          new AgentRunJournalConflict({
            runId: handle.runId,
            message: "injected checkpoint failure",
          }),
        );
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.terminal += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: (runId: string) => {
        journalCalls.reset += 1;
        return Result.err(
          new AgentRunJournalSqliteFailure({
            operation: `reset ${runId}`,
            code: "SQLITE_IOERR",
            message: "injected reset failure",
          }),
        );
      },
      removeReconciled: () => {
        journalCalls.remove += 1;
        return Result.ok(undefined);
      },
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-reset-failure",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: "journal-reset-failure",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-reset-failure",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("continued without journal");
            },
          }),
        }),
    });
    const requests = [
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "github:journal-reset-failure:first",
        sessionId: "journal-reset-failure-first",
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: "github:journal-reset-failure:second",
        sessionId: "journal-reset-failure-second",
      },
    ] as const;
    for (const [index, request] of requests.entries()) {
      transcriptResultValue(
        store.prepare({
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          envelope: {
            headers: {
              request_id: request.requestId,
              session_id: request.sessionId,
              request_client: "github",
            },
            data: {
              requestDeliveryId: request.requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: `request ${index + 1}` }],
            },
          },
          inputHandles: [],
          createdAt: index + 1,
        }),
      );
    }
    const lifecycles = await Promise.all(
      requests.map((request) => observeRequestLifecycle(bus, request.requestId)),
    );
    try {
      for (const [index, request] of requests.entries()) {
        await publishRunnerRequest({
          bus,
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          text: `request ${index + 1}`,
        });
        await expect(lifecycles[index]!.terminal).resolves.toBe("resolved");
      }
      expect(modelCalls).toBe(2);
      expect(journalCalls.open).toBe(4);
      expect(journalCalls.checkpoint).toBe(2);
      expect(journalCalls.reset).toBe(0);
      expect(journalCalls.terminal).toBe(2);
      expect(journalCalls.remove).toBe(2);
    } finally {
      await Promise.all(lifecycles.map((lifecycle) => lifecycle.stop()));
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("resets a conflicted run only when its current handle cannot be reopened", async () => {
    const failureStage = "reopen" as const;
    const bus = createLilacBus(createInMemoryRawBus());
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const pluginManager = corePrimaryTestPluginManager();
    const journalCalls = { open: 0, checkpoint: 0, reset: 0, terminal: 0 };
    let modelCalls = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) => {
        journalCalls.open += 1;
        if (journalCalls.open === 2) {
          return Result.err(
            new AgentRunJournalConflict({
              runId: owner.requestDeliveryId,
              message: "injected journal reopen failure",
            }),
          );
        }
        return Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        });
      },
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.checkpoint += 1;
        return Result.err(
          new AgentRunJournalConflict({
            runId: handle.runId,
            message: "injected journal checkpoint failure",
          }),
        );
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        journalCalls.terminal += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      resetRun: () => {
        journalCalls.reset += 1;
        return Result.ok(undefined);
      },
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: `journal-bounded-${failureStage}`,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery,
      agentRunJournal: journal,
      issueControlCapability: () => ({
        capability: `journal-bounded-${failureStage}`,
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: `journal-bounded-${failureStage}`,
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("continued without journal");
            },
          }),
        }),
    });
    const requests = [
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: `github:journal-bounded-${failureStage}:first`,
        sessionId: `journal-bounded-${failureStage}-first`,
      },
      {
        requestDeliveryId: crypto.randomUUID(),
        requestId: `github:journal-bounded-${failureStage}:second`,
        sessionId: `journal-bounded-${failureStage}-second`,
      },
    ] as const;
    for (const [index, request] of requests.entries()) {
      transcriptResultValue(
        store.prepare({
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          envelope: {
            headers: {
              request_id: request.requestId,
              session_id: request.sessionId,
              request_client: "github",
            },
            data: {
              requestDeliveryId: request.requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: `request ${index + 1}` }],
            },
          },
          inputHandles: [],
          createdAt: index + 1,
        }),
      );
    }
    const lifecycles = await Promise.all(
      requests.map((request) => observeRequestLifecycle(bus, request.requestId)),
    );
    try {
      for (const [index, request] of requests.entries()) {
        await publishRunnerRequest({
          bus,
          requestDeliveryId: request.requestDeliveryId,
          requestId: request.requestId,
          sessionId: request.sessionId,
          text: `request ${index + 1}`,
        });
        await expect(lifecycles[index]!.terminal).resolves.toBe("resolved");
      }
      expect(modelCalls).toBe(2);
      expect(journalCalls.open).toBe(5);
      expect(journalCalls.checkpoint).toBe(2);
      expect(journalCalls.reset).toBe(1);
      expect(journalCalls.terminal).toBe(2);
    } finally {
      await Promise.all(lifecycles.map((lifecycle) => lifecycle.stop()));
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("reconstructs original and checkpointed work across sessions and skips terminal heads", async () => {
    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const pluginManager = corePrimaryTestPluginManager();
    const observedModelPrompts: string[] = [];
    const bothCalled = deferred<void>();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-reconstruction",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({
        capability: "journal-reconstruction",
        principal: null,
      }),
      createAgent: (options) => {
        const agent = new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-reconstruction",
            doStream: async (call) => {
              observedModelPrompts.push(JSON.stringify(call.prompt));
              if (observedModelPrompts.length === 2) bothCalled.resolve(undefined);
              return level1TextStep("recovered");
            },
          }),
        });
        return agent;
      },
    });
    const original = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:journal-reconstruction:original",
      sessionId: "journal-reconstruction-original",
      queue: "prompt",
      messages: [{ role: "user", content: "original floor" }],
    });
    const checkpointed = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:journal-reconstruction:checkpoint",
      sessionId: "journal-reconstruction-checkpoint",
      queue: "prompt",
      messages: [{ role: "user", content: "stale accepted input" }],
    });
    const terminal = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:journal-reconstruction:terminal",
      sessionId: "journal-reconstruction-terminal",
      queue: "prompt",
      messages: [{ role: "user", content: "must not rerun" }],
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: {
        runId: checkpointed.requestDeliveryId,
        requestId: checkpointed.requestId,
        sessionId: checkpointed.work.sessionId,
        sequence: 2,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [{ role: "user", content: "durable checkpoint" }],
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const terminalHead: AgentRunRecoveryHead = {
      handle: {
        runId: terminal.requestDeliveryId,
        requestId: terminal.requestId,
        sessionId: terminal.work.sessionId,
        sequence: 3,
      },
      state: "terminal",
      terminalOutcome: { kind: "completed" },
      createdAt: 1,
      updatedAt: 3,
    };
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(original));
      transcriptResultValue(await runner.resumeAcceptedDelivery(checkpointed, activeHead));
      transcriptResultValue(await runner.resumeAcceptedDelivery(terminal, terminalHead));
      runner.activate();
      await bothCalled.promise;
      expect(observedModelPrompts).toHaveLength(2);
      expect(observedModelPrompts.some((messages) => messages.includes("original floor"))).toBe(
        true,
      );
      expect(observedModelPrompts.some((messages) => messages.includes("durable checkpoint"))).toBe(
        true,
      );
      expect(
        observedModelPrompts.some((messages) => messages.includes("stale accepted input")),
      ).toBe(false);
      expect(observedModelPrompts.some((messages) => messages.includes("must not rerun"))).toBe(
        false,
      );
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("restores loaded tools from a WAL checkpoint and persists them for the next descendant", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-tool-recovery-"));
    const store = new SqliteTranscriptStore(path.join(dataDir, "transcripts.db"));
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    pluginManager.buildLevel1ToolsetResult = async () => Result.ok(level1TestToolset());
    const offered: string[][] = [];
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "tool-authority-wal-recovery",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      transcriptStore: store,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: () => ({ capability: "tool-authority-recovery", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "tool-authority-wal-recovery",
            doStream: async (modelOptions) => {
              offered.push(level1OfferedToolNames(modelOptions));
              return level1TextStep("recovered");
            },
          }),
        }),
    });

    const sessionId = "tool-authority-recovery";
    const inputMessageId = "recovered-input";
    const recoveredRequestId = `discord:${sessionId}:${inputMessageId}`;
    const recoveredMessages = [
      { role: "user", content: "resume after crash" },
    ] satisfies ModelMessage[];
    const recoveredLineage = buildCoreLineageManifestV2([
      admitPrimarySurface(store, sessionId, inputMessageId, recoveredMessages),
    ]);
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: recoveredRequestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: transcriptResultValue(projectStoredMessagesV1(recoveredMessages)),
      corePrimaryLineage: recoveredLineage,
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "recovery-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: inputMessageId,
          },
        },
      },
    });
    const recoveryHead: AgentRunRecoveryHead = {
      handle: {
        runId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId: accepted.work.sessionId,
        sequence: 2,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: transcriptResultValue(projectStoredMessagesV1(recoveredMessages)),
        corePrimaryLineage: recoveredLineage,
        loadedCatalogIds: ["catalog-id"],
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const recoveredLifecycle = await observeRequestLifecycle(bus, recoveredRequestId);

    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, recoveryHead));
      runner.activate();
      await expect(recoveredLifecycle.terminal).resolves.toBe("resolved");
      await recoveredLifecycle.stop();

      expect(
        getRequestTranscript(store, { requestId: recoveredRequestId })?.loadedCatalogIds,
      ).toEqual(["catalog-id"]);

      const descendantRequestId = "discord:tool-authority-recovery:descendant";
      const descendantMessages = [
        { role: "user", content: "continue after recovery" },
      ] satisfies ModelMessage[];
      const descendantLineage = extendPrimaryManifest({
        store,
        sessionId,
        previous: recoveredLineage,
        completedRequestId: recoveredRequestId,
        outputMessageId: "recovered-output",
        currentMessageId: "descendant-input",
        currentMessages: descendantMessages,
      });
      const descendantLifecycle = await observeRequestLifecycle(bus, descendantRequestId);
      await publishRunnerRequest({
        bus,
        requestId: descendantRequestId,
        sessionId,
        requestClient: "discord",
        text: "continue after recovery",
        messages: descendantLineage.segments.flatMap((segment) => segment.canonicalMessages),
        corePrimaryLineage: descendantLineage,
      });
      await expect(descendantLifecycle.terminal).resolves.toBe("resolved");
      await descendantLifecycle.stop();

      expect(offered).toEqual([
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

  it("reseeds recovery from the previous checkpoint when the latest blob is unavailable", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    let level1RequestContext:
      | Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      | undefined;
    const pluginManager = corePrimaryTestPluginManager((requestContext) => {
      level1RequestContext = requestContext;
    });
    const modelCalled = deferred<void>();
    let observedPrompt = "";
    let observedTools: string[] = [];
    let resets = 0;
    let promotions = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      promotePreviousCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => {
        promotions += 1;
        return Result.ok({ ...handle, sequence: handle.sequence + 1 });
      },
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      loadRecoveryHeads: () => Result.ok({ heads: [], resets: [] }),
      resetRun: () => {
        resets += 1;
        return Result.ok(undefined);
      },
      resetAll: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-previous-checkpoint",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      agentRunJournal: journal,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: () => ({
        capability: "journal-previous-checkpoint",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-previous-checkpoint",
            doStream: async (call) => {
              observedPrompt = JSON.stringify(call.prompt);
              observedTools = level1OfferedToolNames(call);
              modelCalled.resolve(undefined);
              return level1TextStep("recovered previous checkpoint");
            },
          }),
        }),
    });
    const sessionId = "journal-previous-checkpoint";
    const originalMessageId = "accepted-message";
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: `discord:${sessionId}:${originalMessageId}`,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "accepted floor" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "accepted-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: originalMessageId,
          },
        },
      },
    });
    const head: AgentRunRecoveryHead = {
      handle: {
        runId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId: accepted.work.sessionId,
        sequence: 3,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "blob",
                blob: {
                  version: 1,
                  objectId: `b1_${"11".repeat(16)}`,
                  sha256: "22".repeat(32),
                  byteLength: 1,
                },
                mediaType: "image/png",
                filename: "missing.png",
              },
            ],
          },
        ],
        loadedCatalogIds: [],
        retainedRequestDeliveries: [],
      },
      previousCheckpoint: {
        version: 1,
        messages: [{ role: "user", content: "previous safe checkpoint" }],
        loadedCatalogIds: ["catalog-id"],
        currentTurnUserId: "checkpoint-user",
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 3,
    };
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, head));
      runner.activate();
      await modelCalled.promise;
      expect(promotions).toBe(1);
      expect(resets).toBe(0);
      expect(observedPrompt).toContain("previous safe checkpoint");
      expect(observedPrompt).not.toContain("accepted floor");
      expect(observedPrompt).not.toContain("missing.png");
      expect(observedTools).toEqual(["builtin", "find_tools", "deferred_tool"]);
      expect(level1RequestContext).toMatchObject({
        currentTurnUserId: "checkpoint-user",
      });
      expect(level1RequestContext?.currentTurnMessageRef).toBeUndefined();
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("restores the accepted message relation when no recovery checkpoint can be loaded", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    let level1RequestContext:
      | Parameters<CoreToolPluginManager["buildLevel1ToolsetResult"]>[0]["requestContext"]
      | undefined;
    const pluginManager = corePrimaryTestPluginManager((requestContext) => {
      level1RequestContext = requestContext;
    });
    const modelCalled = deferred<void>();
    let observedPrompt = "";
    let resets = 0;
    const journal = {
      openRun: (owner: {
        readonly requestDeliveryId: string;
        readonly requestId: string;
        readonly sessionId: string;
      }) =>
        Result.ok({
          runId: owner.requestDeliveryId,
          requestId: owner.requestId,
          sessionId: owner.sessionId,
          sequence: 1,
        }),
      writeCheckpoint: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      markTerminal: (handle: {
        readonly runId: string;
        readonly requestId: string;
        readonly sessionId: string;
        readonly sequence: number;
      }) => Result.ok({ ...handle, sequence: handle.sequence + 1 }),
      loadRecoveryHeads: () => Result.ok({ heads: [], resets: [] }),
      resetRun: () => {
        resets += 1;
        return Result.ok(undefined);
      },
      resetAll: () => Result.ok(undefined),
      removeReconciled: () => Result.ok(undefined),
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "journal-accepted-fallback",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      agentRunJournal: journal,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: () => ({
        capability: "journal-accepted-fallback",
        principal: null,
      }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "journal-accepted-fallback",
            doStream: async (call) => {
              observedPrompt = JSON.stringify(call.prompt);
              modelCalled.resolve(undefined);
              return level1TextStep("recovered accepted work");
            },
          }),
        }),
    });
    const sessionId = "journal-accepted-fallback";
    const originalMessageId = "accepted-message";
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: `discord:${sessionId}:${originalMessageId}`,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "accepted floor" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "accepted-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: originalMessageId,
          },
        },
      },
    });
    const missingMessage = {
      role: "assistant" as const,
      content: [
        {
          type: "blob" as const,
          blob: {
            version: 1 as const,
            objectId: `b1_${"11".repeat(16)}`,
            sha256: "22".repeat(32),
            byteLength: 1,
          },
          mediaType: "image/png",
          filename: "missing.png",
        },
      ],
    };
    const head: AgentRunRecoveryHead = {
      handle: {
        runId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId,
        sequence: 3,
      },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [missingMessage],
        currentTurnUserId: "latest-checkpoint-user",
        retainedRequestDeliveries: [],
      },
      previousCheckpoint: {
        version: 1,
        messages: [missingMessage],
        currentTurnUserId: "previous-checkpoint-user",
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 3,
    };
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, head));
      runner.activate();
      await modelCalled.promise;
      expect(resets).toBe(1);
      expect(observedPrompt).toContain("accepted floor");
      expect(observedPrompt).not.toContain("missing.png");
      expect(level1RequestContext).toMatchObject({
        currentTurnUserId: "accepted-user",
        currentTurnMessageRef: {
          platform: "discord",
          channelId: sessionId,
          messageId: originalMessageId,
        },
      });
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("restores trusted Discord authority and its live cache owner from durable accepted work", async () => {
    const sessionId = "recovered-authority-session";
    const messageId = "recovered-authority-message";
    const requestId = `discord:${sessionId}:${messageId}`;
    const requestDeliveryId = crypto.randomUUID();
    const requestMessageCache = createRequestMessageCache();
    const bus = createLilacBus(createInMemoryRawBus());
    let issuedSafetyMode: string | undefined;
    let issuedOrigin: AuthenticatedSurfaceOrigin | undefined;
    let cachedOriginAtIssue: ReturnType<typeof requestMessageCache.getOrigin>;
    const pluginManager = corePrimaryTestPluginManager();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "recovered-authority",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: (input) => {
        issuedSafetyMode = input.safetyMode;
        issuedOrigin = input.authenticatedOrigin;
        cachedOriginAtIssue = requestMessageCache.getOrigin(requestId);
        return {
          capability: "recovered-authority",
          principal: input.authenticatedOrigin
            ? {
                platform: input.authenticatedOrigin.platform,
                userId: input.authenticatedOrigin.userId,
              }
            : null,
          authenticatedOrigin: input.authenticatedOrigin ?? null,
          safetyMode: input.safetyMode,
        };
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "recovered-authority",
            doStream: async () => level1TextStep("trusted recovery"),
          }),
        }),
    });
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId,
      requestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "recover trusted authority" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "recovered-authority-user",
          messageRef: { platform: "discord", channelId: sessionId, messageId },
        },
      },
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: { runId: requestDeliveryId, requestId, sessionId, sequence: 2 },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [{ role: "user", content: "durable trusted checkpoint" }],
        currentTurnUserId: "recovered-authority-user",
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, activeHead));
      runner.activate();
      await expect(lifecycle.terminal).resolves.toBe("resolved");

      expect(issuedSafetyMode).toBe("trusted");
      expect(issuedOrigin).toEqual({
        platform: "discord",
        userId: "recovered-authority-user",
        sessionRef: { platform: "discord", channelId: sessionId },
        messageRef: { platform: "discord", channelId: sessionId, messageId },
      });
      expect(cachedOriginAtIssue).toEqual(expect.objectContaining({ requestId, sessionId }));
      expect(requestMessageCache.getOrigin(requestId)).toBeUndefined();
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("keeps recovered Discord work restricted when its durable message proof is invalid", async () => {
    const sessionId = "invalid-recovered-authority-session";
    const requestId = `discord:${sessionId}:expected-message`;
    const requestDeliveryId = crypto.randomUUID();
    const requestMessageCache = createRequestMessageCache();
    const bus = createLilacBus(createInMemoryRawBus());
    let issuedSafetyMode: string | undefined;
    let issuedOrigin: AuthenticatedSurfaceOrigin | undefined;
    const pluginManager = corePrimaryTestPluginManager();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "invalid-recovered-authority",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestMessageCache,
      resolveDiscordSessionContext: () => ({ parentChannelId: null, guildId: null }),
      issueControlCapability: (input) => {
        issuedSafetyMode = input.safetyMode;
        issuedOrigin = input.authenticatedOrigin;
        return {
          capability: "invalid-recovered-authority",
          principal: null,
          authenticatedOrigin: input.authenticatedOrigin ?? null,
          safetyMode: input.safetyMode,
        };
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "invalid-recovered-authority",
            doStream: async () => level1TextStep("restricted recovery"),
          }),
        }),
    });
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId,
      requestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "reject invalid durable authority" }],
      raw: {
        authenticatedOrigin: {
          platform: "discord",
          userId: "invalid-recovered-authority-user",
          messageRef: {
            platform: "discord",
            channelId: sessionId,
            messageId: "different-message",
          },
        },
      },
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: { runId: requestDeliveryId, requestId, sessionId, sequence: 2 },
      state: "active",
      checkpoint: {
        version: 1,
        messages: [{ role: "user", content: "durable restricted checkpoint" }],
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, activeHead));
      runner.activate();
      await expect(lifecycle.terminal).resolves.toBe("resolved");

      expect(issuedSafetyMode).toBe("restricted");
      expect(issuedOrigin).toBeUndefined();
      expect(requestMessageCache.getOrigin(requestId)).toBeUndefined();
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await requestMessageCache.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("recovers a Core-primary Claude WAL checkpoint without resuming the crash-left native attempt", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-primary-wal-recovery-"));
    const dbPath = path.join(dataDir, "transcripts.db");
    const sessionId = "primary-wal-recovery";
    const requestId = "discord:primary-wal-recovery:input";
    const requestDeliveryId = crypto.randomUUID();
    const crashedCandidateSessionId = crypto.randomUUID();
    const portableMessages = [
      { role: "user", content: "portable WAL checkpoint" },
    ] satisfies ModelMessage[];
    const firstStore = new SqliteTranscriptStore(dbPath);
    const lineage = buildCoreLineageManifestV2([
      admitPrimarySurface(firstStore, sessionId, "portable-input", portableMessages),
    ]);
    attemptMutationValue(
      firstStore.reserveCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        executionScopeHashVersion: 1,
        executionScopeHash: "crash-left-scope",
        requestId,
        attemptIndex: 0,
        candidateSessionId: crashedCandidateSessionId,
        sourceSessionId: null,
        expectedBindingRevision: null,
      }),
    );
    firstStore.close();

    const store = new SqliteTranscriptStore(dbPath);
    expect(
      store.getCorePrimaryClaudeSessionAttempt({
        providerId: "claude-code",
        requestClient: "discord",
        lilacSessionId: sessionId,
        requestId,
        attemptIndex: 0,
      })?.state,
    ).toBe("uncertain");

    const rawBus = createInMemoryRawBus();
    const bus = createLilacBus(rawBus);
    const pluginManager = corePrimaryTestPluginManager();
    const starts: ClaudeNativeSessionStart[] = [];
    const modelPrompts: ModelMessage[][] = [];
    const config = parseCoreConfigV2ToUniversal({});
    config.models.main = { model: "claude-code/sonnet", fallback: [] };
    config.agent.retry = {
      enabled: false,
      maxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
    };
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "primary-wal-recovery",
      startPaused: true,
      reportFatalPanic: () => undefined,
      config,
      pluginManager,
      cwd: dataDir,
      transcriptStore: store,
      issueControlCapability: () => ({
        capability: "primary-wal-recovery",
        principal: null,
      }),
      materializeClaudeCodeRun: async (options) => {
        const start = options.nativeSession;
        if (!start || start.mode === "ephemeral") {
          throw new Error("expected persistent Claude start");
        }
        starts.push(start);
        const observation: ClaudeNativeAttemptObservation = {
          requestedSessionId: start.sessionId,
          sourceSessionId: start.mode === "fork" ? start.baseSessionId : null,
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
        const model = new MockLanguageModelV4({
          modelId: options.modelId,
          doStream: async (call) => {
            modelPrompts.push([...call.prompt]);
            return level1TextStep("recovered from portable checkpoint");
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
    });
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId,
      requestId,
      sessionId,
      requestClient: "discord",
      queue: "prompt",
      messages: [{ role: "user", content: "stale accepted input" }],
      corePrimaryLineage: lineage,
    });
    const activeHead: AgentRunRecoveryHead = {
      handle: { runId: requestDeliveryId, requestId, sessionId, sequence: 2 },
      state: "active",
      checkpoint: {
        version: 1,
        messages: transcriptResultValue(projectStoredMessagesV1(portableMessages)),
        corePrimaryLineage: lineage,
        retainedRequestDeliveries: [],
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const lifecycle = await observeRequestLifecycle(bus, requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, activeHead));
      runner.activate();
      await expect(lifecycle.terminal).resolves.toBe("resolved");

      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ mode: "fresh" });
      if (!starts[0] || starts[0].mode === "ephemeral") {
        throw new Error("recovered Claude start is missing");
      }
      expect(starts[0].sessionId).not.toBe(crashedCandidateSessionId);
      expect(JSON.stringify(modelPrompts)).toContain("portable WAL checkpoint");
      expect(JSON.stringify(modelPrompts)).not.toContain("stale accepted input");
      expect(
        store.getCorePrimaryClaudeSessionAttempt({
          providerId: "claude-code",
          requestClient: "discord",
          lilacSessionId: sessionId,
          requestId,
          attemptIndex: 0,
        })?.state,
      ).toBe("uncertain");
      expect(
        store.getCorePrimaryClaudeSessionAttempt({
          providerId: "claude-code",
          requestClient: "discord",
          lilacSessionId: sessionId,
          requestId,
          attemptIndex: 2,
        }),
      ).toMatchObject({
        attemptIndex: 2,
        candidateSessionId: starts[0].sessionId,
      });
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("native output runner durability", () => {
  it.each(["paragraph", "complete"] as const)(
    "publishes semantic %s output and suppresses NO_REPLY",
    async (mode) => {
      for (const answer of ["First\n\nLast", "NO_REPLY"]) {
        const bus = createLilacBus(createInMemoryRawBus());
        const pluginManager = corePrimaryTestPluginManager();
        const settled = deferred<void>();
        const events: NativeOutputEvent[] = [];
        const nativeTranscripts = new SqliteTranscriptStore(":memory:");
        const runner = await startBusAgentRunner({
          bus,
          pluginManager,
          transcriptStore: nativeTranscripts,
          config: parseCoreConfigV2ToUniversal({}),
          subscriptionId: `native-${mode}-${answer}`,
          nativeExecution: {
            validate: () => Result.ok({ safetyMode: "restricted" }),
            settled: async () => Result.ok(undefined),
          },
          reportFatalPanic: (panic) => {
            throw panic;
          },
          onRequestSettled: () => settled.resolve(undefined),
          issueControlCapability: () => ({ capability: "native-test", principal: null }),
          createNativeOutput: ({ requestId }) =>
            createNativeOutputPublisher({
              requestId,
              threadId: "thread",
              turnId: "turn",
              generation: 0,
              attemptId: "attempt",
              mode,
              publish: async (event) => {
                events.push(event);
                return Result.ok(undefined);
              },
            }),
          createAgent: (options) =>
            new AiSdkPiAgent({
              ...options,
              model: new MockLanguageModelV4({
                modelId: "native-output",
                doStream: async () => {
                  settled.resolve(undefined);
                  return level1TextStep(answer);
                },
              }),
            }),
        });
        try {
          const requestDeliveryId = crypto.randomUUID();
          await publishRunnerRequest({
            bus,
            requestDeliveryId,
            requestId: "native:output:test",
            sessionId: "native:output",
            requestClient: "native",
            text: "answer",
            raw: {
              authenticatedActor: { platform: "native", userId: "starter" },
              authenticatedOrigin: {
                platform: "native",
                userId: "starter",
                messageRef: { platform: "native", channelId: "output", messageId: "test" },
              },
              native: {
                requestId: "native:output:test",
                requestDeliveryId,
                threadId: "output",
                authorUserId: "author",
                starterUserId: "starter",
                turnId: "turn",
                inputId: "test",
                historyGeneration: 0,
              },
            },
          });
          await settled.promise;
          await runner.waitForIdle();
          const chunks = events.flatMap((event) =>
            event.payload.type === "text" ? [event.payload.text] : [],
          );
          const expected =
            answer === "NO_REPLY" ? [] : mode === "paragraph" ? ["First\n\n", "Last"] : [answer];
          expect(chunks).toEqual(expected);
          expect(events.at(-1)?.payload).toEqual({ type: "terminal", state: "complete" });
          const canonical = transcriptResultValue(
            nativeTranscripts.getRequestTranscript({ requestId: "native:output:test" }),
          );
          expect(
            canonical?.messages.some(
              (message) =>
                message.role === "user" && JSON.stringify(message.content).includes("answer"),
            ),
          ).toBe(true);
        } finally {
          await runner.stop();
          nativeTranscripts.close();
          await pluginManager.destroy();
          await bus.close();
        }
      }
    },
  );

  it("keeps output-bearing WAL checkpoints and terminal markers behind durable native publication", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const settled = deferred<void>();
    const attempted = deferred<void>();
    const release = deferred<void>();
    const checkpoints: AgentRunCheckpointV1[] = [];
    let terminals = 0;
    let outputDurable = false;
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const runner = await startBusAgentRunner({
      requestDelivery,
      bus,
      pluginManager,
      config: parseCoreConfigV2ToUniversal({}),
      subscriptionId: "native-output-barrier",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      onRequestSettled: () => settled.resolve(undefined),
      issueControlCapability: () => ({ capability: "native-test", principal: null }),
      agentRunJournal: {
        openRun: (owner) =>
          Result.ok({
            runId: owner.requestDeliveryId,
            requestId: owner.requestId,
            sessionId: owner.sessionId,
            sequence: 1,
          }),
        writeCheckpoint: (handle, checkpoint) => {
          if (JSON.stringify(checkpoint.messages).includes("visible answer"))
            expect(outputDurable).toBe(true);
          checkpoints.push(checkpoint);
          return Result.ok({ ...handle, sequence: handle.sequence + 1 });
        },
        markTerminal: (handle) => {
          terminals += 1;
          expect(outputDurable).toBe(true);
          return Result.ok({ ...handle, sequence: handle.sequence + 1 });
        },
        resetRun: () => Result.ok(undefined),
        removeReconciled: () => Result.ok(undefined),
      },
      createNativeOutput: ({ requestId }) =>
        createNativeOutputPublisher({
          requestId,
          threadId: "thread",
          turnId: "turn",
          generation: 0,
          attemptId: "attempt",
          mode: "complete",
          publish: async () => {
            attempted.resolve(undefined);
            await release.promise;
            outputDurable = true;
            return Result.ok(undefined);
          },
        }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "native-output",
            doStream: async () => {
              settled.resolve(undefined);
              return level1TextStep("visible answer");
            },
          }),
        }),
    });
    try {
      const requestDeliveryId = crypto.randomUUID();
      transcriptResultValue(
        store.prepare({
          requestDeliveryId,
          requestId: "github:native-barrier:test",
          inputHandles: [],
          createdAt: 1,
          envelope: {
            headers: {
              request_id: "github:native-barrier:test",
              session_id: "native-barrier",
              request_client: "github",
            },
            data: {
              requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: "answer" }],
            },
          },
        }),
      );
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId: "github:native-barrier:test",
        sessionId: "native-barrier",
        text: "answer",
      });
      await attempted.promise;
      expect(
        checkpoints.some((checkpoint) =>
          JSON.stringify(checkpoint.messages).includes("visible answer"),
        ),
      ).toBe(false);
      expect(terminals).toBe(0);
      release.resolve(undefined);
      await settled.promise;
      await runner.waitForIdle();
      expect(
        checkpoints.some((checkpoint) =>
          JSON.stringify(checkpoint.messages).includes("visible answer"),
        ),
      ).toBe(true);
      expect(terminals).toBe(1);
    } finally {
      release.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });

  it("retains the previous WAL boundary and omits terminal markers after native publication failure", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const settled = deferred<void>();
    const checkpoints: AgentRunCheckpointV1[] = [];
    let terminals = 0;
    const store = new SqliteRequestDeliveryStore({
      dbPath: ":memory:",
      codecs: coreRequestDeliveryCodecs,
    });
    const requestDelivery = new RequestDeliveryCoordinator({
      store,
      blobStore: TEST_BLOB_STORE,
      admission: createCoreRequestDeliveryAdmission(TEST_BLOB_STORE),
    });
    const runner = await startBusAgentRunner({
      requestDelivery,
      bus,
      pluginManager,
      config: parseCoreConfigV2ToUniversal({}),
      subscriptionId: "native-output-failure",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      onRequestSettled: () => settled.resolve(undefined),
      issueControlCapability: () => ({ capability: "native-test", principal: null }),
      agentRunJournal: {
        openRun: (owner) =>
          Result.ok({
            runId: owner.requestDeliveryId,
            requestId: owner.requestId,
            sessionId: owner.sessionId,
            sequence: 1,
          }),
        writeCheckpoint: (handle, checkpoint) => {
          checkpoints.push(checkpoint);
          return Result.ok({ ...handle, sequence: handle.sequence + 1 });
        },
        markTerminal: (handle) => {
          terminals += 1;
          return Result.ok({ ...handle, sequence: handle.sequence + 1 });
        },
        resetRun: () => Result.ok(undefined),
        removeReconciled: () => Result.ok(undefined),
      },
      createNativeOutput: ({ requestId }) =>
        createNativeOutputPublisher({
          requestId,
          threadId: "thread",
          turnId: "turn",
          generation: 0,
          attemptId: "attempt",
          mode: "complete",
          publish: async () =>
            Result.err(new NativeOutputPublishFailed({ message: "unavailable" })),
        }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "native-output",
            doStream: async () => {
              settled.resolve(undefined);
              return level1TextStep("visible answer");
            },
          }),
        }),
    });
    try {
      const requestDeliveryId = crypto.randomUUID();
      transcriptResultValue(
        store.prepare({
          requestDeliveryId,
          requestId: "github:native-failure:test",
          inputHandles: [],
          createdAt: 1,
          envelope: {
            headers: {
              request_id: "github:native-failure:test",
              session_id: "native-failure",
              request_client: "github",
            },
            data: {
              requestDeliveryId,
              queue: "prompt",
              messages: [{ role: "user", content: "answer" }],
            },
          },
        }),
      );
      await publishRunnerRequest({
        bus,
        requestDeliveryId,
        requestId: "github:native-failure:test",
        sessionId: "native-failure",
        text: "answer",
      });
      await settled.promise;
      await runner.waitForIdle();
      expect(
        checkpoints.some((checkpoint) =>
          JSON.stringify(checkpoint.messages).includes("visible answer"),
        ),
      ).toBe(false);
      expect(terminals).toBe(0);
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      store.close();
      await bus.close();
    }
  });
});

describe("native output WAL recovery frontier", () => {
  it("passes the recovered frontier to publication before resuming provider work", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const started = deferred<void>();
    const nativeEvents: NativeOutputEvent[] = [];
    let observedFrontier: { ordinal: number; position: number } | undefined;
    const runner = await startBusAgentRunner({
      bus,
      pluginManager,
      startPaused: true,
      subscriptionId: "native-frontier-recovery",
      config: parseCoreConfigV2ToUniversal({}),
      reportFatalPanic: (panic) => {
        throw panic;
      },
      issueControlCapability: () => ({ capability: "native-frontier", principal: null }),
      createNativeOutput: ({ requestId, recoveryOutputFrontier }) => {
        observedFrontier = recoveryOutputFrontier;
        return createNativeOutputPublisher({
          requestId,
          threadId: "thread",
          turnId: "turn",
          generation: 0,
          attemptId: "new-attempt",
          previousAttemptId: "old-attempt",
          recoveryFrontier: recoveryOutputFrontier,
          mode: "complete",
          publish: async (event) => {
            nativeEvents.push(event);
            return Result.ok(undefined);
          },
        });
      },
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "native-frontier",
            doStream: async () => {
              started.resolve(undefined);
              return level1TextStep("resumed");
            },
          }),
        }),
    });
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:frontier:request",
      sessionId: "frontier",
      queue: "prompt",
      messages: [{ role: "user", content: "continue" }],
    });
    const head: AgentRunRecoveryHead = {
      handle: {
        runId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId: accepted.work.sessionId,
        sequence: 2,
      },
      state: "active",
      createdAt: 1,
      updatedAt: 2,
      checkpoint: {
        version: 1,
        messages: [{ role: "user", content: "continue" }],
        retainedRequestDeliveries: [],
        nativeOutput: { ordinal: 17, position: 9 },
      },
    };
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted, head));
      runner.activate();
      await started.promise;
      await runner.waitForIdle();
      expect(observedFrontier).toEqual({ ordinal: 17, position: 9 });
      expect(nativeEvents[0]?.ordinal).toBe(18);
      expect(nativeEvents[0]?.payload).toEqual({
        type: "reset",
        previousAttemptId: "old-attempt",
        retainThroughOrdinal: 17,
      });
      const firstText = nativeEvents.find((event) => event.payload.type === "text");
      expect(firstText?.payload).toMatchObject({ type: "text", position: 10 });
    } finally {
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
});
