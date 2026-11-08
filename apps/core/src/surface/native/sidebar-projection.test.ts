import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import type { ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "./store";
import { NativeSurfaceStore } from "./store-surface";

function fixture() {
  const db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  const surface = new NativeSurfaceStore(db, store);
  surface.initialize().unwrap();
  for (const [id, role] of [
    ["owner", "owner"],
    ["alice", "participant"],
  ] as const)
    store
      .upsertUser({ id, providerId: id, displayName: `${id} display`, role, toolMode: "full" })
      .unwrap();
  const thread = store.createThread("alice", { commandId: "create" }).unwrap();
  function turn(commandId: string, state: ReadyTurnSlot["state"] = "complete", startedAt?: number) {
    const receipt = store
      .acceptInput("alice", {
        threadId: thread.id,
        commandId,
        historyGeneration: store.getThreadRecord(thread.id).unwrap().historyGeneration,
        text: "Hello",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    store.settleInput(receipt.inputId, "admitted").unwrap();
    store.markInputCompleted(receipt.inputId).unwrap();
    store
      .projectTurn(thread.id, 0, commandId, receipt.turnId!, (slot) =>
        Result.ok({
          slot: {
            ...slot,
            state,
            startedAt,
            messages: [
              ...slot.messages,
              {
                id: `${commandId}-reply`,
                role: "assistant",
                parts: [{ type: "text", text: "Done" }],
              },
            ],
          },
          changes: [],
        }),
      )
      .unwrap();
    return receipt.turnId!;
  }
  return { db, store, surface, thread, turn };
}

describe("native sidebar display projection", () => {
  test("projects starter identity and each state using the actor's existing read frontier", () => {
    const f = fixture();
    expect(f.thread.starterDisplayName).toBe("alice display");
    expect(f.thread.displayStatus).toBe("idle");
    const first = f.turn("first");
    expect(f.store.getThread("owner", f.thread.id).unwrap().displayStatus).toBe("completed");
    f.surface.markTurnRead("alice", f.thread.id, first).unwrap();
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("idle");
    expect(f.store.getThread("owner", f.thread.id).unwrap().displayStatus).toBe("completed");
    f.store.setActiveRun(f.thread.id, 0, "active").unwrap();
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("working");
    f.store.setActiveRun(f.thread.id, 0).unwrap();
    f.turn("failed", "failed");
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("error");
    f.turn("canceled", "canceled");
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("idle");
    f.store.close();
  });

  test("projects the latest turn start while working", () => {
    const f = fixture();
    f.turn("first");
    expect(f.store.getThread("alice", f.thread.id).unwrap().workingSince).toBeUndefined();
    f.turn("running", "running", 1_000);
    const working = f.store.getThread("alice", f.thread.id).unwrap();
    expect(working.displayStatus).toBe("working");
    expect(working.workingSince).toBe(1_000);
    f.store.close();
  });

  test("a parked run is still working but tells viewers it is waiting", async () => {
    const f = fixture();
    f.turn("running", "running", 1_000);
    f.store.setActiveRun(f.thread.id, 0, "active").unwrap();
    const read = () => f.store.getThread("alice", f.thread.id).unwrap();
    expect(read().waitingOn).toBeUndefined();

    await Promise.resolve();
    const changes: string[] = [];
    const stop = f.store.subscribe((threadId) => changes.push(threadId));
    const revision = read().revision;
    f.store.setRunWaiting(f.thread.id, "active", true);
    await Promise.resolve();
    expect(changes).toEqual([f.thread.id]);
    expect(read()).toMatchObject({ displayStatus: "working", waitingOn: "other", revision });
    expect(read().workingSince).toBe(1_000);

    f.store.setRunWaiting(f.thread.id, "active", true);
    await Promise.resolve();
    expect(changes).toEqual([f.thread.id]);

    f.store.setRunWaiting(f.thread.id, "active", false);
    expect(read().waitingOn).toBeUndefined();
    stop();
    f.store.close();
  });

  test("a wait reported by an earlier run does not touch the next run", () => {
    const f = fixture();
    f.turn("running", "running", 1_000);
    f.store.setActiveRun(f.thread.id, 0, "first").unwrap();
    f.store.setRunWaiting(f.thread.id, "first", true);
    f.store.setActiveRun(f.thread.id, 0, "second").unwrap();
    expect(f.store.getThread("alice", f.thread.id).unwrap().waitingOn).toBeUndefined();
    f.store.setRunWaiting(f.thread.id, "second", true);
    f.store.setRunWaiting(f.thread.id, "first", false);
    expect(f.store.getThread("alice", f.thread.id).unwrap().waitingOn).toBe("other");
    f.store.close();
  });

  test("reading updates catalogs without changing replay, and cannot move the same-generation frontier backwards", async () => {
    const f = fixture();
    const first = f.turn("first");
    const last = f.turn("last");
    await Promise.resolve();
    const changes: string[] = [];
    const stop = f.store.subscribe((threadId) => changes.push(threadId));
    const before = f.store.getThreadRecord(f.thread.id).unwrap();
    f.surface.markTurnRead("alice", f.thread.id, last).unwrap();
    await Promise.resolve();
    expect(changes).toEqual([f.thread.id]);
    expect(f.store.getThreadRecord(f.thread.id).unwrap()).toEqual(before);
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("idle");
    f.surface.markTurnRead("alice", f.thread.id, first).unwrap();
    await Promise.resolve();
    expect(changes).toEqual([f.thread.id]);
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("idle");
    stop();
    f.store.close();
  });

  test("an old-generation read cursor cannot hide a newly completed turn", () => {
    const f = fixture();
    const first = f.turn("first");
    f.surface.markTurnRead("alice", f.thread.id, first).unwrap();
    f.db
      .query("UPDATE native_surface_read SET generation=? WHERE thread_id=?")
      .run(10, f.thread.id);
    expect(f.store.getThread("alice", f.thread.id).unwrap().displayStatus).toBe("completed");
    f.store.close();
  });
});
