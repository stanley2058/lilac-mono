import { afterEach, describe, expect, it } from "bun:test";
import { Result } from "better-result";
import { lilacEventTypes, type CmdRequestMessageData } from "@stanley2058/lilac-event-bus";
import { parseCoreConfigV3ToUniversal } from "@stanley2058/lilac-utils";
import { startHeartbeatServiceResult } from "../../src/heartbeat/heartbeat-service";
import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "../helpers/real-core-bus";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("heartbeat through the production Redis bus", () => {
  it("publishes durable idle requests and consumes lifecycle events to suppress and resume them", async () => {
    const fixture = await createRealCoreBusFixture();
    cleanups.push(() => fixture.close());
    let now = Date.now();
    const config = parseCoreConfigV3ToUniversal({
      configVersion: 3,
      surface: { heartbeat: { enabled: true, quietAfterActivityMs: 1 } },
    });
    const received: CmdRequestMessageData[] = [];
    const arrivals = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const subscription = requireBusOk(
      await fixture.bus.subscribeTopic(
        "cmd.request",
        { mode: "fanout", subscriptionId: "heartbeat-observer" },
        async (message) => {
          received.push(message.data);
          arrivals[received.length - 1]?.resolve();
          return Result.ok(undefined);
        },
        () => "commit",
      ),
    );
    const service = requireBusOk(
      await startHeartbeatServiceResult({
        bus: fixture.bus,
        subscriptionId: "heartbeat",
        config,
        now: () => now,
      }),
    );
    const lifecycle = async (
      requestId: string,
      sessionId: string,
      state: "running" | "resolved",
    ) => {
      const published = requireBusOk(
        await fixture.bus.publish(
          lilacEventTypes.EvtRequestLifecycleChanged,
          { state, ts: now },
          { headers: { request_id: requestId, session_id: sessionId, request_client: "unknown" } },
        ),
      );
      await fixture.waitForCommit(published.id);
    };
    const requests = async () =>
      requireBusOk(
        await fixture.bus.fetchTopic("cmd.request", { offset: { type: "begin" }, limit: 10 }),
      ).messages;
    try {
      await lifecycle("external", "discord-channel", "running");
      await service.tick("interval");
      expect(await requests()).toHaveLength(0);
      await lifecycle("external", "discord-channel", "resolved");
      now += 10;
      await service.tick("retry");
      await withBusDeadline(arrivals[0]!.promise, "first heartbeat request");
      expect(received[0]).toMatchObject({
        queue: "prompt",
        runPolicy: "idle_only_global",
        origin: { kind: "heartbeat", reason: "retry" },
      });
      expect(
        requireBusOk(fixture.store.load(received[0]!.requestDeliveryId)).publication?.streamId,
      ).toBeString();
      await service.tick("interval");
      expect(await requests()).toHaveLength(1);
      const first = (await requests())[0]!;
      expect(first.msg.headers).toMatchObject({
        session_id: "__heartbeat__",
        request_client: "unknown",
      });
      await lifecycle(first.msg.headers!.request_id!, "__heartbeat__", "resolved");
      now += 10;
      await service.tick("interval");
      await withBusDeadline(arrivals[1]!.promise, "heartbeat after completion");
      expect(received[1]!.requestDeliveryId).not.toBe(received[0]!.requestDeliveryId);
      expect(await requests()).toHaveLength(2);
    } finally {
      const stopped = await service.stopOutcome();
      if (stopped.kind === "panic") throw stopped.panic;
      requireBusOk(stopped.result);
      requireBusOk(await subscription.stop());
      await fixture.close();
    }
  });
});
