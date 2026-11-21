import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { NativeStore } from "./store";

for (const count of [1_000, 10_000, 100_000]) {
  test(`DM recent-history reads stay bounded at ${count} retained turns`, () => {
    const db = new Database(":memory:");
    const store = new NativeStore(db, () => count + 1);
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
    const dm = store.ensureDirectThread("owner").unwrap();
    const ordinary = store.createThread("owner", { commandId: "ordinary" }).unwrap();
    const times: Record<
      string,
      {
        selectionP95: number;
        windowP95: number;
        cancelMs: number;
        submitMs: number;
        receiptsMs: number;
        bytes: number;
      }
    > = {};
    for (const thread of [dm, ordinary]) {
      const receipt = store
        .acceptInput("owner", {
          threadId: thread.id,
          commandId: `seed-${thread.id}`,
          historyGeneration: 0,
          text: "seed",
          mode: "prompt",
          attachmentIds: [],
          skillIds: [],
        })
        .unwrap();
      const input = store.getInput(receipt.inputId).unwrap();
      const window = store.sync("owner", thread.id).unwrap();
      if (window.kind !== "window" || window.slots[0]?.kind !== "ready")
        throw new Error("Missing seed turn");
      const turn = window.slots[0];
      const write = db.query(
        "INSERT OR REPLACE INTO native_records(kind,id,thread_id,position,format_version,data_json,updated_at) VALUES(?,?,?,?,1,?,?)",
      );
      db.transaction(() => {
        db.query("DELETE FROM native_records WHERE thread_id=? AND kind IN ('input','turn')").run(
          thread.id,
        );
        for (let i = 0; i < count; i++) {
          const turnId = `${thread.id}-turn-${i}`;
          const inputId = `${thread.id}-input-${i}`;
          const completedAt = i < count - 10 ? i : i + 1;
          write.run(
            "input",
            inputId,
            thread.id,
            i,
            JSON.stringify({
              kind: "input",
              value: {
                ...input,
                id: inputId,
                turnId,
                requestId: `${thread.id}-request-${i}`,
                position: i,
                createdAt: i,
                completedAt,
                state: "admitted",
              },
            }),
            i,
          );
          write.run(
            "turn",
            turnId,
            thread.id,
            i,
            JSON.stringify({
              kind: "turn",
              value: {
                ...turn,
                slotId: turnId,
                turnId,
                position: i,
                messages: turn.messages.map((message) => ({
                  ...message,
                  metadata: { ...message.metadata, createdAt: i },
                })),
                state: "complete",
              },
            }),
            i,
          );
        }
      })();
      const selection: number[] = [];
      const sessionSelection: number[] = [];
      const windows: number[] = [];
      let bytes = 0;
      for (let run = 0; run < 21; run++) {
        const start = performance.now();
        expect(store.selectCanonicalInput(thread.id, { since: count - 3 }).unwrap()?.position).toBe(
          count - 3,
        );
        selection.push(performance.now() - start);
        if (thread.kind === "dm") {
          const sessionStart = performance.now();
          expect(
            store.selectSessionStartInput(thread.id, { gapMs: 0, at: count - 1 }).unwrap()
              ?.position,
          ).toBe(count - 10);
          sessionSelection.push(performance.now() - sessionStart);
        }
        const opened = performance.now();
        const reply = store.sync("owner", thread.id).unwrap();
        windows.push(performance.now() - opened);
        if (reply.kind !== "window") throw new Error("Expected recent window");
        expect(reply.slots).toHaveLength(6);
        expect(reply.slots[0]?.kind).toBe("deferred");
        bytes = new TextEncoder().encode(JSON.stringify(reply)).length;
        expect(bytes).toBeLessThan(16_000);
      }
      if (thread.kind === "dm") {
        expect(sessionSelection.slice(1).sort((a, b) => a - b)[18]!).toBeLessThan(50);
        const outlineStart = performance.now();
        expect(
          store.outline("owner", thread.id, { dmContextGapMs: 0 }).unwrap().positions,
        ).toHaveLength(256);
        expect(performance.now() - outlineStart).toBeLessThan(200);
      }
      const sent = performance.now();
      const pending = store
        .acceptInput("owner", {
          threadId: thread.id,
          commandId: `stop-${thread.id}`,
          historyGeneration: 0,
          text: "pending",
          mode: "prompt",
          attachmentIds: [],
          skillIds: [],
        })
        .unwrap();
      const submitMs = performance.now() - sent;
      const receiptStart = performance.now();
      expect(
        store.listInputReceipts("owner", thread.id, { afterRevision: 0 }).unwrap(),
      ).toHaveLength(1);
      const receiptsMs = performance.now() - receiptStart;
      const stopped = performance.now();
      store.cancelRun("owner", thread.id).unwrap();
      const cancelMs = performance.now() - stopped;
      expect(store.getInput(pending.inputId).unwrap().state).toBe("canceled");
      expect(store.selectCanonicalInput(thread.id, { since: count - 3 }).unwrap()?.position).toBe(
        count - 3,
      );
      times[thread.kind ?? "ordinary"] = {
        selectionP95: selection.slice(1).sort((a, b) => a - b)[18]!,
        windowP95: windows.slice(1).sort((a, b) => a - b)[18]!,
        bytes,
        cancelMs,
        submitMs,
        receiptsMs,
      };
    }
    console.info(JSON.stringify({ retainedTurns: count, ...times }));
    store.close();
  }, 30_000);
}
