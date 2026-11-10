import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { replayReplySchema, turnPageSchema } from "@stanley2058/lilac-client-protocol";
import { NativeThreadStore } from "../../../../../packages/client/src/thread-store";
import type { NativeInput, ReadyTurnSlot, TurnPage } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "./store";

function fixture() {
  const store = new NativeStore(new Database(":memory:"));
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  const thread = store.createThread("owner", { commandId: "create" }).unwrap();
  function submit(
    commandId: string,
    mode: NativeInput["mode"] = "prompt",
    attachmentIds: string[] = [],
    text = commandId,
  ) {
    return store
      .acceptInput("owner", {
        threadId: thread.id,
        historyGeneration: 0,
        commandId,
        text,
        mode,
        attachmentIds,
        skillIds: [],
      })
      .unwrap();
  }
  function start(inputId: string) {
    const input = store.prepareInput(inputId).unwrap();
    expect(input).not.toBeNull();
    if (!input) throw new Error("Input is not ready");
    store.settleInput(inputId, "admitted").unwrap();
    store.setActiveRun(thread.id, 0, input.requestId).unwrap();
    return input;
  }
  function turns(): ReadyTurnSlot[] {
    const reply = store.sync("owner", thread.id).unwrap();
    if (reply.kind !== "window") throw new Error("Expected initial window");
    return reply.slots.filter((slot): slot is ReadyTurnSlot => slot.kind === "ready");
  }
  return { store, thread, submit, start, turns };
}

describe("native store adversarial regressions", () => {
  for (const oversized of [false, true]) {
    test(
      oversized
        ? "oversized structured parts page and reconstruct without cursor loops"
        : "129 tiny parts produce schema-valid replay and hydrate every part",
      () => {
        const { store, thread, submit } = fixture();
        const receipt = submit("paging");
        const parts = oversized
          ? [
              {
                type: "data-activity" as const,
                id: "tool",
                data: {
                  kind: "tool" as const,
                  label: "tool",
                  state: "complete" as const,
                  detail: "\u0001".repeat(65_536),
                  output: "漢".repeat(65_536),
                },
              },
            ]
          : Array.from({ length: 129 }, () => ({ type: "text" as const, text: "x" }));
        store
          .appendMessage(thread.id, 0, receipt.turnId!, {
            id: "assistant",
            role: "assistant",
            parts,
          })
          .unwrap();
        const reply = store.sync("owner", thread.id).unwrap();
        expect(replayReplySchema.safeParse(reply).success).toBe(true);
        const client = new NativeThreadStore();
        client.replay(reply);
        const visited = new Set<string>();
        for (let n = 0; n < 100; n++) {
          const slot = client.get(receipt.turnId!);
          if (slot?.kind !== "ready") throw new Error("missing turn");
          if (!slot.partsCursor) {
            expect(slot.messages.find((message) => message.id === "assistant")?.parts).toEqual(
              parts,
            );
            store.close();
            return;
          }
          const cursor = slot.partsCursor;
          expect(visited.has(cursor)).toBe(false);
          if (visited.has(cursor)) throw new Error("cursor did not advance");
          visited.add(cursor);
          const page = store
            .turnPage("owner", {
              threadId: thread.id,
              turnId: receipt.turnId!,
              historyGeneration: 0,
              projectionRevision: reply.checkpoint.projectionRevision,
              cursor,
            })
            .unwrap();
          expect(turnPageSchema.safeParse(page).success).toBe(true);
          expect(client.turnPage(receipt.turnId!, cursor, page)).toBe("applied");
        }
        throw new Error("paging exceeded bound");
      },
    );
  }

  test("canceling a started follow-up drops the queue inherited from its previous run", () => {
    const { store, thread, submit, start } = fixture();
    const first = submit("first");
    start(first.inputId);
    const second = submit("second", "followup");
    const third = submit("third", "followup");
    store.markInputCompleted(first.inputId).unwrap();
    store.setActiveRun(thread.id, 0).unwrap();
    const active = start(second.inputId);

    store.cancelRun("owner", thread.id, active.requestId).unwrap();

    expect(store.getInput(third.inputId).unwrap().state).toBe("canceled");
    expect(store.prepareInput(third.inputId).unwrap()).toBeNull();
    expect(store.listQueuedInputs("owner", thread.id).unwrap()).toEqual([]);
    store.close();
  });

  test("maximum Unicode input pages advance and preserve every character", () => {
    const { store, thread, submit } = fixture();
    const text = "漢".repeat(65_536);
    const receipt = submit("unicode", "prompt", [], text);
    if (!receipt.turnId) throw new Error("Prompt has no turn");
    const checkpoint = store.sync("owner", thread.id).unwrap().checkpoint;
    let cursor: string | undefined = "p_0_0";
    let reconstructed = "";
    const visited = new Set<string>();
    while (cursor) {
      expect(visited.has(cursor)).toBe(false);
      if (visited.has(cursor)) throw new Error("Pagination did not advance");
      visited.add(cursor);
      const page: TurnPage = store
        .turnPage("owner", {
          threadId: thread.id,
          turnId: receipt.turnId,
          historyGeneration: 0,
          projectionRevision: checkpoint.projectionRevision,
          cursor,
        })
        .unwrap();
      for (const chunk of page.chunks ?? []) {
        if (chunk.part.type === "text") reconstructed += chunk.part.text;
      }
      cursor = page.nextCursor;
    }
    expect(reconstructed).toBe(text);
    store.close();
  });

  test("a stale cancel cannot discard a newer prompt waiting for its upload", () => {
    const { store, thread, submit, start } = fixture();
    const first = submit("first");
    const oldRun = start(first.inputId);
    store.markInputCompleted(first.inputId).unwrap();
    store.setActiveRun(thread.id, 0).unwrap();
    const upload = store
      .reserveUpload("owner", {
        threadId: thread.id,
        filename: "pending.txt",
        mediaType: "text/plain",
        size: 5,
      })
      .unwrap();
    const next = submit("next", "prompt", [upload.id]);

    expect(store.cancelRun("owner", thread.id, oldRun.requestId).isErr()).toBe(true);

    expect(store.getInput(next.inputId).unwrap().state).toBe("uploading");
    expect(store.getUpload(upload.id).unwrap().state).toBe("pending");
    store.close();
  });

  test("a new prompt stays after an earlier uploading follow-up through admission and rewind", () => {
    const { store, thread, submit, start, turns } = fixture();
    const first = submit("A");
    start(first.inputId);
    const upload = store
      .reserveUpload("owner", {
        threadId: thread.id,
        filename: "pending.txt",
        mediaType: "text/plain",
        size: 5,
      })
      .unwrap();
    const second = submit("B", "followup", [upload.id]);
    store.markInputCompleted(first.inputId).unwrap();
    store.setActiveRun(thread.id, 0).unwrap();
    const third = submit("C");
    expect(third.turnId).toBeUndefined();
    expect(store.prepareInput(third.inputId).unwrap()).toBeNull();
    const claimed = store.claimUpload("owner", upload.id).unwrap();
    store
      .settleUpload(upload.id, {
        attempt: claimed.attempt,
        historyGeneration: 0,
        state: "ready",
        resourceUri: "resource://pending",
      })
      .unwrap();
    const secondRun = start(second.inputId);
    store.markInputCompleted(second.inputId).unwrap();
    store.setActiveRun(thread.id, 0).unwrap();
    start(third.inputId);
    store.markInputCompleted(third.inputId).unwrap();
    store.setActiveRun(thread.id, 0).unwrap();

    expect(turns().map((turn) => turn.messages[0]?.parts[0])).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "B" },
      { type: "text", text: "C" },
    ]);
    if (!secondRun.turnId) throw new Error("Started follow-up has no turn");
    const current = store.getThreadRecord(thread.id).unwrap();
    store
      .beginRewind("owner", {
        threadId: thread.id,
        commandId: "rewind",
        turnId: secondRun.turnId,
        historyGeneration: 0,
        revision: current.revision,
      })
      .unwrap();

    if (!first.turnId) throw new Error("First turn has no identity");
    expect(turns().map((turn) => turn.turnId)).toEqual([first.turnId]);
    expect(store.getInput(third.inputId).unwrap().state).toBe("canceled");
    expect(store.getLatestCanonicalRequestId(thread.id).unwrap()).toBe(
      store.getInput(first.inputId).unwrap().requestId,
    );
    store.close();
  });

  for (const state of ["canceled", "failed"] as const) {
    test(`an unadmitted ${state} prompt settles its turn and attachment in snapshots and replay`, () => {
      const { store, thread, submit, turns } = fixture();
      const upload = store
        .reserveUpload("owner", {
          threadId: thread.id,
          filename: "pending.txt",
          mediaType: "text/plain",
          size: 5,
        })
        .unwrap();
      const input = submit("pending", "prompt", [upload.id]);
      const checkpoint = store.sync("owner", thread.id).unwrap().checkpoint;

      if (state === "canceled") store.cancelRun("owner", thread.id).unwrap();
      if (state === "failed") store.settleInput(input.inputId, "failed").unwrap();

      const slot = turns().find((turn) => turn.turnId === input.turnId);
      expect(slot?.state).toBe(state);
      expect(slot?.settledAt).toBeNumber();
      const resource = slot?.messages
        .flatMap((message) => message.parts)
        .find((part) => part.type === "data-resource");
      expect(resource).toMatchObject({
        type: "data-resource",
        data: { resourceId: upload.id, state },
      });
      const replay = store.sync("owner", thread.id, checkpoint).unwrap();
      expect(replay.kind).toBe("delta");
      if (replay.kind !== "delta")
        throw new Error("Terminal input state did not replay incrementally");
      expect(
        replay.changes.some(
          (change) =>
            change.kind === "turn-state" &&
            change.turnId === input.turnId &&
            change.state === state,
        ),
      ).toBe(true);
      expect(
        replay.changes.some(
          (change) =>
            change.kind === "set-part" &&
            change.part.type === "data-resource" &&
            change.part.data.resourceId === upload.id &&
            change.part.data.state === state,
        ),
      ).toBe(true);
      expect(store.prepareInput(input.inputId).unwrap()).toBeNull();
      const next = submit("next");
      expect(store.prepareInput(next.inputId).unwrap()?.turnId).toBe(next.turnId);
      store.close();
    });
  }

  for (const state of ["ready", "failed"] as const) {
    test(`attachment ${state} state reaches the persisted timeline`, () => {
      const { store, thread, submit, turns } = fixture();
      const upload = store
        .reserveUpload("owner", {
          threadId: thread.id,
          filename: "example.txt",
          mediaType: "text/plain",
          size: 5,
        })
        .unwrap();
      submit("upload", "prompt", [upload.id]);
      const claimed = store.claimUpload("owner", upload.id).unwrap();

      store
        .settleUpload(upload.id, {
          attempt: claimed.attempt,
          historyGeneration: 0,
          state,
          resourceUri: state === "ready" ? "resource://example" : undefined,
        })
        .unwrap();

      const resource = turns()
        .flatMap((turn) => turn.messages.flatMap((message) => message.parts))
        .find((part) => part.type === "data-resource");
      expect(resource).toMatchObject({
        type: "data-resource",
        data: { resourceId: upload.id, state },
      });
      store.close();
    });
  }

  test("steering preserves attachment identity and upload state in its existing turn", () => {
    const { store, thread, submit, start, turns } = fixture();
    const initial = submit("initial");
    start(initial.inputId);
    const upload = store
      .reserveUpload("owner", {
        threadId: thread.id,
        filename: "steer.txt",
        mediaType: "text/plain",
        size: 5,
      })
      .unwrap();
    const steering = submit("steer", "steer", [upload.id]);

    expect(steering.turnId).toBe(initial.turnId);
    const message = turns()
      .flatMap((turn) => turn.messages)
      .find((entry) => entry.id === steering.messageId);
    expect(message?.parts).toContainEqual({
      type: "data-resource",
      id: upload.id,
      data: {
        resourceId: upload.id,
        name: "steer.txt",
        mediaType: "text/plain",
        size: 5,
        state: "pending",
      },
    });
    store.close();
  });

  for (const mode of ["steer", "followup"] as const) {
    test(`a ${mode} that arrives after its run ended starts a new turn as a prompt`, () => {
      const { store, thread, submit, start } = fixture();
      const first = submit("first");
      start(first.inputId);
      store.markInputCompleted(first.inputId).unwrap();
      store.setActiveRun(thread.id, 0).unwrap();

      const late = submit("late", mode);

      expect(store.getInput(late.inputId).unwrap().mode).toBe("prompt");
      expect(late.turnId).toBeDefined();
      expect(late.turnId).not.toBe(first.turnId);
      store.close();
    });
  }

  test("a prompt that arrives during a run queues as a follow-up", () => {
    const { store, thread, submit, start } = fixture();
    start(submit("first").inputId);

    const late = submit("late");

    expect(store.getInput(late.inputId).unwrap().mode).toBe("followup");
    expect(store.listQueuedInputs("owner", thread.id).unwrap()).toMatchObject([
      { inputId: late.inputId, mode: "followup" },
    ]);
    store.close();
  });
});
