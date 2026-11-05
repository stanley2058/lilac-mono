import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Panic, Result } from "better-result";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils";
import { NativeStore } from "./store";
import { decodeNativeRecord } from "./codec";
import {
  createNativeTitleGeneration,
  parseNativeTitle,
  type GeneratedNativeTitle,
  type NativeTitleInput,
} from "./title-generation";

function fixture(autoTitle = true) {
  const store = new NativeStore(new Database(":memory:"));
  store.initialize().unwrap();
  store
    .initializeDeployment({
      titleModel: "fast",
      transport: "auto",
      outputStreaming: "paragraph",
      dmContextGapMs: 7_200_000,
      dmTimestampGapMs: 1_800_000,
      oldMessageSelectionMaxAgeMs: null,
      storageRetentionMaxAgeMs: null,
      crossThreadSend: { triggerRun: true },
    })
    .unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  const thread = store
    .createThread("owner", { commandId: "create", title: "First line", autoTitle })
    .unwrap();
  const input = store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "send",
      historyGeneration: 0,
      text: "First line\nExplain the problem",
      mode: "prompt",
      skillIds: [],
      attachmentIds: [],
    })
    .unwrap();
  return { store, thread, input };
}
function complete(f: ReturnType<typeof fixture>, answer = "The answer") {
  f.store
    .projectTurn(f.thread.id, 0, crypto.randomUUID(), f.input.turnId!, (slot) =>
      Result.ok({
        slot: {
          ...slot,
          state: "complete",
          messages: [
            ...slot.messages,
            {
              id: "intermediate",
              role: "assistant",
              parts: [{ type: "text", text: "Intermediate tool step" }],
            },
            { id: "final", role: "assistant", parts: [{ type: "text", text: answer }] },
          ],
        },
        changes: [],
      }),
    )
    .unwrap();
}
function waitForTitle(f: ReturnType<typeof fixture>, title: string) {
  if (f.store.getThreadRecord(f.thread.id).unwrap().title === title) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = f.store.subscribe(() => {
      if (f.store.getThreadRecord(f.thread.id).unwrap().title !== title) return;
      unsubscribe();
      resolve();
    });
  });
}
function controlled(f: ReturnType<typeof fixture>) {
  const first = Promise.withResolvers<NativeTitleInput>();
  const second = Promise.withResolvers<NativeTitleInput>();
  const firstResult = Promise.withResolvers<Result<GeneratedNativeTitle, Error>>();
  const secondResult = Promise.withResolvers<Result<GeneratedNativeTitle, Error>>();
  const calls: NativeTitleInput[] = [];
  const warnings: Error[] = [];
  const fatal: Error[] = [];
  const service = createNativeTitleGeneration({
    store: f.store,
    getConfig: () => parseCoreConfigV2ToUniversal({}),
    generate: (input) => {
      calls.push(input);
      if (calls.length === 1) {
        first.resolve(input);
        return firstResult.promise;
      }
      second.resolve(input);
      return secondResult.promise;
    },
    warn: (_message, error) => {
      warnings.push(error);
    },
    reportFatalError: (error) => {
      fatal.push(error);
    },
  });
  return { service, first, second, firstResult, secondResult, calls, warnings, fatal };
}

test("subagent display changes skip title generation without warnings", async () => {
  const f = fixture(false);
  const c = controlled(f);
  const stream = f.store
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: "parent-request",
      runId: "child-run",
      requestId: "child-request",
      messages: [],
      state: "running",
      startedAt: Date.now(),
    })
    .unwrap();
  expect(f.store.getTitleGeneration(stream.id).unwrap()).toBeNull();
  await new Promise<void>((resolve) => {
    const unsubscribe = f.store.subscribe((id) => {
      if (id !== stream.id) return;
      unsubscribe();
      resolve();
    });
    f.store.notifyDisplayChanged(stream.id);
  });
  await c.service.stop();
  expect(c.calls).toEqual([]);
  expect(c.warnings).toEqual([]);
  expect(c.fatal).toEqual([]);
  expect(f.store.getTitleGeneration("missing-thread").isErr()).toBe(true);
  f.store.close();
});

test("initial title is non-blocking and requests only user context", async () => {
  const f = fixture();
  const c = controlled(f);
  expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("First line");
  const request = await c.first.promise;
  expect(request.user).toBe("First line\nExplain the problem");
  expect(request.assistant).toBeUndefined();
  expect(request.titleModel).toBe("fast");
  c.firstResult.resolve(Result.ok({ title: "Specific subject", needsRefinement: false }));
  await waitForTitle(f, "Specific subject");
  complete(f);
  await c.service.stop();
  expect(c.calls).toHaveLength(1);
  expect(c.warnings).toEqual([]);
  f.store.close();
});

for (const finishFirst of [true, false])
  test(`refines exactly once when turn finishes ${finishFirst ? "before" : "after"} initial generation`, async () => {
    const f = fixture();
    const c = controlled(f);
    await c.first.promise;
    if (finishFirst) complete(f);
    c.firstResult.resolve(Result.ok({ title: "Initial subject", needsRefinement: true }));
    await waitForTitle(f, "Initial subject");
    if (!finishFirst) complete(f);
    const request = await c.second.promise;
    expect(request.user).toBe("First line\nExplain the problem");
    expect(request.assistant).toBe("The answer");
    c.secondResult.resolve(Result.ok({ title: "Refined subject", needsRefinement: true }));
    await waitForTitle(f, "Refined subject");
    expect(f.store.getThreadRecord(f.thread.id).unwrap().titleGeneration).toBeUndefined();
    await c.service.stop();
    expect(c.calls).toHaveLength(2);
    f.store.close();
  });

for (const phase of ["initial", "refine"] as const)
  test(`manual rename fences an in-flight ${phase} result, even with the same title`, async () => {
    const f = fixture();
    const c = controlled(f);
    await c.first.promise;
    if (phase === "refine") {
      complete(f);
      c.firstResult.resolve(Result.ok({ title: "First line", needsRefinement: true }));
      await c.second.promise;
    }
    f.store
      .updateThread("owner", { threadId: f.thread.id, commandId: "rename", title: "First line" })
      .unwrap();
    const pending = phase === "initial" ? c.firstResult : c.secondResult;
    pending.resolve(Result.ok({ title: "Unwanted title", needsRefinement: true }));
    await c.service.stop();
    // Also verify the store fence independently of stop cancellation.
    f.store
      .settleTitleGeneration(
        f.thread.id,
        { inputId: f.input.inputId, phase },
        { title: "Unwanted title", needsRefinement: true },
      )
      .unwrap();
    expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("First line");
    f.store.close();
  });

test("manual titles and existing records never enroll automatically", async () => {
  const f = fixture(false);
  expect(f.store.getTitleGeneration(f.thread.id).unwrap()).toBeNull();
  const record = f.store.getThreadRecord(f.thread.id).unwrap();
  expect(
    decodeNativeRecord({
      format_version: 1,
      data_json: JSON.stringify({ kind: "thread", value: record }),
    }).unwrap().value,
  ).toEqual({ kind: "thread", value: record });
  f.store.close();
});

test("failed generation keeps the fallback and does not retry", async () => {
  const f = fixture();
  const c = controlled(f);
  await c.first.promise;
  const failed = new Error("Provider unavailable");
  const settled = new Promise<void>((resolve) => {
    const unsubscribe = f.store.subscribe(() => {
      if (f.store.getThreadRecord(f.thread.id).unwrap().titleGeneration) return;
      unsubscribe();
      resolve();
    });
  });
  c.firstResult.resolve(Result.err(failed));
  await settled;
  complete(f);
  await c.service.stop();
  expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("First line");
  expect(c.calls).toHaveLength(1);
  expect(c.warnings).toEqual([failed]);
  f.store.close();
});

test("rewind and deletion fence stale generation results", () => {
  for (const action of ["rewind", "delete"]) {
    const f = fixture();
    const expected = f.store.getTitleGeneration(f.thread.id).unwrap()!;
    if (action === "rewind")
      f.store
        .beginRewind("owner", {
          threadId: f.thread.id,
          commandId: "rewind",
          turnId: f.input.turnId!,
          historyGeneration: 0,
          revision: f.store.getThreadRecord(f.thread.id).unwrap().revision,
        })
        .unwrap();
    else f.store.deleteThread("owner", { threadId: f.thread.id, commandId: "delete" }).unwrap();
    f.store
      .settleTitleGeneration(f.thread.id, expected, { title: "Stale", needsRefinement: true })
      .unwrap();
    expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("First line");
    expect(f.store.getTitleGeneration(f.thread.id).unwrap()).toBeNull();
    f.store.close();
  }
});

test("validates model output and rejects malformed, empty, multiline or oversized titles", () => {
  expect(
    parseNativeTitle('```json\n{"title":"Subject","needsRefinement":true}\n```').unwrap(),
  ).toEqual({ title: "Subject", needsRefinement: true });
  for (const value of [
    "invalid",
    "{}",
    JSON.stringify({ title: " ", needsRefinement: false }),
    JSON.stringify({ title: "a\nb", needsRefinement: false }),
    JSON.stringify({ title: "a".repeat(81), needsRefinement: false }),
  ])
    expect(parseNativeTitle(value).isErr()).toBe(true);
});

test("title context includes attachment names and bounds the assistant reply", () => {
  const f = fixture();
  const thread = f.store
    .createThread("owner", { commandId: "attachment-thread", autoTitle: true })
    .unwrap();
  const attachment = f.store
    .reserveUpload("owner", {
      threadId: thread.id,
      filename: "diagram.png",
      mediaType: "image/png",
      size: 123,
    })
    .unwrap();
  f.store
    .acceptInput("owner", {
      threadId: thread.id,
      commandId: "attachment-input",
      historyGeneration: 0,
      text: "",
      mode: "prompt",
      skillIds: [],
      attachmentIds: [attachment.id],
    })
    .unwrap();
  expect(f.store.getTitleGeneration(thread.id).unwrap()?.user).toContain("Attachment: diagram.png");
  f.store
    .settleTitleGeneration(
      f.thread.id,
      { inputId: f.input.inputId, phase: "initial" },
      { title: "Initial", needsRefinement: true },
    )
    .unwrap();
  complete(f, "x".repeat(5000));
  expect(f.store.getTitleGeneration(f.thread.id).unwrap()?.assistant).toHaveLength(4000);
  f.store.close();
});

test("shutdown aborts model work without applying a late title", async () => {
  const f = fixture();
  const c = controlled(f);
  const request = await c.first.promise;
  const stopped = c.service.stop();
  expect(request.signal.aborted).toBe(true);
  c.firstResult.resolve(Result.ok({ title: "Too late", needsRefinement: false }));
  await stopped;
  expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("First line");
  expect(c.warnings).toEqual([]);
  f.store.close();
});

test("refinement prefers the explicit final answer over later commentary", () => {
  const f = fixture();
  f.store
    .settleTitleGeneration(
      f.thread.id,
      { inputId: f.input.inputId, phase: "initial" },
      { title: "Initial", needsRefinement: true },
    )
    .unwrap();
  f.store
    .projectTurn(f.thread.id, 0, "phases", f.input.turnId!, (slot) =>
      Result.ok({
        slot: {
          ...slot,
          state: "complete",
          messages: [
            ...slot.messages,
            {
              id: "answer",
              role: "assistant",
              metadata: { phase: "final" },
              parts: [{ type: "text", text: "Actual final answer" }],
            },
            {
              id: "commentary",
              role: "assistant",
              metadata: { phase: "commentary" },
              parts: [{ type: "text", text: "Later commentary" }],
            },
          ],
        },
        changes: [],
      }),
    )
    .unwrap();
  expect(f.store.getTitleGeneration(f.thread.id).unwrap()?.assistant).toBe("Actual final answer");
  f.store.close();
});

test("shutdown preserves a model Panic and reports its original identity", async () => {
  const f = fixture();
  const c = controlled(f);
  await c.first.promise;
  const stopped = c.service.stop();
  const defect = new Panic({ message: "Title model defect" });
  c.firstResult.resolve(Result.err(defect));
  await stopped;
  expect(c.fatal).toEqual([defect]);
  expect(c.fatal[0]).toBe(defect);
  expect(c.warnings).toEqual([]);
  expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("First line");
  f.store.close();
});

test("child task title generation preserves explicit titles and survives completion", () => {
  const f = fixture();
  f.store.settleInput(f.input.inputId, "admitted").unwrap();
  const child = f.store
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: f.store.getInput(f.input.inputId).unwrap().requestId,
      runId: "child",
      requestId: "request",
      messages: [],
      state: "running",
      startedAt: 1,
      titlePrompt: "Check migration compatibility across versions",
    })
    .unwrap();
  const job = f.store.getTitleGeneration(child.id).unwrap()!;
  expect(job.user).toBe("Check migration compatibility across versions");
  f.store
    .settleTitleGeneration(child.id, job, {
      title: "Check migration compatibility",
      needsRefinement: false,
    })
    .unwrap();
  for (const spec of ["codex/gpt-6-astra", "openai/gpt-6-astra"]) {
    f.store
      .projectTurn(child.id, child.historyGeneration, spec, child.turnId, (slot) =>
        Result.ok({
          slot,
          changes: [],
          model: { spec, reasoning: "high" },
        }),
      )
      .unwrap();
  }
  const titled = f.store.findAgentStream("child").unwrap()!;
  expect(titled.model).toBe("openai/gpt-6-astra");
  expect(titled.reasoning).toBe("high");
  f.store.settleAgentStream(titled, "complete").unwrap();
  expect(f.store.findAgentStream("child").unwrap()?.taskTitle).toBe(
    "Check migration compatibility",
  );
  const explicit = f.store
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId: f.store.getInput(f.input.inputId).unwrap().requestId,
      runId: "explicit",
      requestId: "explicit-request",
      messages: [],
      state: "running",
      startedAt: 1,
      taskTitle: "Review config",
      titlePrompt: "Something else",
    })
    .unwrap();
  expect(f.store.getTitleGeneration(explicit.id).unwrap()).toBeNull();
});

function regenerationFixture() {
  const f = fixture(false);
  complete(f, "Opening answer");
  const later = f.store
    .acceptInput("owner", {
      threadId: f.thread.id,
      commandId: "later",
      historyGeneration: 0,
      text: "Now help me deploy it",
      mode: "prompt",
      skillIds: [],
      attachmentIds: [],
    })
    .unwrap();
  f.store.settleInput(f.input.inputId, "admitted").unwrap();
  f.store.markInputCompleted(f.input.inputId).unwrap();
  const turnId = f.store.prepareInput(later.inputId).unwrap()?.turnId;
  complete({ ...f, input: { ...later, turnId } }, "Deployment answer");
  return { f, c: controlled(f) };
}

test("regenerating a title summarizes the whole conversation", async () => {
  const { f, c } = regenerationFixture();
  const pending = c.service.regenerate(f.thread.id);
  const input = await c.first.promise;
  expect(input.conversation).toEqual([
    { role: "user", text: "First line\nExplain the problem" },
    { role: "assistant", text: "Opening answer" },
    { role: "user", text: "Now help me deploy it" },
    { role: "assistant", text: "Deployment answer" },
  ]);
  c.firstResult.resolve(Result.ok({ title: "Deploying the fix", needsRefinement: false }));
  (await pending).unwrap();
  expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("Deploying the fix");
  await c.service.stop();
  f.store.close();
});

test("a manual rename during regeneration keeps the manual title", async () => {
  const { f, c } = regenerationFixture();
  const pending = c.service.regenerate(f.thread.id);
  await c.first.promise;
  f.store
    .updateThread("owner", { threadId: f.thread.id, commandId: "rename", title: "Manual" })
    .unwrap();
  c.firstResult.resolve(Result.ok({ title: "Generated", needsRefinement: false }));
  expect((await pending).isErr()).toBe(true);
  expect(f.store.getThreadRecord(f.thread.id).unwrap().title).toBe("Manual");
  await c.service.stop();
  f.store.close();
});

test("regenerating a title requires a message", async () => {
  const f = fixture(false);
  const empty = f.store
    .createThread("owner", { commandId: "empty", title: "Empty", autoTitle: false })
    .unwrap();
  const c = controlled(f);
  expect((await c.service.regenerate(empty.id)).isErr()).toBe(true);
  expect(c.calls).toHaveLength(0);
  await c.service.stop();
  f.store.close();
});
