import { MockLanguageModelV4 } from "ai/test";
import { expect, test } from "bun:test";

import type { SurfaceThreadControlPort } from "../../../src/surface/thread-control";
import { createNativeIntegrationFixture, nativeFixtureTextResponse } from "./integration-fixture";

type Fixture = Awaited<ReturnType<typeof createNativeIntegrationFixture>>;

/** Resolves once the native store reaches the predicate, without polling on a timer. */
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

/**
 * A model that holds the first `holds` prompts mentioning "hold" open until released or aborted.
 * Later steps of the same conversation still mention "hold", so only the counted calls block.
 */
function gatedModel(holds: number) {
  const starts = Array.from({ length: holds }, () => Promise.withResolvers<void>());
  let held = 0;
  let release: () => void = () => {};
  const model = new MockLanguageModelV4({
    modelId: "gated-fixture",
    doStream: async ({ prompt, abortSignal }) => {
      const text = JSON.stringify(prompt);
      if (held < holds && text.includes("hold")) {
        starts[held++]!.resolve();
        await new Promise<void>((resolve) => {
          release = resolve;
          if (abortSignal?.aborted) return resolve();
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (abortSignal?.aborted)
          throw Object.assign(new Error("Fixture canceled"), { name: "AbortError" });
      }
      return nativeFixtureTextResponse("Fixture response.");
    },
  });
  return {
    model,
    started: (index: number) => starts[index]!.promise,
    release: () => release(),
  };
}

async function setup(model?: MockLanguageModelV4) {
  const f = await createNativeIntegrationFixture({
    ...(model ? { model } : {}),
    additionalLocalUsers: [{ userId: "guest", username: "guest", password: "guest-password" }],
  });
  const { client } = f.connect();
  const source = await client.threads.create({ commandId: crypto.randomUUID(), title: "Source" });
  const target = await client.threads.create({ commandId: crypto.randomUUID(), title: "Target" });
  const port = f.runtime.descriptor.createThreadControl?.(f.runtime.descriptor.adapter);
  if (!port) throw new Error("Native thread control is unavailable");
  const caller = { userId: "owner", sourceThreadId: `native:${source.id}` };
  return { f, client, source, target, port, caller };
}

async function submit(
  client: Awaited<ReturnType<typeof setup>>["client"],
  threadId: string,
  text: string,
) {
  return client.inputs.submit({
    threadId,
    commandId: crypto.randomUUID(),
    mode: "prompt",
    historyGeneration: 0,
    text,
    attachmentIds: [],
    skillIds: [],
  });
}

async function setCrossThreadRuns(
  client: Awaited<ReturnType<typeof setup>>["client"],
  triggerRun: boolean,
) {
  const document = await client.config.readDeployment({});
  await client.config.setDeployment({
    settings: { ...document.settings, crossThreadSend: { triggerRun } },
    expectedRevision: document.revision,
  });
}

function value<T>(result: { isOk(): boolean; unwrap(): T }): T {
  return result.unwrap();
}

test("an agent reads another thread and posts to it when cross-thread runs are off", async () => {
  const { f, client, target, port, caller } = await setup();
  try {
    await setCrossThreadRuns(client, false);
    const receipt = await submit(client, target.id, "Hello target");
    await until(f, () => Boolean(f.store.getInput(receipt.inputId).unwrap().completedAt));

    const read = value(
      await port.read(caller, target.id, { view: "messages", limit: 20, maxCharsPerItem: 500 }),
    );
    expect(read).toMatchObject({ threadId: target.id, title: "Target", activeRunId: null });
    expect(read.items.map((item) => item.text)).toEqual([
      "Hello target",
      "Fixture response.\n\nReady for the next message.",
    ]);

    const note = { text: "A note from the source thread", mode: "auto" as const, commandId: "n1" };
    const posted = value(await port.send(caller, target.id, note));
    expect(posted.disposition).toBe("posted");
    expect(value(await port.send(caller, target.id, note)).messageId).toBe(posted.messageId);
    const after = value(
      await port.read(caller, target.id, {
        view: "messages",
        after: read.after!,
        limit: 20,
        maxCharsPerItem: 500,
      }),
    );
    expect(after.items.map((item) => item.text)).toEqual(["A note from the source thread"]);
    expect(f.store.getThreadRecord(target.id).unwrap().activeRunId).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("an agent starts, interrupts, steers, and queues on another thread", async () => {
  const gate = gatedModel(2);
  const { f, client, source, target, port, caller } = await setup(gate.model);
  const activeRun = () => f.store.getThreadRecord(target.id).unwrap().activeRunId;
  try {
    await setCrossThreadRuns(client, true);

    const started = value(
      await port.send(caller, target.id, {
        text: "Please hold for the report",
        mode: "auto",
        commandId: "report-1",
      }),
    );
    expect(started.disposition).toBe("started");
    const retried = value(
      await port.send(caller, target.id, {
        text: "Please hold for the report",
        mode: "auto",
        commandId: "report-1",
      }),
    );
    expect(retried.messageId).toBe(started.messageId);
    await gate.started(0);
    await until(f, () => activeRun() === started.runId);

    const stale = value(await port.interrupt(caller, target.id, { runId: "native:other:run" }));
    expect(stale.status).toBe("ended");
    const interrupted = value(await port.interrupt(caller, target.id, {}));
    expect(interrupted).toEqual({ status: "cancelled", runId: started.runId! });
    await until(f, () => activeRun() === undefined);
    expect(value(await port.interrupt(caller, target.id, {})).status).toBe("idle");

    const second = value(
      await port.send(caller, target.id, { text: "Now hold for the summary", mode: "auto" }),
    );
    expect(second.disposition).toBe("started");
    await gate.started(1);
    await until(f, () => activeRun() === second.runId);
    const steered = value(
      await port.send(caller, target.id, { text: "Include the totals", mode: "auto" }),
    );
    expect(steered).toMatchObject({ disposition: "steered", runId: second.runId });
    const queued = value(
      await port.send(caller, target.id, { text: "Then archive it", mode: "queue" }),
    );
    expect(queued.disposition).toBe("queued");

    gate.release();
    await until(
      f,
      () => activeRun() === undefined && f.store.listPendingInputs(target.id).unwrap().length === 0,
    );
    const history = value(
      await port.read(caller, target.id, { view: "messages", limit: 50, maxCharsPerItem: 200 }),
    );
    const texts = history.items.map((item) => item.text);
    expect(texts).toContain("Include the totals");
    expect(texts).toContain("Then archive it");

    const own = await port.send(caller, source.id, { text: "Talk to myself", mode: "auto" });
    expect(own.isErr()).toBe(true);
  } finally {
    gate.release();
    await f.close();
  }
});

test("thread control follows the caller's native access", async () => {
  const { f, target, port } = await setup();
  try {
    const { client: guestClient } = f.connect(await f.loginAs("guest", "guest-password"));
    const guestThread = await guestClient.threads.create({
      commandId: crypto.randomUUID(),
      title: "Guest",
    });
    const guest = { userId: "guest", sourceThreadId: guestThread.id };
    const read: Awaited<ReturnType<SurfaceThreadControlPort["read"]>> = await port.read(
      guest,
      target.id,
      { view: "messages", limit: 5, maxCharsPerItem: 100 },
    );
    expect(read.isErr()).toBe(true);
    const sent = await port.send(guest, target.id, { text: "hi", mode: "auto" });
    expect(sent.isErr()).toBe(true);

    // The caller must be the starter of the thread its run belongs to.
    const borrowed = await port.read(
      { userId: "guest", sourceThreadId: target.id },
      guestThread.id,
      { view: "messages", limit: 5, maxCharsPerItem: 100 },
    );
    expect(borrowed.isErr()).toBe(true);
  } finally {
    await f.close();
  }
});
