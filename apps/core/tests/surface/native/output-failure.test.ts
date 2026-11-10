import { expect, test } from "bun:test";
import { Result } from "better-result";
import { EventPublishTransportFailed } from "@stanley2058/lilac-event-bus";
import { MockLanguageModelV4 } from "ai/test";
import { createNativeIntegrationFixture, nativeFixtureTextResponse } from "./integration-fixture";

test("a single output publication failure reaches runtime supervision and preserves recovery ownership", async () => {
  const started = Promise.withResolvers<void>();
  const fixture = await createNativeIntegrationFixture({
    model: new MockLanguageModelV4({
      modelId: "output-failure",
      doStream: async () => {
        started.resolve();
        return nativeFixtureTextResponse("Synthetic response");
      },
    }),
  });
  const publish = fixture.bus.publish.bind(fixture.bus);
  let failures = 0;
  fixture.bus.publish = async (type, data, options) => {
    if (type === "evt.native.output" && failures++ === 0)
      return Result.err(
        new EventPublishTransportFailed({
          eventType: type,
          topic: type,
          cause: new Error("Synthetic outage"),
          message: "Synthetic outage",
        }),
      );
    return publish(type, data, options);
  };
  try {
    const { client } = fixture.connect();
    const thread = await client.threads.create({
      commandId: crypto.randomUUID(),
      title: "Output failure",
    });
    const receipt = await client.inputs.submit({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text: "Synthetic prompt",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    });
    await started.promise;
    await fixture.runner.waitForIdle();
    expect(fixture.fatalErrors).toHaveLength(1);
    expect(fixture.fatalErrors[0]?.message).toBe("Native output publication failed");
    expect(fixture.store.getInput(receipt.inputId).unwrap().state).toBe("admitted");
    expect(fixture.store.getThreadRecord(thread.id).unwrap().activeRunId).toBeDefined();
    expect(fixture.runner.getActiveLevel1Work()).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
