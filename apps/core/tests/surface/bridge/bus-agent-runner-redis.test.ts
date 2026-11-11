import { describe, expect, it } from "bun:test";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import { lilacEventTypes, outReqTopic } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { MockLanguageModelV4 } from "ai/test";
import { Result } from "better-result";
import {
  createRealCoreBusFixture,
  requireBusOk,
  withBusDeadline,
} from "../../helpers/real-core-bus";
import {
  corePrimaryTestPluginManager,
  level1TestToolset,
  level1TextStep,
  level1ToolCallStep,
  observeRequestLifecycle,
  startBusAgentRunner,
} from "./bus-agent-runner-test-support";

async function fixture(model: MockLanguageModelV4, toolset = level1TestToolset()) {
  const transport = await createRealCoreBusFixture();
  const config = parseCoreConfigV2ToUniversal({});
  config.models.main = { model: "openai/redis-contract" };
  config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
  const pluginManager = corePrimaryTestPluginManager(undefined, toolset);
  const runner = await startBusAgentRunner({
    bus: transport.bus,
    blobStore: transport.blobs,
    requestDelivery: transport.coordinator,
    subscriptionId: "runner-contract",
    config,
    pluginManager,
    cwd: transport.directory,
    reportFatalPanic: (panic) => {
      throw panic;
    },
    issueControlCapability: () => ({ capability: "synthetic", principal: null }),
    createAgent: (options) => new AiSdkPiAgent({ ...options, model }),
  });
  const observations: Array<{ stop(): Promise<void> }> = [];
  async function observe(requestId: string) {
    const lifecycle = await observeRequestLifecycle(transport.bus, requestId);
    observations.push(lifecycle);
    const output = Promise.withResolvers<string>();
    const deltas: string[] = [];
    const toolCalls: Array<{ toolCallId: string; status: string; ok?: boolean }> = [];
    const subscription = requireBusOk(
      await transport.bus.subscribeTopic(
        outReqTopic(requestId),
        { mode: "tail", offset: { type: "begin" } },
        async (message) => {
          if (message.type === lilacEventTypes.EvtAgentOutputToolCall) toolCalls.push(message.data);
          if (message.type === lilacEventTypes.EvtAgentOutputDeltaText)
            deltas.push(message.data.delta);
          if (message.type === lilacEventTypes.EvtAgentOutputResponseText)
            output.resolve(message.data.finalText);
          return Result.ok(undefined);
        },
        () => "dead-letter",
      ),
    );
    observations.push({
      stop: async () => {
        requireBusOk(await subscription.stop());
      },
    });
    return { lifecycle, output: output.promise, deltas, toolCalls };
  }
  async function publish(
    requestId: string,
    options: {
      deliveryId?: string;
      queue?: "prompt" | "interrupt" | "followUp" | "steer";
      raw?: unknown;
      text?: string;
    } = {},
  ) {
    const deliveryId = options.deliveryId ?? crypto.randomUUID();
    const receipt = requireBusOk(
      await transport.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId: deliveryId,
          queue: options.queue ?? "prompt",
          messages: [{ role: "user", content: options.text ?? "Synthetic request" }],
          ...(options.raw === undefined ? {} : { raw: options.raw }),
        },
        {
          headers: { request_id: requestId, session_id: "redis-session", request_client: "github" },
        },
      ),
    );
    return { deliveryId, receipt };
  }
  async function close() {
    await runner.stop();
    for (const observation of observations.reverse()) await observation.stop();
    requireBusOk(await pluginManager.destroy());
    await transport.close();
  }
  return { ...transport, runner, observe, publish, close };
}

describe("runner contracts through Redis", () => {
  for (const queue of ["steer", "followUp"] as const) {
    it(`delivers ${queue} across an active tool boundary and settles both deliveries`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const prompts: string[] = [];
      const f = await fixture(
        new MockLanguageModelV4({
          doStream: async (call) => {
            prompts.push(JSON.stringify(call.prompt));
            return prompts.length === 1
              ? level1ToolCallStep([{ toolCallId: "gated-tool", toolName: "builtin" }])
              : level1TextStep("Controlled answer");
          },
        }),
        level1TestToolset({
          builtinExecute: async () => {
            entered.resolve();
            await release.promise;
            return "Tool result";
          },
        }),
      );
      try {
        const observed = await f.observe(`request-${queue}`);
        const prompt = await f.publish(`request-${queue}`);
        await withBusDeadline(entered.promise, "tool invocation");
        const control = await f.publish(`request-${queue}`, {
          queue,
          text: `Apply ${queue} instruction`,
        });
        await f.waitForCommit(control.receipt.cursor, "cmd.request");
        release.resolve();
        expect(await withBusDeadline(observed.lifecycle.terminal, "controlled lifecycle")).toBe(
          "resolved",
        );
        await withBusDeadline(f.runner.waitForIdle(), "controlled runner idle");
        expect(await withBusDeadline(observed.output, "controlled output")).toBe(
          queue === "steer" ? "Controlled answer" : "Controlled answer\n\nControlled answer",
        );
        expect(observed.toolCalls).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ toolCallId: "gated-tool", status: "start" }),
            expect.objectContaining({ toolCallId: "gated-tool", status: "end", ok: true }),
          ]),
        );
        expect(prompts).toHaveLength(queue === "steer" ? 2 : 3);
        expect(prompts.at(-1)).toContain(`Apply ${queue} instruction`);
        expect(requireBusOk(f.store.load(prompt.deliveryId))).toMatchObject({
          state: "terminal",
          outcome: { kind: "completed" },
        });
        expect(requireBusOk(f.store.load(control.deliveryId))).toMatchObject({
          state: "terminal",
          outcome: { kind: "completed" },
        });
      } finally {
        release.resolve();
        await f.close();
      }
    }, 15_000);
  }
  it("consumes a durable prompt, delivers streamed and final output, and deduplicates redelivery", async () => {
    let calls = 0;
    const f = await fixture(
      new MockLanguageModelV4({
        doStream: async () => {
          calls += 1;
          return level1TextStep("Redis response");
        },
      }),
    );
    try {
      const observed = await f.observe("request-success");
      const published = await f.publish("request-success");
      expect(await withBusDeadline(observed.lifecycle.terminal, "resolved lifecycle")).toBe(
        "resolved",
      );
      expect(await withBusDeadline(observed.output, "final output")).toBe("Redis response");
      await withBusDeadline(f.runner.waitForIdle(), "runner idle");
      expect(observed.deltas.join("")).toBe("Redis response");
      expect(observed.lifecycle.states).toEqual(["running", "resolved"]);
      expect(requireBusOk(f.store.load(published.deliveryId))).toMatchObject({
        state: "terminal",
        outcome: { kind: "completed" },
      });
      const duplicate = await f.publish("request-success", { deliveryId: published.deliveryId });
      expect(duplicate.receipt.duplicate).toBe(true);
      expect(await f.redis.xlen(`${f.keyPrefix}:v2:cmd.request`)).toBe(1);
      expect(calls).toBe(1);
    } finally {
      await f.close();
    }
  }, 15_000);

  it("queues another prompt while a session is running and executes it after the first settles", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const f = await fixture(
      new MockLanguageModelV4({
        doStream: async () => {
          calls += 1;
          if (calls === 1) {
            started.resolve();
            await release.promise;
          }
          return level1TextStep(`answer ${calls}`);
        },
      }),
    );
    try {
      const first = await f.observe("request-first");
      const second = await f.observe("request-second");
      await f.publish("request-first");
      await withBusDeadline(started.promise, "first model call");
      await f.publish("request-second");
      expect(await withBusDeadline(second.lifecycle.first, "queued lifecycle")).toBe("queued");
      expect(calls).toBe(1);
      release.resolve();
      expect(await withBusDeadline(first.lifecycle.terminal, "first resolved")).toBe("resolved");
      expect(await withBusDeadline(second.lifecycle.terminal, "second resolved")).toBe("resolved");
      expect(await withBusDeadline(second.output, "second output")).toBe("answer 2");
      expect(second.lifecycle.states).toEqual(["queued", "running", "resolved"]);
    } finally {
      release.resolve();
      await f.close();
    }
  }, 15_000);

  it("delivers an interrupt to an active model and terminalizes the durable prompt", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const f = await fixture(
      new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => {
          abortSignal?.addEventListener("abort", () => aborted.resolve(), { once: true });
          started.resolve();
          await aborted.promise;
          throw Object.assign(new Error("Synthetic cancellation"), { name: "AbortError" });
        },
      }),
    );
    try {
      const observed = await f.observe("request-cancel");
      const prompt = await f.publish("request-cancel");
      await withBusDeadline(started.promise, "active model call");
      const interrupt = await f.publish("request-cancel", {
        queue: "interrupt",
        raw: { cancel: true, requiresActive: true },
      });
      await withBusDeadline(aborted.promise, "model abort");
      expect(await withBusDeadline(observed.lifecycle.terminal, "cancelled lifecycle")).toBe(
        "cancelled",
      );
      await withBusDeadline(f.runner.waitForIdle(), "cancelled runner idle");
      expect(requireBusOk(f.store.load(prompt.deliveryId))).toMatchObject({
        state: "terminal",
        outcome: { kind: "cancelled" },
      });
      expect(requireBusOk(f.store.load(interrupt.deliveryId))).toMatchObject({ state: "terminal" });
    } finally {
      aborted.resolve();
      await f.close();
    }
  }, 15_000);

  it("publishes a failed lifecycle and settles delivery when the model fails", async () => {
    const f = await fixture(
      new MockLanguageModelV4({
        doStream: async () => {
          throw new Error("Synthetic model failure");
        },
      }),
    );
    try {
      const observed = await f.observe("request-failure");
      const published = await f.publish("request-failure");
      expect(await withBusDeadline(observed.lifecycle.terminal, "failed lifecycle")).toBe("failed");
      await withBusDeadline(f.runner.waitForIdle(), "failed runner idle");
      expect(observed.lifecycle.states).toEqual(["running", "failed"]);
      expect(requireBusOk(f.store.load(published.deliveryId))).toMatchObject({
        state: "terminal",
        outcome: { kind: "failed" },
      });
    } finally {
      await f.close();
    }
  }, 15_000);
});
