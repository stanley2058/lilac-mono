import { expect, it } from "bun:test";
import { AiSdkPiAgent } from "@stanley2058/lilac-agent";
import { lilacEventTypes, outReqTopic } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { Result } from "better-result";
import { bridgeBusToAdapter } from "../../../src/surface/bridge/subscribe-from-bus";
import { createDiscordRelayPolicy } from "../../../src/surface/discord/discord-runtime-descriptor";
import {
  createRealCoreBusFixture,
  requireBusOk,
  withBusDeadline,
} from "../../helpers/real-core-bus";
import {
  corePrimaryTestPluginManager,
  level1ZeroUsage,
  ProductionPathDiscordAdapter,
  startBusAgentRunner,
} from "./bus-agent-runner-test-support";

it("drains a loaded session in order while another session and a slow output consumer stay independent", async () => {
  const f = await createRealCoreBusFixture();
  const config = parseCoreConfigV2ToUniversal({});
  config.models.main = { model: "openai/redis-load" };
  config.agent.retry = { enabled: false, maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
  const pluginManager = corePrimaryTestPluginManager();
  const active = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const releaseRelay = Promise.withResolvers<void>();
  const relayBlocked = Promise.withResolvers<void>();
  const relayFinished = Promise.withResolvers<string>();
  const chunks = Array.from({ length: 16 }, (_, index) => `chunk-${index};`);
  const modelCalls: string[] = [];
  const queuedIds = Array.from({ length: 24 }, (_, index) => `queued-${index}`);
  const queued = new Map(queuedIds.map((id) => [id, Promise.withResolvers<void>()]));
  const lifecycle = new Map<string, string[]>();
  const terminal = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
  for (const id of ["blocked", "independent", ...queuedIds])
    terminal.set(id, Promise.withResolvers<string>());
  const lifecycleSubscription = requireBusOk(
    await f.bus.subscribeTopic(
      "evt.request",
      { mode: "tail", offset: { type: "begin" } },
      async (message) => {
        if (message.type !== lilacEventTypes.EvtRequestLifecycleChanged)
          return Result.ok(undefined);
        const id = message.headers?.request_id;
        if (!id) throw new Error("Lifecycle event has no request identity");
        const states = lifecycle.get(id) ?? [];
        states.push(message.data.state);
        lifecycle.set(id, states);
        if (message.data.state === "queued") queued.get(id)?.resolve();
        if (["resolved", "cancelled", "failed"].includes(message.data.state))
          terminal.get(id)?.resolve(message.data.state);
        return Result.ok(undefined);
      },
      () => "dead-letter",
    ),
  );
  const relayed: string[] = [];
  const adapter = new ProductionPathDiscordAdapter();
  const startOutput = adapter.startOutput.bind(adapter);
  adapter.startOutput = async (session, options) => {
    const output = requireBusOk(await startOutput(session, options));
    let visible = "";
    return Result.ok({
      ...output,
      push: async (part) => {
        if (part.type === "text.delta") {
          relayed.push(part.delta);
          if (relayed.length === 1) {
            relayBlocked.resolve();
            await releaseRelay.promise;
          }
          visible += part.delta;
        }
        if (part.type === "text.set") visible = part.text;
        return output.push(part);
      },
      finish: async () => {
        const finished = await output.finish();
        relayFinished.resolve(visible);
        return finished;
      },
    });
  };
  const relay = await bridgeBusToAdapter({
    adapter,
    blobStore: f.blobs,
    bus: f.bus,
    platform: "discord",
    policy: createDiscordRelayPolicy(adapter),
    subscriptionId: "slow-load-relay",
  });
  const runner = await startBusAgentRunner({
    bus: f.bus,
    blobStore: f.blobs,
    requestDelivery: f.coordinator,
    subscriptionId: "runner-load",
    config,
    pluginManager,
    cwd: f.directory,
    reportFatalPanic: (panic) => {
      throw panic;
    },
    issueControlCapability: () => ({ capability: "synthetic", principal: null }),
    createAgent: (options) =>
      new AiSdkPiAgent({
        ...options,
        model: new MockLanguageModelV4({
          doStream: async ({ prompt, abortSignal }) => {
            const id = [...JSON.stringify(prompt).matchAll(/load:([a-z0-9-]+)/g)].at(-1)?.[1];
            if (!id) throw new Error("Missing load request marker");
            modelCalls.push(id);
            if (id === "blocked") {
              abortSignal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
              active.resolve();
              await cancelled.promise;
              throw Object.assign(new Error("Load request cancelled"), { name: "AbortError" });
            }
            const deltas = id === "independent" ? chunks : [`answer:${id}`];
            return {
              stream: simulateReadableStream({
                chunks: [
                  { type: "text-start" as const, id: "text" },
                  ...deltas.map((delta) => ({ type: "text-delta" as const, id: "text", delta })),
                  { type: "text-end" as const, id: "text" },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: level1ZeroUsage(),
                  },
                ],
              }),
            };
          },
        }),
      }),
  });
  const deliveries = new Map<string, string>();
  const publish = async (id: string, queue: "prompt" | "interrupt" = "prompt") => {
    const requestDeliveryId = crypto.randomUUID();
    const receipt = requireBusOk(
      await f.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId,
          queue,
          messages: [{ role: "user", content: `load:${id}` }],
          ...(queue === "interrupt" ? { raw: { cancel: true, requiresActive: true } } : {}),
        },
        {
          headers: {
            request_id: id,
            session_id: id === "independent" ? "other-session" : "loaded-session",
            request_client: id === "independent" ? "discord" : "github",
          },
        },
      ),
    );
    if (queue === "prompt") deliveries.set(id, requestDeliveryId);
    await f.waitForCommit(receipt.cursor, "cmd.request");
  };
  const settled = (id: string) =>
    withBusDeadline(terminal.get(id)!.promise, `${id} terminal lifecycle`, 10_000);
  try {
    await publish("blocked");
    await withBusDeadline(active.promise, "blocked model");
    for (const id of queuedIds) await publish(id);
    await withBusDeadline(
      Promise.all([...queued.values()].map((entry) => entry.promise)),
      "queued lifecycle delivery",
    );
    expect(modelCalls).toEqual(["blocked"]);
    expect(runner.trackedSessionCount()).toBe(1);
    expect(queuedIds.map((id) => lifecycle.get(id)?.[0])).toEqual(queuedIds.map(() => "queued"));

    await publish("independent");
    await withBusDeadline(relayBlocked.promise, "slow output consumer");
    expect(await settled("independent")).toBe("resolved");
    expect(modelCalls).toEqual(["blocked", "independent"]);
    expect(runner.trackedSessionCount()).toBeLessThanOrEqual(2);
    expect(lifecycle.get("blocked")).toEqual(["running"]);
    expect(relayed).toHaveLength(1);

    await publish("blocked", "interrupt");
    expect(await settled("blocked")).toBe("cancelled");
    expect(await Promise.all(queuedIds.map(settled))).toEqual(queuedIds.map(() => "resolved"));
    await withBusDeadline(runner.waitForIdle(), "loaded runner drain", 10_000);
    expect(modelCalls).toEqual(["blocked", "independent", ...queuedIds]);
    expect(runner.trackedSessionCount()).toBe(0);
    expect(relayed).toHaveLength(1);
    releaseRelay.resolve();
    expect(await withBusDeadline(relayFinished.promise, "slow relay final output")).toBe(
      chunks.join(""),
    );
    expect(relayed.join("")).toBe(chunks.join(""));
    for (const id of queuedIds) {
      expect(lifecycle.get(id)).toEqual(["queued", "running", "resolved"]);
      const fetched = requireBusOk(
        await f.bus.fetchTopic(outReqTopic(id), { offset: { type: "begin" } }),
      );
      const finals = fetched.messages.flatMap(({ msg }) =>
        msg.type === lilacEventTypes.EvtAgentOutputResponseText ? [msg.data.finalText] : [],
      );
      expect(finals).toEqual([`answer:${id}`]);
      expect(requireBusOk(f.store.load(deliveries.get(id)!))).toMatchObject({
        state: "terminal",
        outcome: { kind: "completed" },
      });
    }
    expect(requireBusOk(f.store.load(deliveries.get("blocked")!))).toMatchObject({
      state: "terminal",
      outcome: { kind: "cancelled" },
    });
    await f.raw.flushPendingTrims();
    expect(await f.redis.xlen(`${f.keyPrefix}:v2:cmd.request`)).toBeLessThanOrEqual(1);
  } finally {
    cancelled.resolve();
    releaseRelay.resolve();
    await runner.stop();
    await relay.stop();
    requireBusOk(await lifecycleSubscription.stop());
    requireBusOk(await pluginManager.destroy());
    await f.close();
  }
}, 25_000);
