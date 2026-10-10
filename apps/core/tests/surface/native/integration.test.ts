import { Result } from "better-result";
import { projectNativeOutput } from "../../../src/surface/native/output-projection";
import { Attachment } from "../../../src/tool-server/tools/attachment";
import { readFile, rm } from "node:fs/promises";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createNativeIntegrationFixture,
  integrationValue,
  nativeFixtureTextResponse,
} from "./integration-fixture";
import type { NativeStore } from "../../../src/surface/native/store";

function waitForStore(store: NativeStore, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const stop = store.subscribeChanges(() => {
      if (!predicate()) return;
      stop();
      resolve();
    });
    if (predicate()) {
      stop();
      resolve();
    }
  });
}

function completed(store: NativeStore, inputId: string) {
  return waitForStore(
    store,
    () => integrationValue(store.getInput(inputId)).completedAt !== undefined,
  );
}

function nativePrompt(
  threadId: string,
  text: string,
  mode: "prompt" | "steer" | "followup" = "prompt",
) {
  return {
    threadId,
    text,
    mode,
    commandId: crypto.randomUUID(),
    historyGeneration: 0,
    attachmentIds: [],
    skillIds: [],
  };
}

describe("native runtime integration", () => {
  test("attachment.add_files stores native resources and links projected replies", async () => {
    let fixture: Awaited<ReturnType<typeof createNativeIntegrationFixture>>;
    let threadId = "";
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const thread = fixture.store.getThreadRecord(threadId).unwrap();
        const tool = new Attachment({
          bus: fixture.bus,
          blobStore: fixture.blobs,
          outputLifecycle: {
            registerOutputHandle: () => {
              throw new Error("Native attachments must use native resources");
            },
          },
          nativeOutput: fixture.runtime.attachmentOutput,
        });
        const filename = path.join(fixture.workspaceRoot, "report.txt");
        await writeFile(filename, "native attachment bytes");
        const context = {
          requestId: thread.activeRunId!,
          requestClient: "native",
          sessionId: `native:${threadId}`,
          serverOwnedRequest: true,
          requestInitiator: { platform: "native" as const, userId: thread.starterId },
          requestInitiatorSessionId: threadId,
          cwd: fixture.workspaceRoot,
        };
        const denied = await tool.call(
          "attachment.add_files",
          { paths: [filename] },
          { context: { ...context, serverOwnedRequest: false } },
        );
        expect(denied.isErr()).toBe(true);
        const sent = await tool.call("attachment.add_files", { paths: [filename] }, { context });
        expect(sent.match({ ok: () => null, err: (error) => error })).toBeNull();
        await rm(filename);
        return nativeFixtureTextResponse("Attached report.");
      },
    });
    fixture = await createNativeIntegrationFixture({ model });
    try {
      const { client } = fixture.connect();
      const viewer = (await client.bootstrap.get({})).viewer;
      const thread = await client.threads.create({
        commandId: crypto.randomUUID(),
        title: "Attachments",
      });
      threadId = thread.id;
      const receipt = await client.inputs.submit(nativePrompt(threadId, "Create a report"));
      await completed(fixture.store, receipt.inputId);
      await waitForStore(fixture.store, () => {
        const snapshot = fixture.store.sync(viewer.id, threadId).unwrap();
        return (
          snapshot.kind === "window" &&
          snapshot.slots.some((slot) => slot.kind === "ready" && slot.state === "complete")
        );
      });
      const snapshot = await client.threads.sync({ threadId });
      if (snapshot.kind !== "window") throw new Error("Expected native window");
      const parts = snapshot.slots.flatMap((slot) =>
        slot.kind === "ready" ? slot.messages.flatMap((message) => message.parts) : [],
      );
      const resource = parts.find((part) => part.type === "data-resource");
      expect(resource?.data).toMatchObject({ name: "report.txt", state: "ready" });
      if (!resource) throw new Error("Missing native resource");
      const upload = fixture.store.readUpload(viewer.id, resource.data.resourceId).unwrap();
      expect(upload.published).toBe(true);
      const access = fixture.runtime.resources.scopedAccess(viewer.id);
      await mkdir(path.join(fixture.workspaceRoot, "downloads"));
      const materialized = (
        await access.materialize(upload.resourceUri!, {
          targetDirectory: path.join(fixture.workspaceRoot, "downloads"),
          maxBytes: 1024,
        })
      ).unwrap();
      expect(await readFile(materialized.path, "utf8")).toBe("native attachment bytes");
      const links = fixture.store.listProjectedMessageLinks().unwrap();
      expect(links).toHaveLength(1);
      expect(links[0]!.messageIds).toHaveLength(2);
      expect(fixture.transcript.listRecentAgentWrites({ client: "native" })).toHaveLength(1);
      expect(fixture.fatalErrors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("startup restores only historical replies with known request ownership", async () => {
    let requestId = "";
    let projectedId = "";
    const fixture = await createNativeIntegrationFixture({
      seed: (store, transcript) => {
        const thread = store.createThread("owner", { commandId: "legacy-thread" }).unwrap();
        const receipt = store
          .acceptInput("owner", nativePrompt(thread.id, "Old question"))
          .unwrap();
        const input = store.getInput(receipt.inputId).unwrap();
        requestId = input.requestId;
        store.settleInput(input.id, "admitted").unwrap();
        store.markInputCompleted(input.id).unwrap();
        store
          .projectTurn(thread.id, 0, "old-event", input.turnId!, (slot, projection) => {
            const next = projectNativeOutput(
              slot,
              {
                threadId: thread.id,
                turnId: input.turnId!,
                generation: 0,
                requestId,
                attemptId: "old-attempt",
                sequence: 1,
                ordinal: 1,
                eventId: "old-event",
                occurredAt: 100,
                payload: {
                  type: "text",
                  stepId: "old-step",
                  position: 1,
                  partId: "text",
                  phase: "final_answer",
                  text: "Legacy answer",
                  incomplete: false,
                },
              },
              projection,
            );
            const answer = next.slot.messages.at(-1)!;
            projectedId = answer.id;
            delete answer.metadata!.authorId;
            return Result.ok(next);
          })
          .unwrap();
        store
          .postMessage("owner", thread.id, {
            id: "unknown-standalone",
            role: "assistant",
            metadata: { authorId: "lilac" },
            parts: [{ type: "text", text: "No known request" }],
          })
          .unwrap();
        transcript
          .saveRequestTranscript({
            requestId,
            sessionId: `native:${thread.id}`,
            requestClient: "native",
            messages: [],
            finalText: "Legacy answer",
          })
          .unwrap();
        expect(transcript.listSurfaceMessagesForRequest({ requestId })).toEqual([]);
      },
    });
    try {
      await fixture.runtime.stopOutput();
      (await fixture.runtime.startOutput()).unwrap();
      expect(
        fixture.transcript.listSurfaceMessagesForRequest({ requestId }).map((ref) => ref.messageId),
      ).toEqual([projectedId]);
      await fixture.runtime.stopOutput();
      (await fixture.runtime.startOutput()).unwrap();
      expect(
        fixture.transcript.listSurfaceMessagesForRequest({ requestId }).map((ref) => ref.messageId),
      ).toEqual([projectedId]);
    } finally {
      await fixture.close();
    }
  });

  test("sidebar pagination crosses the RPC boundary with more than 100 conversations", async () => {
    const fixture = await createNativeIntegrationFixture();
    try {
      const { client } = fixture.connect();
      const bootstrap = await client.bootstrap.get({});
      const ids = Array.from(
        { length: 101 },
        (_, index) =>
          fixture.store
            .createThread(bootstrap.viewer.id, {
              commandId: `page-${index}`,
              title: `Thread ${index}`,
            })
            .unwrap().id,
      );
      const first = await client.sidebar.list({ section: "active", limit: 100 });
      expect(first.items).toHaveLength(100);
      expect(first.total).toBe(101);
      expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      const second = await client.sidebar.list({
        section: "active",
        limit: 100,
        cursor: first.nextCursor,
      });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeUndefined();
      expect([...first.items, ...second.items].map((thread) => thread.id).sort()).toEqual(
        ids.sort(),
      );
    } finally {
      await fixture.close();
    }
  });

  test("local login, socket prompt, durable output and unchanged two-device replay", async () => {
    const fixture = await createNativeIntegrationFixture();
    try {
      const first = fixture.connect();
      const bootstrap = await first.client.bootstrap.get({});
      expect(bootstrap.viewer.role).toBe("owner");
      const thread = await first.client.threads.create({
        commandId: crypto.randomUUID(),
        title: "Integration",
      });
      const events = await first.client.threads.watch({ threadId: thread.id });
      await events.next();
      const committedText: string[] = [];
      const observe = (async () => {
        for await (const event of events) {
          const changes =
            event.kind === "update"
              ? event.update.changes
              : event.kind === "replay" && event.reply.kind === "delta"
                ? event.reply.changes
                : [];
          for (const change of changes) {
            if (change.kind === "set-part" && change.part.type === "text")
              committedText.push(change.part.text);
            if (change.kind === "append-text") committedText.push(change.text);
          }
          if (changes.some((change) => change.kind === "turn-state" && change.state === "complete"))
            return;
        }
      })();
      const receipt = await first.client.inputs.submit({
        threadId: thread.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        text: "Hello native",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      });
      await completed(fixture.store, receipt.inputId);
      await observe;
      expect(committedText).toEqual(["Fixture response.\n\n", "Ready for the next message."]);
      const snapshot = await first.client.threads.sync({ threadId: thread.id });
      expect(snapshot.kind).toBe("window");
      if (snapshot.kind !== "window") throw new Error("Expected initial native window");
      expect(JSON.stringify(snapshot)).toContain("Fixture response.");
      expect(
        snapshot.slots.some((slot) => slot.kind === "ready" && slot.state === "complete"),
      ).toBe(true);
      first.socket.close();
      const second = fixture.connect();
      await second.client.bootstrap.get({});
      second.resetTraffic();
      const replay = await second.client.threads.sync({
        threadId: thread.id,
        checkpoint: snapshot.checkpoint,
      });
      expect(replay.kind).toBe("unchanged");
      expect(second.traffic.sent + second.traffic.received).toBeLessThan(1024);
      expect(fixture.fatalErrors).toEqual([]);
      expect(fixture.warnings).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

test("rewind removes discarded model context and reconnect cannot restore its suffix", async () => {
  const prompts: string[] = [];
  const fixture = await createNativeIntegrationFixture({
    model: new MockLanguageModelV4({
      modelId: "rewind-fixture",
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        return nativeFixtureTextResponse(`reply-${prompts.length}`);
      },
    }),
  });
  try {
    const { client } = fixture.connect();
    const thread = await client.threads.create({ commandId: crypto.randomUUID(), title: "Rewind" });
    const first = await client.inputs.submit({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text: "keep-first",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    });
    await completed(fixture.store, first.inputId);
    const second = await client.inputs.submit({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text: "erase-second",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    });
    await completed(fixture.store, second.inputId);
    const before = await client.threads.sync({ threadId: thread.id });
    if (!second.turnId) throw new Error("Full turn missing stable identity");
    const rewind = await client.threads.rewind({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      expectedRevision: before.checkpoint.projectionRevision,
      turnId: second.turnId,
    });
    expect(rewind.text).toBe("erase-second");
    expect(rewind.checkpoint.historyGeneration).toBe(1);
    const staleReplay = await fixture
      .connect()
      .client.threads.sync({ threadId: thread.id, checkpoint: before.checkpoint });
    expect(staleReplay.kind).toBe("window");
    expect(staleReplay.checkpoint.historyGeneration).toBe(1);
    expect(JSON.stringify(staleReplay)).not.toContain("erase-second");
    const replacement = await client.inputs.submit({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 1,
      text: "replacement-third",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    });
    await completed(fixture.store, replacement.inputId);
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("keep-first");
    expect(prompts[2]).toContain("reply-1");
    expect(prompts[2]).toContain("replacement-third");
    expect(prompts[2]).not.toContain("erase-second");
    expect(prompts[2]).not.toContain("reply-2");
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("file input is acknowledged before upload and model admission waits for its resource URI", async () => {
  const prompts: string[] = [];
  const fixture = await createNativeIntegrationFixture({
    model: new MockLanguageModelV4({
      modelId: "upload-fixture",
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        return nativeFixtureTextResponse("File received.");
      },
    }),
  });
  try {
    const { client } = fixture.connect();
    const thread = await client.threads.create({ commandId: crypto.randomUUID(), title: "Upload" });
    const bytes = new TextEncoder().encode("native attachment contents");
    const upload = await client.resources.reserve({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      name: "report.txt",
      mediaType: "text/plain",
      size: bytes.byteLength,
    });
    const receipt = await client.inputs.submit({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      text: "Inspect upload",
      mode: "prompt",
      attachmentIds: [upload.id],
      skillIds: [],
    });
    expect(receipt.state).toBe("uploading");
    expect(prompts).toHaveLength(0);
    const pending = await client.threads.sync({ threadId: thread.id });
    expect(JSON.stringify(pending)).toContain("report.txt");
    expect(JSON.stringify(pending)).toContain("pending");
    const response = await fetch(new URL(`api/uploads/${upload.id}`, fixture.url), {
      method: "PUT",
      headers: { authorization: `Bearer ${fixture.token}` },
      body: bytes,
    });
    expect(response.status).toBe(200);
    await completed(fixture.store, receipt.inputId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("resource://");
    const final = await client.resources.get({ resourceId: upload.id });
    expect(final.state).toBe("ready");
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("two sockets steer the active turn, remove queued input and cancel the remaining followups", async () => {
  const started = Promise.withResolvers<void>();
  let modelCalls = 0;
  const fixture = await createNativeIntegrationFixture({
    model: new MockLanguageModelV4({
      modelId: "cancel-fixture",
      doStream: async ({ abortSignal }) => {
        modelCalls += 1;
        started.resolve();
        await new Promise<void>((resolve) => {
          if (abortSignal?.aborted) return resolve();
          abortSignal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw Object.assign(new Error("Fixture canceled"), { name: "AbortError" });
      },
    }),
  });
  try {
    const first = fixture.connect().client;
    const second = fixture.connect().client;
    const thread = await first.threads.create({ commandId: crypto.randomUUID(), title: "Queue" });
    const active = await first.inputs.submit(nativePrompt(thread.id, "Begin"));
    await started.promise;
    const steer = await second.inputs.submit(nativePrompt(thread.id, "Adjust direction", "steer"));
    expect(steer.turnId).toBe(active.turnId);
    expect(steer.runId).toBe(integrationValue(fixture.store.getInput(active.inputId)).requestId);
    const removed = await first.inputs.submit(nativePrompt(thread.id, "Remove this", "followup"));
    const dropped = await second.inputs.submit(
      nativePrompt(thread.id, "Drop on cancel", "followup"),
    );
    expect(
      (await first.runs.queue({ threadId: thread.id })).items.map((item) => item.inputId),
    ).toEqual([removed.inputId, dropped.inputId]);
    await second.runs.removeQueued({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      inputId: removed.inputId,
    });
    expect(
      (await first.runs.queue({ threadId: thread.id })).items.map((item) => item.inputId),
    ).toEqual([dropped.inputId]);
    await second.runs.cancel({
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      runId: active.runId,
    });
    expect((await first.runs.queue({ threadId: thread.id })).items).toEqual([]);
    expect(integrationValue(fixture.store.getInput(removed.inputId)).state).toBe("canceled");
    expect(integrationValue(fixture.store.getInput(dropped.inputId)).state).toBe("canceled");
    expect(fixture.runner.getActiveLevel1Work()).toEqual([]);
    expect(modelCalls).toBe(1);
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a queued followup becomes a new full turn after the active turn settles", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const prompts: string[] = [];
  const fixture = await createNativeIntegrationFixture({
    model: new MockLanguageModelV4({
      modelId: "followup-fixture",
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        if (prompts.length === 1) {
          started.resolve();
          await release.promise;
        }
        return nativeFixtureTextResponse(`Response ${prompts.length}`);
      },
    }),
  });
  try {
    const client = fixture.connect().client;
    const thread = await client.threads.create({
      commandId: crypto.randomUUID(),
      title: "Followup",
    });
    const active = await client.inputs.submit(nativePrompt(thread.id, "First input"));
    await started.promise;
    const followup = await client.inputs.submit(
      nativePrompt(thread.id, "Next full turn", "followup"),
    );
    expect(followup.state).toBe("queued");
    release.resolve();
    await completed(fixture.store, followup.inputId);
    const accepted = integrationValue(fixture.store.getInput(followup.inputId));
    expect(accepted.turnId).toBeDefined();
    expect(accepted.turnId).not.toBe(active.turnId);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("First input");
    expect(prompts[1]).toContain("Response 1");
    expect(prompts[1]).toContain("Next full turn");
    expect((await client.runs.queue({ threadId: thread.id })).items).toEqual([]);
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    release.resolve();
    await fixture.close();
  }
});

test("shared reader sees only shared threads and cannot mutate their owner history or configuration", async () => {
  const fixture = await createNativeIntegrationFixture({
    additionalLocalUsers: [
      { userId: "reader", username: "reader", password: "reader-fixture-password" },
    ],
  });
  try {
    const owner = fixture.connect().client;
    const reader = fixture.connect(
      await fixture.loginAs("reader", "reader-fixture-password"),
    ).client;
    const shared = await owner.threads.create({ commandId: crypto.randomUUID(), title: "Shared" });
    const hidden = await owner.threads.create({ commandId: crypto.randomUUID(), title: "Private" });
    const receipt = await owner.inputs.submit(nativePrompt(shared.id, "Visible conversation"));
    await completed(fixture.store, receipt.inputId);
    expect((await reader.threads.list({})).items).toEqual([]);
    await owner.participants.set({ threadId: shared.id, userId: "reader", role: "read" });
    const list = await reader.threads.list({});
    expect(list.items.map((item) => item.id)).toEqual([shared.id]);
    expect(list.items[0]?.capabilities).toEqual({ read: true, edit: false, share: false });
    const history = await reader.threads.sync({ threadId: shared.id });
    expect(JSON.stringify(history)).toContain("Visible conversation");
    await expect(reader.threads.sync({ threadId: hidden.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      reader.inputs.submit(nativePrompt(shared.id, "Cannot write")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      reader.runs.cancel({
        threadId: shared.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    if (!receipt.turnId) throw new Error("Missing full turn identity");
    await expect(
      reader.threads.rewind({
        threadId: shared.id,
        commandId: crypto.randomUUID(),
        historyGeneration: 0,
        expectedRevision: history.checkpoint.projectionRevision,
        turnId: receipt.turnId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reader.config.read({ kind: "core" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = await reader.threads.create({
      commandId: crypto.randomUUID(),
      title: "Participant started",
    });
    expect(own.starterId).toBe("reader");
    expect((await owner.threads.list({})).items).toHaveLength(3);
    await owner.participants.remove({ threadId: shared.id, userId: "reader" });
    await expect(reader.threads.sync({ threadId: shared.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test.each(["success", "error", "cancel"] as const)(
  "custom command publishes durable running and settled activity on %s",
  async (outcome) => {
    let commandModule: { release: { resolve: () => void } } | undefined;
    const modelPrompts: string[] = [];
    const fixture = await createNativeIntegrationFixture({
      prepare: async ({ dataDir }) => {
        const directory = path.join(dataDir, "cmds", "activity-fixture");
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "def.json"),
          JSON.stringify({
            name: "activity-fixture",
            description: "Controlled integration command",
            args: [],
          }),
        );
        const entrypoint = path.join(directory, "index.ts");
        await writeFile(
          entrypoint,
          `
export const release = Promise.withResolvers();
export async function execute(_args, context) {
  await Promise.race([release.promise, new Promise(resolve => {
    if (context.abortSignal.aborted) return resolve();
    context.abortSignal.addEventListener("abort", resolve, { once: true });
  })]);
  ${outcome === "error" ? 'throw new Error("Controlled command failure");' : 'return { type: "text", value: "Controlled command result" };'}
}
`,
        );
        commandModule = await import(pathToFileURL(entrypoint).href);
      },
      model: new MockLanguageModelV4({
        doStream: async ({ prompt }) => {
          modelPrompts.push(JSON.stringify(prompt));
          return nativeFixtureTextResponse("Command handled.");
        },
      }),
    });
    try {
      const client = fixture.connect().client;
      const thread = await client.threads.create({
        commandId: crypto.randomUUID(),
        title: "Command activity",
      });
      const events = await client.threads.watch({ threadId: thread.id });
      await events.next();
      const running = Promise.withResolvers<void>();
      const activityStates: string[] = [];
      let terminalSeen = false;
      const observe = (async () => {
        for await (const event of events) {
          const changes =
            event.kind === "update"
              ? event.update.changes
              : event.kind === "replay" && event.reply.kind === "delta"
                ? event.reply.changes
                : [];
          for (const change of changes) {
            if (change.kind !== "set-part" || change.part.type !== "data-activity") continue;
            expect(change.part.data.label).toContain("activity-fixture");
            activityStates.push(change.part.data.state);
            if (change.part.data.state === "running") running.resolve();
          }
          terminalSeen ||= changes.some(
            (change) => change.kind === "turn-state" && change.state !== "running",
          );
          if (terminalSeen && activityStates.some((state) => state !== "running")) return;
        }
      })();
      const receipt = await client.inputs.submit({
        ...nativePrompt(thread.id, "Handle the command result"),
        command: { id: "custom:activity-fixture", arguments: "" },
      });
      await running.promise;
      const active = await client.threads.sync({ threadId: thread.id });
      expect(JSON.stringify(active)).toContain('"state":"running"');
      if (outcome === "cancel")
        await client.runs.cancel({
          threadId: thread.id,
          commandId: crypto.randomUUID(),
          historyGeneration: 0,
        });
      else commandModule?.release.resolve();
      await observe;
      if (outcome !== "cancel") await completed(fixture.store, receipt.inputId);
      expect(activityStates).toEqual(["running", outcome === "success" ? "complete" : "failed"]);
      const replay = await fixture.connect().client.threads.sync({ threadId: thread.id });
      expect(JSON.stringify(replay)).toContain("activity-fixture");
      expect(modelPrompts).toHaveLength(outcome === "success" ? 1 : 0);
      if (outcome === "success") expect(modelPrompts[0]).toContain("Controlled command result");
      expect(fixture.fatalErrors).toEqual([]);
    } finally {
      commandModule?.release.resolve();
      await fixture.close();
    }
  },
);

test("custom command submissions with invalid arguments are rejected before admission", async () => {
  const fixture = await createNativeIntegrationFixture({
    prepare: async ({ dataDir }) => {
      const directory = path.join(dataDir, "cmds", "typed-fixture");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "def.json"),
        JSON.stringify({
          name: "typed-fixture",
          description: "Typed integration command",
          args: [
            { key: "count", type: "number", required: true },
            { key: "mode", type: "string", choices: ["single", "spread"] },
          ],
        }),
      );
      await writeFile(
        path.join(directory, "index.ts"),
        'export function execute() { return { type: "text", value: "unused" }; }\n',
      );
    },
  });
  try {
    const client = fixture.connect().client;
    const thread = await client.threads.create({
      commandId: crypto.randomUUID(),
      title: "Typed command",
    });
    for (const [args, message] of [
      ["", "Missing required argument 'count'."],
      ["three", "Expected a number, got 'three'."],
      ["3 mode=triple", "Argument 'mode' must be one of: single, spread."],
    ] as const)
      await expect(
        client.inputs.submit({
          ...nativePrompt(thread.id, ""),
          command: { id: "custom:typed-fixture", arguments: args },
        }),
      ).rejects.toMatchObject({ message });
    expect((await client.runs.queue({ threadId: thread.id })).items).toEqual([]);
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("a custom command submitted as steering queues and executes in its own full turn", async () => {
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const modelPrompts: string[] = [];
  let commandModule: { calls: number } | undefined;
  const fixture = await createNativeIntegrationFixture({
    prepare: async ({ dataDir }) => {
      const directory = path.join(dataDir, "cmds", "queued-fixture");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "def.json"),
        JSON.stringify({
          name: "queued-fixture",
          description: "Queued integration command",
          args: [],
        }),
      );
      const entrypoint = path.join(directory, "index.ts");
      await writeFile(
        entrypoint,
        'export let calls = 0; export function execute() { calls += 1; return { type: "text", value: "Queued command result" }; }\n',
      );
      commandModule = await import(pathToFileURL(entrypoint).href);
    },
    model: new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        modelPrompts.push(JSON.stringify(prompt));
        if (modelPrompts.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return nativeFixtureTextResponse(`Finished full turn ${modelPrompts.length}`);
      },
    }),
  });
  try {
    const client = fixture.connect().client;
    const thread = await client.threads.create({
      commandId: crypto.randomUUID(),
      title: "Queued command",
    });
    const first = await client.inputs.submit(
      nativePrompt(thread.id, "Keep the first turn running"),
    );
    await firstStarted.promise;
    const command = await client.inputs.submit({
      ...nativePrompt(thread.id, "Use the queued command result", "steer"),
      command: { id: "custom:queued-fixture", arguments: "" },
    });
    expect(command.state).toBe("queued");
    expect(commandModule?.calls).toBe(0);
    const queue = await client.runs.queue({ threadId: thread.id });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.mode).toBe("followup");
    expect(queue.items[0]?.inputId).toBe(command.inputId);
    releaseFirst.resolve();
    await completed(fixture.store, command.inputId);
    const accepted = integrationValue(fixture.store.getInput(command.inputId));
    expect(accepted.mode).toBe("followup");
    expect(accepted.turnId).toBeDefined();
    expect(accepted.turnId).not.toBe(first.turnId);
    expect(commandModule?.calls).toBe(1);
    expect(modelPrompts).toHaveLength(2);
    expect(modelPrompts[0]).not.toContain("Use the queued command result");
    expect(modelPrompts[1]).toContain("Finished full turn 1");
    expect(modelPrompts[1]).toContain("Use the queued command result");
    expect(modelPrompts[1]).toContain("Queued command result");
    expect((await client.runs.queue({ threadId: thread.id })).items).toEqual([]);
    expect(fixture.fatalErrors).toEqual([]);
  } finally {
    releaseFirst.resolve();
    await fixture.close();
  }
});
