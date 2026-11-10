import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createLilacBus, type StoredMessageV1 } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { jsonSchema, tool, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Panic, Result } from "better-result";
import { createMemoryBlobStore, type BlobStore } from "@stanley2058/lilac-blob-storage";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import {
  mergeToSingleUserMessage,
  shouldCancelRunPolicyRequest,
  shouldCancelIdleOnlyGlobalRequest,
  type BusAgentRunnerRequestDelivery,
} from "../../../src/surface/bridge/bus-agent-runner";
import { CustomCommandManager } from "../../../src/custom-commands/manager";
import type { JobService } from "../../../src/jobs/job-service";
import { ResourceNotFound } from "../../../src/resource/errors";
import type { ResourceAccess } from "../../../src/resource/service";
import {
  TEST_BLOB_STORE,
  startBusAgentRunner,
  transcriptResultValue,
  level1TextStep,
  level1ToolCallStep,
  createInMemoryRawBus,
  deferred,
  observeRequestLifecycle,
  publishRunnerRequest,
  acceptedRunnerDelivery,
  corePrimaryTestPluginManager,
} from "./bus-agent-runner-test-support";
import { useTestBlobStore } from "./bus-agent-runner-test-support";

useTestBlobStore();

describe("session queue admission", () => {
  function gatedBlobStore() {
    const gate = deferred<void>();
    const opened = deferred<void>();
    const store = new Proxy(TEST_BLOB_STORE, {
      get(target, property, receiver) {
        if (property !== "open") {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: Parameters<BlobStore["open"]>) => {
          opened.resolve(undefined);
          await gate.promise;
          return target.open(...args);
        };
      },
    });
    return { store, gate, opened };
  }

  async function uploadedBlobMessage(text: string): Promise<StoredMessageV1> {
    const uploaded = transcriptResultValue(
      await TEST_BLOB_STORE.startUpload({
        source: new TextEncoder().encode(text),
        retention: { kind: "durable" },
      }),
    );
    const reference = transcriptResultValue(await uploaded.completion);
    return {
      role: "user",
      content: [
        { type: "text", text },
        { type: "blob", blob: reference, mediaType: "text/plain", filename: "note.txt" },
      ],
    };
  }

  it("queues a new request while a recovered run is still materializing", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const blobs = gatedBlobStore();
    const modelCalls: string[] = [];
    const runner = await startBusAgentRunner({
      bus,
      blobStore: blobs.store,
      subscriptionId: "materializing-admission",
      startPaused: true,
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "materializing-admission", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "materializing-admission",
            doStream: async ({ prompt }) => {
              modelCalls.push(JSON.stringify(prompt).includes("recovered work") ? "A" : "B");
              return level1TextStep("done");
            },
          }),
        }),
    });
    const sessionId = "materializing-admission";
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:materializing-admission:a",
      sessionId,
      queue: "prompt",
      messages: [await uploadedBlobMessage("recovered work")],
    });
    const lifecycleA = await observeRequestLifecycle(bus, accepted.requestId);
    const lifecycleB = await observeRequestLifecycle(bus, "github:materializing-admission:b");
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted));
      runner.activate();
      await blobs.opened.promise;
      await publishRunnerRequest({
        bus,
        requestId: "github:materializing-admission:b",
        sessionId,
        text: "new request",
      });
      await expect(lifecycleB.first).resolves.toBe("queued");
      blobs.gate.resolve(undefined);
      await expect(lifecycleA.terminal).resolves.toBe("resolved");
      await expect(lifecycleB.terminal).resolves.toBe("resolved");
      expect(modelCalls).toEqual(["A", "B"]);
    } finally {
      blobs.gate.resolve(undefined);
      await lifecycleA.stop();
      await lifecycleB.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("keeps recovered work queued when its materialization outlives the drain deadline", async () => {
    const bus = createLilacBus(createInMemoryRawBus({ waitForActiveHandlersOnStop: true }));
    const pluginManager = corePrimaryTestPluginManager();
    const blobs = gatedBlobStore();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      blobStore: blobs.store,
      subscriptionId: "materializing-drain",
      startPaused: true,
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "materializing-drain", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "materializing-drain",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("should not run");
            },
          }),
        }),
    });
    const sessionId = "materializing-drain";
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:materializing-drain:a",
      sessionId,
      queue: "prompt",
      messages: [await uploadedBlobMessage("recovered work")],
    });
    const lifecycle = await observeRequestLifecycle(bus, accepted.requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(accepted));
      runner.activate();
      await blobs.opened.promise;
      await runner.beginDrain({ deadlineMs: 20 });
      blobs.gate.resolve(undefined);
      await runner.waitForIdle();
      expect(modelCalls).toBe(0);
      expect(runner.isSessionBusy(sessionId)).toBe(true);
      expect(lifecycle.states).not.toContain("resolved");
      expect(lifecycle.states).not.toContain("failed");
    } finally {
      blobs.gate.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("does not start the model when run setup outlives the drain deadline", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const setupEntered = deferred<void>();
    const releaseSetup = deferred<void>();
    let modelCalls = 0;
    let pendingJobEvents = true;
    const jobs = {
      noteUserInput: () => undefined,
      subscribe: () => () => undefined,
      hasPendingEvents: () => pendingJobEvents,
      pendingEvents: async () => {
        pendingJobEvents = false;
        setupEntered.resolve(undefined);
        await releaseSetup.promise;
        return [];
      },
      acknowledgeEvents: () => undefined,
      hasActiveAwait: () => false,
      stopAwaitJobs: async () => undefined,
      onRunSettled: async () => undefined,
    } as unknown as JobService;
    const runner = await startBusAgentRunner({
      bus,
      jobs,
      subscriptionId: "setup-drain",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "setup-drain", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "setup-drain",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("should not run");
            },
          }),
        }),
    });
    const lifecycle = await observeRequestLifecycle(bus, "github:setup-drain:request");
    try {
      await publishRunnerRequest({
        bus,
        requestId: "github:setup-drain:request",
        sessionId: "setup-drain",
        text: "request",
      });
      await setupEntered.promise;
      await runner.beginDrain({ deadlineMs: 20 });
      releaseSetup.resolve(undefined);
      await runner.waitForIdle();
      expect(modelCalls).toBe(0);
      expect(lifecycle.states).not.toContain("resolved");
      expect(lifecycle.states).not.toContain("failed");
    } finally {
      releaseSetup.resolve(undefined);
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("aborts the active run at the drain deadline while a bus handler blocks shutdown", async () => {
    const bus = createLilacBus(createInMemoryRawBus({ waitForActiveHandlersOnStop: true }));
    const pluginManager = corePrimaryTestPluginManager();
    const firstStarted = deferred<void>();
    const firstAborted = deferred<void>();
    const intakeEntered = deferred<void>();
    const releaseIntake = deferred<void>();
    let intakeReleased = false;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "drain-blocked-subscription",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      beforeRequestIntake: async (message) => {
        if (message.headers?.request_id !== "github:drain-blocked-subscription:second") return;
        intakeEntered.resolve(undefined);
        await releaseIntake.promise;
      },
      issueControlCapability: () => ({ capability: "drain-blocked-subscription", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "drain-blocked-subscription",
            doStream: async ({ abortSignal }) => {
              firstStarted.resolve(undefined);
              await new Promise<void>((resolve) => {
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
              firstAborted.resolve(undefined);
              throw abortSignal?.reason ?? new Error("aborted");
            },
          }),
        }),
    });
    try {
      await publishRunnerRequest({
        bus,
        requestId: "github:drain-blocked-subscription:first",
        sessionId: "drain-blocked-subscription:first",
        text: "first request",
      });
      await firstStarted.promise;
      const published = publishRunnerRequest({
        bus,
        requestId: "github:drain-blocked-subscription:second",
        sessionId: "drain-blocked-subscription:second",
        text: "second request",
      });
      await intakeEntered.promise;
      await runner.beginDrain({ deadlineMs: 20 });
      await firstAborted.promise;
      expect(intakeReleased).toBe(false);
      intakeReleased = true;
      releaseIntake.resolve(undefined);
      await published;
    } finally {
      releaseIntake.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("fails recovered work whose messages cannot load and runs the next request", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const terminalized: Array<{ requestDeliveryId: string; kind: string; code?: string }> = [];
    const settled: string[] = [];
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "unmaterializable-recovery",
      startPaused: true,
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery: {
        handleDelivery: async () => {
          throw new Error("handleDelivery is not used by recovery");
        },
        replaceAcceptedWork: () => {
          throw new Error("replaceAcceptedWork is not used by recovery");
        },
        terminalize: async (input: {
          requestDeliveryId: string;
          outcome: { kind: string; code?: string };
        }) => {
          terminalized.push({
            requestDeliveryId: input.requestDeliveryId,
            kind: input.outcome.kind,
            code: input.outcome.code,
          });
          return Result.ok(undefined);
        },
      } as unknown as BusAgentRunnerRequestDelivery,
      onRequestSettled: (requestDeliveryId) => settled.push(requestDeliveryId),
      issueControlCapability: () => ({ capability: "unmaterializable", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "unmaterializable-recovery",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("next request ran");
            },
          }),
        }),
    });
    const sessionId = "unmaterializable-recovery";
    const broken = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:unmaterializable-recovery:broken",
      sessionId,
      queue: "prompt",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "blob",
              blob: {
                version: 1,
                objectId: `b1_${"33".repeat(16)}`,
                sha256: "44".repeat(32),
                byteLength: 1,
              },
              mediaType: "text/plain",
              filename: "missing.txt",
            },
          ],
        },
      ],
    });
    const following = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:unmaterializable-recovery:following",
      sessionId,
      queue: "prompt",
      messages: [{ role: "user", content: "run after the broken request" }],
    });
    const brokenLifecycle = await observeRequestLifecycle(bus, broken.requestId);
    const followingLifecycle = await observeRequestLifecycle(bus, following.requestId);
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(broken));
      transcriptResultValue(await runner.resumeAcceptedDelivery(following));
      runner.activate();
      await expect(brokenLifecycle.terminal).resolves.toBe("failed");
      await expect(followingLifecycle.terminal).resolves.toBe("resolved");
      expect(modelCalls).toBe(1);
      expect(terminalized).toContainEqual({
        requestDeliveryId: broken.requestDeliveryId,
        kind: "failed",
        code: "stored-message-materialization-failed",
      });
      expect(settled).toContain(broken.requestDeliveryId);
    } finally {
      await brokenLifecycle.stop();
      await followingLifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("leaves work accepted during drain for the next start to recover", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const intakeEntered = deferred<void>();
    const releaseIntake = deferred<void>();
    const terminalized: string[] = [];
    let modelCalls = 0;
    const sessionId = "drain-admission";
    const accepted = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId: "github:drain-admission:request",
      sessionId,
      queue: "prompt",
      messages: [{ role: "user", content: "arrived during shutdown" }],
    });
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "drain-admission",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery: {
        handleDelivery: async () =>
          Result.ok({ disposition: "accepted", record: accepted, source: "new" }),
        replaceAcceptedWork: () => {
          throw new Error("replaceAcceptedWork is not used during drain");
        },
        terminalize: async (input: { requestDeliveryId: string }) => {
          terminalized.push(input.requestDeliveryId);
          return Result.ok(undefined);
        },
      } as unknown as BusAgentRunnerRequestDelivery,
      beforeRequestIntake: async () => {
        intakeEntered.resolve(undefined);
        await releaseIntake.promise;
      },
      issueControlCapability: () => ({ capability: "drain-admission", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "drain-admission",
            doStream: async () => {
              modelCalls += 1;
              return level1TextStep("should not run");
            },
          }),
        }),
    });
    try {
      const published = publishRunnerRequest({
        bus,
        requestDeliveryId: accepted.requestDeliveryId,
        requestId: accepted.requestId,
        sessionId,
        text: "arrived during shutdown",
      });
      await intakeEntered.promise;
      const drained = runner.beginDrain({ deadlineMs: 1_000 });
      releaseIntake.resolve(undefined);
      await Promise.all([published, drained]);
      expect(terminalized).toEqual([]);
      expect(modelCalls).toBe(0);
    } finally {
      releaseIntake.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("finishes the active run during drain without starting queued work", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const modelCalls: string[] = [];
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "drain-queued",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "drain-queued", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "drain-queued",
            doStream: async ({ prompt }) => {
              const first = JSON.stringify(prompt).includes("first request");
              modelCalls.push(first ? "first" : "queued");
              if (first) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              }
              return level1TextStep("done");
            },
          }),
        }),
    });
    const sessionId = "drain-queued";
    const firstLifecycle = await observeRequestLifecycle(bus, "github:drain-queued:first");
    const queuedLifecycle = await observeRequestLifecycle(bus, "github:drain-queued:queued");
    try {
      await publishRunnerRequest({
        bus,
        requestId: "github:drain-queued:first",
        sessionId,
        text: "first request",
      });
      await firstStarted.promise;
      await publishRunnerRequest({
        bus,
        requestId: "github:drain-queued:queued",
        sessionId,
        text: "queued request",
      });
      await expect(queuedLifecycle.first).resolves.toBe("queued");
      const drained = runner.beginDrain({ deadlineMs: 60_000 });
      releaseFirst.resolve(undefined);
      await drained;
      await expect(firstLifecycle.terminal).resolves.toBe("resolved");
      expect(modelCalls).toEqual(["first"]);
      expect(queuedLifecycle.states).toEqual(["queued"]);
      expect(runner.getActiveLevel1Work()).toEqual([]);
    } finally {
      releaseFirst.resolve(undefined);
      await firstLifecycle.stop();
      await queuedLifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });

  it("waits for a finalizing native run when another drain starts during its cleanup", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const settleEntered = deferred<void>();
    const releaseSettle = deferred<void>();
    const secondStarted = deferred<void>();
    let settles = 0;
    const jobs = {
      noteUserInput: () => undefined,
      subscribe: () => () => undefined,
      hasPendingEvents: () => false,
      hasActiveAwait: () => false,
      stopAwaitJobs: async () => undefined,
      onRunSettled: async () => {
        settles += 1;
        if (settles > 1) return;
        settleEntered.resolve(undefined);
        await releaseSettle.promise;
      },
    } as unknown as NonNullable<Parameters<typeof startBusAgentRunner>[0]["jobs"]>;
    const runner = await startBusAgentRunner({
      bus,
      blobStore: transcriptResultValue(await createMemoryBlobStore()),
      pluginManager,
      jobs,
      config: parseCoreConfigV2ToUniversal({}),
      subscriptionId: "native-finalizing-drain",
      startPaused: true,
      reportFatalPanic: (panic) => {
        throw panic;
      },
      nativeExecution: {
        validate: () => Result.ok({ safetyMode: "restricted" }),
        settled: async () => Result.ok(undefined),
      },
      issueControlCapability: () => ({ capability: "native-finalizing", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "native-finalizing",
            doStream: async ({ prompt, abortSignal }) => {
              if (JSON.stringify(prompt).includes("first native request")) {
                return level1TextStep("first done");
              }
              secondStarted.resolve(undefined);
              await new Promise<void>((resolve) => {
                abortSignal?.addEventListener("abort", () => resolve(), { once: true });
              });
              throw Object.assign(new Error("cancelled"), { name: "AbortError" });
            },
          }),
        }),
    });
    const sessionId = "native:finalizing";
    const nativeDelivery = (name: string, text: string) =>
      acceptedRunnerDelivery({
        requestDeliveryId: crypto.randomUUID(),
        requestId: `native:finalizing:${name}`,
        sessionId,
        queue: "prompt",
        messages: [{ role: "user", content: text }],
      });
    const first = nativeDelivery("first", "first native request");
    const second = nativeDelivery("second", "second native request");
    try {
      transcriptResultValue(await runner.resumeAcceptedDelivery(first));
      runner.activate();
      await settleEntered.promise;
      transcriptResultValue(await runner.resumeAcceptedDelivery(second));
      await secondStarted.promise;
      const cancelled = runner.cancelNativeSession(sessionId);
      const early = await Promise.race([
        cancelled.then(() => "returned" as const),
        new Promise<"waiting">((resolve) => setImmediate(() => resolve("waiting"))),
      ]);
      releaseSettle.resolve(undefined);
      transcriptResultValue(await cancelled);
      expect(early).toBe("waiting");
    } finally {
      releaseSettle.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("stops within the caller's deadline while terminal cleanup hangs", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "lilac-runner-stop-deadline-"));
    const commandDir = path.join(dataDir, "cmds", "panic");
    await mkdir(commandDir, { recursive: true });
    await writeFile(
      path.join(commandDir, "def.json"),
      JSON.stringify({ name: "panic", description: "Raise a test Panic" }),
      "utf8",
    );
    await writeFile(
      path.join(commandDir, "index.ts"),
      "export async function execute() { return { type: 'json', value: null }; }\n",
      "utf8",
    );
    const customCommands = new CustomCommandManager(dataDir);
    const customCommandsInit = await customCommands.init();
    if (customCommandsInit.status === "error") throw customCommandsInit.error;
    const panic = new Panic({ message: "custom command invariant failed" });
    customCommands.execute = async () => {
      throw panic;
    };
    const cleanupStarted = deferred<void>();
    const pluginManager = corePrimaryTestPluginManager();
    const bus = createLilacBus(createInMemoryRawBus());
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "stop-deadline",
      reportFatalPanic: () => undefined,
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      customCommands,
      issueControlCapability: () => ({ capability: "stop-deadline", principal: null }),
      expireControlCapability: () => {
        cleanupStarted.resolve(undefined);
        return new Promise<never>(() => undefined);
      },
      createAgent: () => {
        throw new Error("custom command Panic must stop before agent creation");
      },
    });
    try {
      await publishRunnerRequest({
        bus,
        requestId: "github:stop-deadline:request",
        sessionId: "stop-deadline",
        text: "/lilac:panic",
        raw: {
          customCommand: { name: "panic", args: [], text: "/lilac:panic", source: "text" },
        },
      });
      await cleanupStarted.promise;
      const startedAt = performance.now();
      await runner.stop({ deadlineAtMs: Date.now() + 50 }).catch((cause: unknown) => {
        expect(cause).toBe(panic);
      });
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await pluginManager.destroy();
      await bus.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  it("stops within the caller's deadline while the subscription stop hangs", async () => {
    const baseBus = createLilacBus(createInMemoryRawBus());
    const stopRequested = deferred<void>();
    const bus: typeof baseBus = {
      ...baseBus,
      subscribeTopic: async (topic, opts, handler, deliveryPolicy) => {
        const started = await baseBus.subscribeTopic(topic, opts, handler, deliveryPolicy);
        return started.map((subscription) => ({
          done: subscription.done,
          stop: () => {
            stopRequested.resolve(undefined);
            return new Promise<never>(() => undefined);
          },
        }));
      },
    };
    const pluginManager = corePrimaryTestPluginManager();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "stop-subscription-deadline",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "stop-subscription-deadline", principal: null }),
      createAgent: () => {
        throw new Error("no request is published");
      },
    });
    try {
      const startedAt = performance.now();
      await runner.stop({ deadlineAtMs: Date.now() + 50 });
      await stopRequested.promise;
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await pluginManager.destroy();
      await baseBus.close();
    }
  });
  it("reports a subscription stop panic that lands after the deadline", async () => {
    const baseBus = createLilacBus(createInMemoryRawBus());
    const failStop = deferred<void>();
    const panic = new Panic({ message: "subscription stop invariant failed" });
    const bus: typeof baseBus = {
      ...baseBus,
      subscribeTopic: async (topic, opts, handler, deliveryPolicy) => {
        const started = await baseBus.subscribeTopic(topic, opts, handler, deliveryPolicy);
        return started.map((subscription) => ({
          done: subscription.done,
          stop: async () => {
            await failStop.promise;
            throw panic;
          },
        }));
      },
    };
    const reported = deferred<unknown>();
    const pluginManager = corePrimaryTestPluginManager();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "stop-subscription-late-panic",
      reportFatalPanic: (fatal) => reported.resolve(fatal),
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({
        capability: "stop-subscription-late-panic",
        principal: null,
      }),
      createAgent: () => {
        throw new Error("no request is published");
      },
    });
    try {
      await runner.stop({ deadlineAtMs: Date.now() + 20 });
      failStop.resolve(undefined);
      await expect(reported.promise).resolves.toBe(panic);
    } finally {
      failStop.resolve(undefined);
      await pluginManager.destroy();
      await baseBus.close();
    }
  });
  it("evicts session state once its runs finish", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "idle-eviction",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "idle-eviction", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "idle-eviction",
            doStream: async () => level1TextStep("done"),
          }),
        }),
    });
    const lifecycle = await observeRequestLifecycle(bus, "github:idle-eviction:request");
    try {
      await publishRunnerRequest({
        bus,
        requestId: "github:idle-eviction:request",
        sessionId: "idle-eviction",
        text: "finish and leave",
      });
      await expect(lifecycle.terminal).resolves.toBe("resolved");
      await runner.waitForIdle();
      expect(runner.trackedSessionCount()).toBe(0);

      await publishRunnerRequest({
        bus,
        requestId: "github:idle-eviction:stray-cancel",
        sessionId: "idle-eviction-stray",
        queue: "interrupt",
        text: "",
        messages: [],
        raw: { cancel: true },
      });
      expect(runner.trackedSessionCount()).toBe(0);
    } finally {
      await lifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("runs a steer whose run ended while it loaded as a new run", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const controlLoading = deferred<void>();
    const releaseControl = deferred<void>();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondModelCall = deferred<number>();
    const releaseSecond = deferred<void>();
    let agentsCreated = 0;
    let modelCalls = 0;
    // Only the running agent's materialization opens resources, so this gates the steer there.
    const resourceAccess = {
      describe: (uri: string) =>
        Result.ok({ uri, detectedMediaType: "image/png", declaredMediaType: "image/png" }),
      open: async (uri: string) => {
        controlLoading.resolve(undefined);
        await releaseControl.promise;
        return Result.err(new ResourceNotFound({ uri, message: "gone" }));
      },
    } as unknown as Pick<ResourceAccess, "describe" | "open">;
    const runner = await startBusAgentRunner({
      bus,
      resourceAccess,
      subscriptionId: "ended-target-control",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "ended-target-control", principal: null }),
      createAgent: (options) => {
        agentsCreated += 1;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "ended-target-control",
            doStream: async () => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
              } else if (modelCalls === 2) {
                secondModelCall.resolve(agentsCreated);
                await releaseSecond.promise;
              }
              return level1TextStep("done");
            },
          }),
        });
      },
    });
    const sessionId = "ended-target-control";
    const requestId = "github:ended-target-control:request";
    try {
      await publishRunnerRequest({ bus, requestId, sessionId, text: "first request" });
      await firstStarted.promise;
      const steer = publishRunnerRequest({
        bus,
        requestId,
        sessionId,
        queue: "steer",
        text: "late steer",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "late steer" },
              {
                type: "resource",
                uri: "resource://r1_00000000000000000000000000000001",
                mediaType: "image/png",
                filename: "image.png",
              },
            ],
          },
        ],
      });
      await controlLoading.promise;
      releaseFirst.resolve(undefined);
      await runner.waitForIdle();
      releaseControl.resolve(undefined);
      await steer;
      await expect(secondModelCall.promise).resolves.toBe(2);
      // The rerouted steer must run inside the session's tracked state, so later work queues behind it.
      expect(runner.trackedSessionCount()).toBe(1);
      expect(runner.isSessionBusy(sessionId)).toBe(true);
      await publishRunnerRequest({
        bus,
        requestId: "github:ended-target-control:third",
        sessionId,
        text: "third request",
      });
      expect(modelCalls).toBe(2);
      releaseSecond.resolve(undefined);
      await runner.waitForIdle();
      expect(modelCalls).toBe(3);
    } finally {
      releaseFirst.resolve(undefined);
      releaseControl.resolve(undefined);
      releaseSecond.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("runs a steer that its run ended without consuming as the next prompt", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const sessionId = "unconsumed-steer";
    const requestId = "github:unconsumed-steer:request";
    const first = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId,
      sessionId,
      queue: "prompt",
      messages: [{ role: "user", content: "first request" }],
    });
    const steer = acceptedRunnerDelivery({
      requestDeliveryId: crypto.randomUUID(),
      requestId,
      sessionId,
      queue: "steer",
      messages: [{ role: "user", content: "late steer" }],
    });
    const accepted = new Map([
      [first.requestDeliveryId, first],
      [steer.requestDeliveryId, steer],
    ]);
    const terminalized: Array<{ requestDeliveryId: string; kind: string; code?: string }> = [];
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondPrompt = deferred<string>();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "unconsumed-steer",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      requestDelivery: {
        handleDelivery: async (requestDeliveryId: string) =>
          Result.ok({
            disposition: "accepted",
            record: accepted.get(requestDeliveryId),
            source: "new",
          }),
        replaceAcceptedWork: () => {
          throw new Error("replaceAcceptedWork is not used by steering");
        },
        terminalize: async (input: {
          requestDeliveryId: string;
          outcome: { kind: string; code?: string };
        }) => {
          terminalized.push({
            requestDeliveryId: input.requestDeliveryId,
            kind: input.outcome.kind,
            code: input.outcome.code,
          });
          return Result.ok(undefined);
        },
      } as unknown as BusAgentRunnerRequestDelivery,
      issueControlCapability: () => ({ capability: "unconsumed-steer", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "unconsumed-steer",
            doStream: async ({ prompt }) => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
                throw new Error("provider rejected the request");
              }
              secondPrompt.resolve(JSON.stringify(prompt));
              return level1TextStep("steer handled");
            },
          }),
        }),
    });
    try {
      await publishRunnerRequest({
        bus,
        requestDeliveryId: first.requestDeliveryId,
        requestId,
        sessionId,
        text: "first request",
      });
      await firstStarted.promise;
      await publishRunnerRequest({
        bus,
        requestDeliveryId: steer.requestDeliveryId,
        requestId,
        sessionId,
        queue: "steer",
        text: "late steer",
      });
      releaseFirst.resolve(undefined);

      await expect(secondPrompt.promise).resolves.toContain("late steer");
      // The steer's delivery stays accepted until the run that applies it ends.
      expect(terminalized.map(({ requestDeliveryId }) => requestDeliveryId)).toEqual([
        first.requestDeliveryId,
      ]);
      await runner.waitForIdle();
      expect(modelCalls).toBe(2);
      // It ends as its own run's delivery, not as input the failed run applied.
      expect(terminalized).toEqual([
        { requestDeliveryId: first.requestDeliveryId, kind: "failed", code: undefined },
        { requestDeliveryId: steer.requestDeliveryId, kind: "completed", code: undefined },
      ]);
    } finally {
      releaseFirst.resolve(undefined);
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  it("returns from an interrupt delivery before the agent settles", async () => {
    const bus = createLilacBus(createInMemoryRawBus());
    const pluginManager = corePrimaryTestPluginManager();
    const stuckStarted = deferred<void>();
    const releaseStuck = deferred<void>();
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "control-isolation",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      issueControlCapability: () => ({ capability: "control-isolation", principal: null }),
      createAgent: (options) => {
        let modelCalls = 0;
        return new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "control-isolation",
            doStream: async ({ prompt }) => {
              modelCalls += 1;
              const stuck = JSON.stringify(prompt).includes("ignore aborts");
              if (stuck && modelCalls === 1) {
                return level1ToolCallStep([{ toolCallId: "stuck", toolName: "stuck" }]);
              }
              return level1TextStep("done");
            },
          }),
          beforeStep: undefined,
          normalizeToolResultOutput: undefined,
          tools: {
            stuck: tool({
              inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
              execute: async () => {
                stuckStarted.resolve(undefined);
                await releaseStuck.promise;
                return "released";
              },
            }),
          },
        });
      },
    });
    const stuckRequestId = "github:control-isolation:stuck";
    const otherRequestId = "github:control-isolation:other";
    const stuckLifecycle = await observeRequestLifecycle(bus, stuckRequestId);
    const otherLifecycle = await observeRequestLifecycle(bus, otherRequestId);
    try {
      await publishRunnerRequest({
        bus,
        requestId: stuckRequestId,
        sessionId: "control-isolation-stuck",
        text: "ignore aborts",
      });
      await stuckStarted.promise;
      // The in-memory bus resolves a publish once its handler returns.
      await publishRunnerRequest({
        bus,
        requestId: stuckRequestId,
        sessionId: "control-isolation-stuck",
        queue: "interrupt",
        text: "interrupt now",
      });
      await publishRunnerRequest({
        bus,
        requestId: otherRequestId,
        sessionId: "control-isolation-other",
        text: "independent work",
      });
      await expect(otherLifecycle.terminal).resolves.toBe("resolved");
      releaseStuck.resolve(undefined);
      await expect(stuckLifecycle.terminal).resolves.toBe("resolved");
      await runner.waitForIdle();
    } finally {
      releaseStuck.resolve(undefined);
      await stuckLifecycle.stop();
      await otherLifecycle.stop();
      await runner.stop();
      await pluginManager.destroy();
      await bus.close();
    }
  });
  /**
   * Starts a runner whose first model call blocks until `releaseFirst`, then fails, so controls
   * published meanwhile stay queued in the agent. Later calls record their last user message.
   */
  async function startUnconsumedControlRunner(hooks: {
    readonly beforeTerminalize?: (requestDeliveryId: string) => Promise<void>;
    readonly beforeQuestionCancel?: () => Promise<void>;
  }) {
    const baseBus = createLilacBus(createInMemoryRawBus());
    const handled = new Map<string, ReturnType<typeof deferred<void>>>();
    const handledDelivery = (requestDeliveryId: string) => {
      const existing = handled.get(requestDeliveryId);
      if (existing) return existing;
      const created = deferred<void>();
      handled.set(requestDeliveryId, created);
      return created;
    };
    // Signals when the runner finishes handling a delivery, so a test can order its next step.
    const bus: typeof baseBus = {
      ...baseBus,
      subscribeTopic: (topic, opts, handler, deliveryPolicy) =>
        baseBus.subscribeTopic(
          topic,
          opts,
          async (msg, ctx) => {
            const result = await handler(msg, ctx);
            const data = msg.data as { requestDeliveryId?: string };
            if (data.requestDeliveryId) handledDelivery(data.requestDeliveryId).resolve(undefined);
            return result;
          },
          deliveryPolicy,
        ),
    };
    const pluginManager = corePrimaryTestPluginManager();
    const sessionId = "unconsumed-controls";
    const requestId = "github:unconsumed-controls:request";
    const accepted = new Map<string, ReturnType<typeof acceptedRunnerDelivery>>();
    const terminalized: Array<{ requestDeliveryId: string; kind: string; code?: string }> = [];
    const prompts: string[][] = [];
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let modelCalls = 0;
    const runner = await startBusAgentRunner({
      bus,
      subscriptionId: "unconsumed-controls",
      reportFatalPanic: (panic) => {
        throw panic;
      },
      config: parseCoreConfigV2ToUniversal({}),
      pluginManager,
      ...(hooks.beforeQuestionCancel
        ? {
            questions: {
              subscribe: () => () => {},
              listDeferred: () => Result.ok([]),
              cancelRequest: hooks.beforeQuestionCancel,
            } as unknown as NonNullable<Parameters<typeof startBusAgentRunner>[0]["questions"]>,
          }
        : {}),
      requestDelivery: {
        handleDelivery: async (requestDeliveryId: string) =>
          Result.ok({
            disposition: "accepted",
            record: accepted.get(requestDeliveryId),
            source: "new",
          }),
        replaceAcceptedWork: () => {
          throw new Error("replaceAcceptedWork is not used by these controls");
        },
        terminalize: async (input: {
          requestDeliveryId: string;
          outcome: { kind: string; code?: string };
        }) => {
          await hooks.beforeTerminalize?.(input.requestDeliveryId);
          terminalized.push({
            requestDeliveryId: input.requestDeliveryId,
            kind: input.outcome.kind,
            code: input.outcome.code,
          });
          return Result.ok(undefined);
        },
      } as unknown as BusAgentRunnerRequestDelivery,
      issueControlCapability: () => ({ capability: "unconsumed-controls", principal: null }),
      createAgent: (options) =>
        new AiSdkPiAgent({
          ...options,
          model: new MockLanguageModelV4({
            modelId: "unconsumed-controls",
            doStream: async ({ prompt }) => {
              modelCalls += 1;
              if (modelCalls === 1) {
                firstStarted.resolve(undefined);
                await releaseFirst.promise;
                throw new Error("provider rejected the request");
              }
              prompts.push(userTexts(prompt));
              return level1TextStep("handled");
            },
          }),
        }),
    });

    const publish = async (input: {
      readonly queue: "prompt" | "followUp" | "steer";
      readonly text: string;
      readonly requestId?: string;
    }): Promise<string> => {
      const delivery = acceptedRunnerDelivery({
        requestDeliveryId: crypto.randomUUID(),
        requestId: input.requestId ?? requestId,
        sessionId,
        queue: input.queue,
        messages: [{ role: "user", content: input.text }],
      });
      accepted.set(delivery.requestDeliveryId, delivery);
      return publishRunnerRequest({
        bus,
        requestDeliveryId: delivery.requestDeliveryId,
        requestId: input.requestId ?? requestId,
        sessionId,
        queue: input.queue,
        text: input.text,
      });
    };
    /** Publishes a Cancel and resolves once the runner has handled it. */
    const cancel = async (): Promise<void> => {
      const requestDeliveryId = await publishRunnerRequest({
        bus,
        requestId,
        sessionId,
        queue: "interrupt",
        text: "",
        raw: { cancel: true },
      });
      await handledDelivery(requestDeliveryId).promise;
    };

    return {
      runner,
      publish,
      cancel,
      terminalized,
      prompts,
      firstStarted,
      releaseFirst,
      modelCalls: () => modelCalls,
      close: async () => {
        releaseFirst.resolve(undefined);
        await runner.stop();
        await pluginManager.destroy();
        await baseBus.close();
      },
    };
  }

  function userTexts(prompt: readonly { role: string; content: unknown }[]): string[] {
    return prompt.flatMap((message) =>
      message.role === "user" && Array.isArray(message.content)
        ? message.content.flatMap((part: { type?: string; text?: string }) =>
            part.type === "text" && part.text ? [part.text] : [],
          )
        : [],
    );
  }

  it("runs unconsumed steers and follow-ups in arrival order ahead of queued prompts", async () => {
    const harness = await startUnconsumedControlRunner({});
    try {
      const first = await harness.publish({ queue: "prompt", text: "first request" });
      await harness.firstStarted.promise;
      const steer = await harness.publish({ queue: "steer", text: "early steer" });
      const followUp = await harness.publish({ queue: "followUp", text: "follow-up" });
      const queued = await harness.publish({
        queue: "prompt",
        text: "queued prompt",
        requestId: "github:unconsumed-controls:queued",
      });
      const lateSteer = await harness.publish({ queue: "steer", text: "late steer" });
      harness.releaseFirst.resolve(undefined);

      await harness.runner.waitForIdle();

      // The requeued controls share the request, so its next run coalesces them in arrival order.
      expect(harness.prompts).toEqual([
        ["early steer", "follow-up", "late steer"],
        ["queued prompt"],
      ]);
      expect(harness.terminalized).toEqual([
        { requestDeliveryId: first, kind: "failed", code: undefined },
        { requestDeliveryId: steer, kind: "completed", code: undefined },
        { requestDeliveryId: followUp, kind: "completed", code: "coalesced-into-active-run" },
        { requestDeliveryId: lateSteer, kind: "completed", code: "coalesced-into-active-run" },
        { requestDeliveryId: queued, kind: "completed", code: undefined },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("drops unconsumed controls when a cancel lands during run cleanup", async () => {
    const cleanupReached = deferred<void>();
    const releaseCleanup = deferred<void>();
    const harness = await startUnconsumedControlRunner({
      beforeQuestionCancel: async () => {
        cleanupReached.resolve(undefined);
        await releaseCleanup.promise;
      },
    });
    try {
      const first = await harness.publish({ queue: "prompt", text: "first request" });
      await harness.firstStarted.promise;
      const steer = await harness.publish({ queue: "steer", text: "steer" });
      const followUp = await harness.publish({ queue: "followUp", text: "follow-up" });
      harness.releaseFirst.resolve(undefined);
      await cleanupReached.promise;
      await harness.cancel();
      releaseCleanup.resolve(undefined);

      await harness.runner.waitForIdle();

      expect(harness.modelCalls()).toBe(1);
      expect(harness.terminalized.map(({ requestDeliveryId }) => requestDeliveryId).sort()).toEqual(
        [first, steer, followUp].sort(),
      );
    } finally {
      releaseCleanup.resolve(undefined);
      await harness.close();
    }
  });

  it("cancels transferred controls when a cancel lands during run finalization", async () => {
    let first = "";
    const terminalizeReached = deferred<void>();
    const releaseTerminalize = deferred<void>();
    const harness = await startUnconsumedControlRunner({
      beforeTerminalize: async (requestDeliveryId) => {
        if (requestDeliveryId !== first) return;
        terminalizeReached.resolve(undefined);
        await releaseTerminalize.promise;
      },
    });
    try {
      first = await harness.publish({ queue: "prompt", text: "first request" });
      await harness.firstStarted.promise;
      const steer = await harness.publish({ queue: "steer", text: "steer" });
      const followUp = await harness.publish({ queue: "followUp", text: "follow-up" });
      harness.releaseFirst.resolve(undefined);
      await terminalizeReached.promise;
      await harness.cancel();
      releaseTerminalize.resolve(undefined);

      await harness.runner.waitForIdle();

      expect(harness.modelCalls()).toBe(1);
      expect(harness.terminalized).toEqual([
        { requestDeliveryId: steer, kind: "cancelled", code: "cancelled-while-queued" },
        { requestDeliveryId: followUp, kind: "cancelled", code: "cancelled-while-queued" },
        { requestDeliveryId: first, kind: "failed", code: undefined },
      ]);
    } finally {
      releaseTerminalize.resolve(undefined);
      await harness.close();
    }
  });
});

describe("shouldCancelIdleOnlyGlobalRequest", () => {
  it("cancels when another non-heartbeat session is running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "discord-session",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
      [
        "__heartbeat__",
        {
          running: false,
          agent: null,
          queue: [],
          activeRequestId: null,
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });

  it("cancels when the heartbeat session is already running", () => {
    type IdleOnlyGlobalState =
      Parameters<typeof shouldCancelIdleOnlyGlobalRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, IdleOnlyGlobalState>([
      [
        "__heartbeat__",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "heartbeat:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelIdleOnlyGlobalRequest({
        runPolicy: "idle_only_global",
        sessionId: "__heartbeat__",
        states,
      }),
    ).toBe(true);
  });
});

describe("shouldCancelRunPolicyRequest", () => {
  it("cancels idle_only_session when the session is already running", () => {
    type RunnerState =
      Parameters<typeof shouldCancelRunPolicyRequest>[0]["states"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never;

    const states = new Map<string, RunnerState>([
      [
        "chan",
        {
          running: true,
          agent: null,
          queue: [],
          activeRequestId: "req:1",
          activeRun: null,
          compactedToolCallIds: new Set<string>(),
        },
      ],
    ]);

    expect(
      shouldCancelRunPolicyRequest({
        runPolicy: "idle_only_session",
        sessionId: "chan",
        states,
      }),
    ).toBe(true);
  });
});

describe("mergeToSingleUserMessage", () => {
  it("keeps all user text when merging plain-text messages", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      { role: "assistant", content: "ignored" },
      { role: "user", content: "C two" },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("B one");
    expect(out.content).toContain("C two");
    expect(out.content).toContain("D steer");
  });

  it("preserves later metadata lines at merged block boundaries", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m1"}</LILAC_META:v1>\nfirst',
      },
      {
        role: "user",
        content: '<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(typeof out.content).toBe("string");
    expect(out.content).toContain("m1");
    expect(out.content).toContain(
      '\n\n<LILAC_META:v1>{"platform":"discord","message_id":"m2"}</LILAC_META:v1>\nsecond',
    );
  });

  it("preserves buffered multipart content and steering text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "B with image" },
          {
            type: "file",
            data: new Uint8Array([1, 2, 3]),
            mediaType: "image/png",
          },
        ],
      },
      { role: "user", content: "D steer" },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B with image")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D steer")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });

  it("preserves steering multipart content and buffered text in one merged user message", () => {
    const out = mergeToSingleUserMessage([
      { role: "user", content: "B one" },
      {
        role: "user",
        content: [
          { type: "text", text: "D interrupt with image" },
          {
            type: "file",
            data: new Uint8Array([7, 8]),
            mediaType: "image/jpeg",
          },
        ],
      },
    ] satisfies ModelMessage[]);

    expect(out.role).toBe("user");
    expect(Array.isArray(out.content)).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("B one")),
    ).toBe(true);
    expect(
      Array.isArray(out.content) &&
        out.content.some((part) => part.type === "text" && part.text.includes("D interrupt")),
    ).toBe(true);
    expect(Array.isArray(out.content) && out.content.some((part) => part.type === "file")).toBe(
      true,
    );
  });
});
