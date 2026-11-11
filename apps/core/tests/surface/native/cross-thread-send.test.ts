import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "bun:test";

import { createNativeIntegrationFixture, nativeFixtureTextResponse } from "./integration-fixture";

type Fixture = Awaited<ReturnType<typeof createNativeIntegrationFixture>>;

function until(f: Fixture, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (predicate()) return resolve();
    const stop = f.store.subscribe(() => {
      if (!predicate()) return;
      stop();
      resolve();
    });
  });
}

test("a run-triggering surface send to a busy thread queues and shows as Lilac's message", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let held = false;
  const f = await createNativeIntegrationFixture({
    model: new MockLanguageModelV4({
      modelId: "busy-target",
      doStream: async () => {
        if (!held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return nativeFixtureTextResponse("Done.");
      },
    }),
  });
  try {
    const { client } = f.connect();
    const document = await client.config.readDeployment({});
    await client.config.setDeployment({
      settings: { ...document.settings, crossThreadSend: { triggerRun: true } },
      expectedRevision: document.revision,
    });
    const source = await client.threads.create({ commandId: crypto.randomUUID(), title: "S" });
    const target = await client.threads.create({ commandId: crypto.randomUUID(), title: "T" });
    await client.inputs.submit({
      threadId: target.id,
      commandId: crypto.randomUUID(),
      mode: "prompt",
      historyGeneration: 0,
      text: "Begin",
      attachmentIds: [],
      skillIds: [],
    });
    await started.promise;

    const adapter = f.runtime.adapter.forRequest({
      principalId: "owner",
      sourceThreadId: source.id,
      requestId: `native:${source.id}:request`,
    });
    const sent = await adapter.sendMsg(
      { platform: "native", channelId: target.id },
      { text: "From another thread" },
    );
    expect(sent.isOk()).toBe(true);
    expect(
      f.store
        .listPendingInputs(target.id)
        .unwrap()
        .map((input) => input.mode),
    ).toContain("followup");

    release.resolve();
    await until(
      f,
      () =>
        f.store.getThreadRecord(target.id).unwrap().activeRunId === undefined &&
        f.store.listPendingInputs(target.id).unwrap().length === 0,
    );
    const port = f.runtime.descriptor.createThreadControl!(f.runtime.descriptor.adapter);
    const read = (
      await port.read({ userId: "owner", sourceThreadId: source.id }, target.id, {
        view: "messages",
        limit: 20,
        maxCharsPerItem: 200,
      })
    ).unwrap();
    expect(read.items.find((item) => item.text === "From another thread")).toMatchObject({
      role: "assistant",
    });
  } finally {
    release.resolve();
    await f.close();
  }
});
