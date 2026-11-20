import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import { NativeStore } from "./store";

function fixture() {
  let now = 1_000_000;
  const store = new NativeStore(new Database(":memory:"), () => now);
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
  for (const id of ["owner", "lilac"] as const)
    store
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "service",
        toolMode: "full",
      })
      .unwrap();
  const dm = store.ensureDirectThread("owner").unwrap();
  function send(commandId: string, attachments: string[] = []) {
    return store
      .acceptInput("owner", {
        threadId: dm.id,
        commandId,
        historyGeneration: store.getThreadRecord(dm.id).unwrap().historyGeneration,
        text: commandId,
        mode: "prompt",
        attachmentIds: attachments,
        skillIds: [],
      })
      .unwrap();
  }
  function settle(
    input: ReturnType<typeof send>,
    state: "complete" | "failed" | "canceled" = "complete",
  ) {
    store.settleInput(input.inputId, "admitted").unwrap();
    const generation = store.getThreadRecord(dm.id).unwrap().historyGeneration;
    store
      .projectTurn(dm.id, generation, `settled_${input.inputId}`, input.turnId!, (slot) =>
        Result.ok({ slot: { ...slot, state, settledAt: now }, changes: [] }),
      )
      .unwrap();
    store.markInputCompleted(input.inputId).unwrap();
  }
  function request(turnId: string, commandId = `rewind_${turnId}`) {
    const thread = store.getThreadRecord(dm.id).unwrap();
    return {
      threadId: dm.id,
      turnId,
      commandId,
      historyGeneration: thread.historyGeneration,
      revision: thread.revision,
    };
  }
  function rewind(turnId: string) {
    return store.beginRewind("owner", request(turnId));
  }
  return {
    store,
    dm,
    send,
    settle,
    request,
    rewind,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("DM rewind", () => {
  for (const state of ["complete", "failed", "canceled"] as const) {
    test(`rewinds a ${state} turn and deduplicates the command after expiry`, () => {
      const f = fixture();
      const input = f.send("prompt");
      f.advance(3_600_000);
      f.settle(input, state);
      f.advance(1_799_999);
      const request = f.request(input.turnId!);
      const reply = f.store.beginRewind("owner", request).unwrap();
      expect(reply.text).toBe("prompt");
      expect(reply.historyGeneration).toBe(1);
      f.store.finishMutation(f.dm.id, 1).unwrap();
      f.advance(1_800_000);
      expect(f.store.beginRewind("owner", request).unwrap()).toEqual(reply);
      expect(f.store.getLatestCanonicalRequestId(f.dm.id).unwrap()).toBeNull();
      f.store.close();
    });
  }

  for (const state of ["failed", "canceled"] as const) {
    test(`rewinds an input ${state} before admission`, () => {
      const f = fixture();
      const input = f.send("prompt");
      f.store.settleInput(input.inputId, state).unwrap();
      expect(f.rewind(input.turnId!).unwrap().text).toBe("prompt");
      f.store.close();
    });
  }

  test("queued follow-ups block rewinding a settled turn", () => {
    const f = fixture();
    const input = f.send("prompt");
    f.settle(input);
    f.store
      .acceptInput("owner", {
        threadId: f.dm.id,
        commandId: "queued",
        historyGeneration: 0,
        text: "follow-up",
        mode: "followup",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    expect(
      f.rewind(input.turnId!).match({ ok: () => undefined, err: (error) => error.message }),
    ).toBe("Wait for active and queued messages to finish.");
    f.store.close();
  });

  test("chains only through latest turns without resetting earlier settlement times", () => {
    const f = fixture();
    const first = f.send("first");
    f.settle(first);
    f.advance(1000);
    const second = f.send("second");
    f.settle(second);
    f.advance(1000);
    const third = f.send("third");
    f.settle(third);
    expect(f.rewind(first.turnId!).isErr()).toBe(true);
    const latest = f.rewind(third.turnId!).unwrap();
    f.store.finishMutation(f.dm.id, latest.historyGeneration!).unwrap();
    const previous = f.rewind(second.turnId!).unwrap();
    f.store.finishMutation(f.dm.id, previous.historyGeneration!).unwrap();
    f.advance(1_798_000);
    expect(
      f.rewind(first.turnId!).match({ ok: () => undefined, err: (error) => error.message }),
    ).toBe("The rewind window has expired.");
    expect(f.store.getThreadRecord(f.dm.id).unwrap().historyGeneration).toBe(2);
    f.store.close();
  });

  test("uses the current timestamp gap setting at the exact expiry boundary", () => {
    const f = fixture();
    const input = f.send("prompt");
    f.settle(input);
    const deployment = f.store.getDeployment().unwrap();
    f.store
      .setDeployment("owner", {
        expectedRevision: deployment.revision,
        settings: { ...deployment.settings, dmTimestampGapMs: 1000 },
      })
      .unwrap();
    f.advance(1000);
    expect(
      f.rewind(input.turnId!).match({ ok: () => undefined, err: (error) => error.message }),
    ).toBe("The rewind window has expired.");
    f.store.close();
  });

  test("rejects unsettled turns, active runs, and uploading inputs", () => {
    const f = fixture();
    const input = f.send("prompt");
    expect(f.rewind(input.turnId!).isErr()).toBe(true);
    f.settle(input);
    f.store.setActiveRun(f.dm.id, 0, "running").unwrap();
    expect(f.rewind(input.turnId!).isErr()).toBe(true);
    f.store.setActiveRun(f.dm.id, 0).unwrap();
    const upload = f.store
      .reserveUpload("owner", {
        threadId: f.dm.id,
        filename: "image.png",
        mediaType: "image/png",
        size: 100,
      })
      .unwrap();
    f.send("upload", [upload.id]);
    expect(
      f.rewind(input.turnId!).match({ ok: () => undefined, err: (error) => error.message }),
    ).toBe("Wait for active and queued messages to finish.");
    f.store.close();
  });

  test("delivered posts block rewind and stale pre-delivery requests cannot discard them", () => {
    const f = fixture();
    const input = f.send("prompt");
    f.settle(input);
    const request = f.request(input.turnId!);
    f.store
      .postMessage("owner", f.dm.id, {
        id: "heartbeat",
        role: "assistant",
        parts: [{ type: "text", text: "Delivered post" }],
      })
      .unwrap();
    expect(
      f.store
        .beginRewind("owner", request)
        .match({ ok: () => undefined, err: (error) => error.message }),
    ).toBe("Thread changed before rewind");
    expect(f.rewind(input.turnId!).isErr()).toBe(true);
    const next = f.send("after_post");
    f.settle(next);
    const reply = f.rewind(next.turnId!).unwrap();
    f.store.finishMutation(f.dm.id, reply.historyGeneration!).unwrap();
    expect(f.rewind(input.turnId!).isErr()).toBe(true);
    f.store.close();
  });

  test.each([false, true])(
    "pending outside sends survive a rejected rewind, settled=%s",
    (settled) => {
      const f = fixture();
      const input = f.send("prompt");
      f.settle(input);
      f.store
        .queueSurfaceSend(
          "owner",
          f.dm.id,
          "outside_request",
          {
            id: "outside_post",
            role: "assistant",
            parts: [{ type: "text", text: "queued reminder" }],
          },
          false,
        )
        .unwrap();
      if (settled) f.store.settleSurfaceSends("outside_request").unwrap();
      expect(f.rewind(input.turnId!).isErr()).toBe(true);
      expect(f.store.getThreadRecord(f.dm.id).unwrap().historyGeneration).toBe(0);
      if (!settled) f.store.settleSurfaceSends("outside_request").unwrap();
      expect(f.store.deliverSurfaceSends(f.dm.id).unwrap().requestIds).toEqual(["outside_request"]);
      expect(f.rewind(input.turnId!).isErr()).toBe(true);
      f.store.close();
    },
  );

  test("outside input inside the selected turn blocks rewind", () => {
    const f = fixture();
    const input = f.send("prompt");
    f.settle(input);
    f.store
      .appendMessage(f.dm.id, 0, input.turnId!, {
        id: "outside",
        role: "user",
        metadata: { inputId: "outside_input", inputMode: "steer", authorId: "lilac" },
        parts: [],
      })
      .unwrap();
    expect(
      f.rewind(input.turnId!).match({ ok: () => undefined, err: (error) => error.message }),
    ).toBe("Messages from outside this exchange prevent rewind.");
    f.store.close();
  });
});

test("a settled silent job wake does not block the latest visible exchange", () => {
  const f = fixture();
  const prompt = f.send("prompt");
  f.settle(prompt);
  const wake = f.send("job-wake:silent");
  f.settle(wake);
  expect(f.rewind(prompt.turnId!).isOk()).toBe(true);
});
