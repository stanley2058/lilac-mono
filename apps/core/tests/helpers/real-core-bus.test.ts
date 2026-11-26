import { expect, it } from "bun:test";
import { createRealCoreBusFixture, requireBusOk, withBusDeadline } from "./real-core-bus";

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
