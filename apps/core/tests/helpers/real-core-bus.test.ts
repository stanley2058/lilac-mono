import { expect, it } from "bun:test";
import { lilacEventTypes } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";
import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "./real-core-bus";

it("publishes and commits a durable request through isolated real Redis and SQLite", async () => {
  const fixture = await createRealCoreBusFixture();
  try {
    const received = Promise.withResolvers<string>();
    const subscription = requireBusOk(
      await fixture.bus.subscribeTopic(
        "cmd.request",
        { mode: "work", subscriptionId: "fixture-contract", startFrom: "beginning" },
        async (message) => {
          received.resolve(message.data.requestDeliveryId);
          return Result.ok(undefined);
        },
        () => "stop",
      ),
    );
    const requestDeliveryId = crypto.randomUUID();
    const publication = requireBusOk(
      await fixture.bus.publish(
        lilacEventTypes.CmdRequestMessage,
        {
          requestDeliveryId,
          queue: "prompt",
          messages: [{ role: "user", content: "contract fixture" }],
        },
        {
          headers: {
            request_id: "fixture-request",
            session_id: "fixture-session",
            request_client: "github",
          },
        },
      ),
    );
    expect(await withBusDeadline(received.promise, "typed request delivery")).toBe(
      requestDeliveryId,
    );
    await fixture.waitForCommit(publication.cursor, "cmd.request");
    const record = requireBusOk(fixture.store.load(requestDeliveryId));
    expect(record.publication?.streamId).toBe(publication.cursor);
    expect(record.transportCommittedAt).toBeNumber();
    requireBusOk(await subscription.stop());
  } finally {
    await fixture.close();
  }
});

it("fails cleanup when a real consumer stops with an unobserved delivery error", async () => {
  const fixture = await createRealCoreBusFixture();
  const subscription = requireBusOk(
    await fixture.raw.subscribe(
      "fixture.failure",
      { mode: "work", subscriptionId: "failed-consumer", startFrom: "beginning" },
      async () => ({ disposition: "stop" }),
    ),
  );
  await fixture.raw.publish(
    { topic: "fixture.failure", type: "fixture.failure", data: {} },
    { topic: "fixture.failure", type: "fixture.failure" },
  );
  const completion = await withBusDeadline(subscription.done, "consumer failure");
  expect(completion.status).toBe("error");
  const disconnected = Promise.withResolvers<void>();
  fixture.redis.once("end", disconnected.resolve);
  await expect(fixture.close()).rejects.toThrow("Real bus fixture failed");
  await withBusDeadline(disconnected.promise, "Redis connection shutdown");
  expect(fixture.redis.status).toBe("end");
  expect(await Bun.file(`${fixture.directory}/request-delivery.sqlite`).exists()).toBe(false);
});
